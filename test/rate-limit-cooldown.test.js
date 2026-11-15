/**
 * 限流与错误冷却熔断 + 重试/探活节省额度测试：
 *   1. parseRetryAfterMs / classifyUpstreamError：429 / Retry-After / FreeUsageLimitError 等归类与回退；
 *   2. ModelCooldownTracker：硬限流即时熔断、连续 5xx 阈值熔断、成功清除、hasRecentRateLimit；
 *   3. ZenClient：遇到 429 零重试立即失败并带 retryAfterSeconds；5xx 最多重试 2 次（RETRIES=2，而非旧版 7 次）；
 *   4. Bridge + HTTP Server：命中 429 / 连续 5xx 后本地熔断拦截不再打上游，HTTP 透传 429/503 + Retry-After 头；
 *   5. Bridge 自动重测默认间隔 30 分钟；冷却模型和近期全局限流下跳过后台重测与 onlyFailed 探活，单条主动 probeOne 成功可清冷却。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_BLOCKED_COOLDOWN_MS,
  DEFAULT_RATE_LIMIT_COOLDOWN_MS,
  ModelCooldownTracker,
  classifyUpstreamError,
  parseRetryAfterMs,
} from '../src/cooldown.js';
import { ZenClient } from '../src/zen-client.js';
import { OcClient } from '../src/oc-client.js';
import { Bridge } from '../src/main.js';
import { createServer } from '../src/server.js';
import { ensureLayout } from '../src/settings.js';

function isolateDataDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'oc-cooldown-'));
  const prev = process.env.OCF_DATA_DIR;
  process.env.OCF_DATA_DIR = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.OCF_DATA_DIR;
    else process.env.OCF_DATA_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const DEMO_MODEL = {
  id: 'opencode/demo-free',
  providerID: 'opencode',
  modelID: 'demo-free',
  name: 'Demo Free',
  free: true,
  reasoning: false,
  images: false,
  contextWindow: 200_000,
};

test('classifyUpstreamError & parseRetryAfterMs：精确区分限流、封禁、临时波动与本地中文提示', () => {
  assert.equal(parseRetryAfterMs({ 'retry-after': '90' }), 90_000);
  assert.equal(parseRetryAfterMs(new Headers({ 'Retry-After': '3' })), 5_000); // 下限夹紧 5s
  const dateMs = parseRetryAfterMs({ 'Retry-After': new Date(1_000_000 + 45_000).toUTCString() }, 1_000_000);
  assert.ok(dateMs >= 44_000 && dateMs <= 46_000);

  const r1 = classifyUpstreamError({
    status: 429,
    code: 'zen_rate_limited',
    message: 'FreeUsageLimitError: daily limit exceeded',
    headers: { 'retry-after': '180' },
  });
  assert.equal(r1.kind, 'rate_limit');
  assert.equal(r1.retryAfterMs, 180_000);

  const r2 = classifyUpstreamError({ status: 200, message: 'QuotaExceededError: too many requests' });
  assert.equal(r2.kind, 'rate_limit');
  assert.equal(r2.retryAfterMs, DEFAULT_RATE_LIMIT_COOLDOWN_MS);

  const r3 = classifyUpstreamError({ status: 403, message: 'not available in your country' });
  assert.equal(r3.kind, 'model_blocked');
  assert.equal(r3.retryAfterMs, DEFAULT_BLOCKED_COOLDOWN_MS);

  // 回归保障：非 429 的中文模拟错不应被误归为 429 限流
  const r4 = classifyUpstreamError({ status: 502, code: 'upstream_error', message: 'ProviderError: 上游额度用完了' });
  assert.equal(r4.kind, 'transient');
});

test('ModelCooldownTracker：限流立即冷却、临时错误 3 次后熔断、成功即恢复', () => {
  const tracker = new ModelCooldownTracker({
    rateLimitCooldownMs: 60_000,
    transientCooldownMs: 30_000,
    transientThreshold: 3,
  });

  // 前 2 次 502 不触发熔断
  assert.equal(tracker.recordError('m1', { status: 502, message: 'bad gateway' }, 1000).tripped, false);
  assert.equal(tracker.get('m1', 1500), null);
  assert.equal(tracker.recordError('m1', { status: 502, message: 'bad gateway' }, 2000).tripped, false);
  assert.equal(tracker.get('m1', 2500), null);

  // 第 3 次 502 触发 30s 冷却，未记录全局限流
  const third = tracker.recordError('m1', { status: 502, message: 'bad gateway' }, 3000);
  assert.equal(third.tripped, true);
  assert.equal(third.kind, 'transient');
  assert.ok(tracker.get('m1', 4000));
  assert.equal(tracker.hasRecentRateLimit(4000), false);

  // 显式成功清除冷却
  tracker.recordSuccess('m1');
  assert.equal(tracker.get('m1', 4000), null);

  // 429 限流首轮即触发冷却，并置位 hasRecentRateLimit
  const rate = tracker.recordError('m2', { status: 429, message: 'rate limit', headers: { 'retry-after': '120' } }, 5000);
  assert.equal(rate.tripped, true);
  assert.equal(rate.kind, 'rate_limit');
  assert.equal(rate.until, 5000 + 120_000);
  assert.equal(tracker.hasRecentRateLimit(10_000), true);
});

test('ZenClient 重试收敛：429 零重试直接报 zen_rate_limited；5xx 最多试 3 次（1+2）', async (t) => {
  let scenario = '429';
  let hits = 0;

  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/modelsdev') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        opencode: {
          models: {
            'mini-chat-free': { name: 'Mini', cost: { input: 0, output: 0 }, limit: { context: 32000, output: 4096 } },
          },
        },
      }));
      return;
    }
    if (path === '/inference/openai/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mini-chat-free' }] }));
      return;
    }
    if (path === '/inference/openai/v1/chat/completions') {
      hits += 1;
      if (scenario === '429') {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '75' });
        res.end(JSON.stringify({ error: { type: 'FreeUsageLimitError', message: 'Daily limit reached' } }));
        return;
      }
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Service temporarily unavailable' } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections?.();
    return new Promise((resolve) => server.close(resolve));
  });
  const port = server.address().port;

  const client = new ZenClient({
    baseUrl: `http://127.0.0.1:${port}`,
    modelsDevUrl: `http://127.0.0.1:${port}/modelsdev`,
  });
  t.after(() => client.stop());
  await client.start();

  // 429 不重试：总计仅发 1 次上游请求
  hits = 0;
  scenario = '429';
  await assert.rejects(
    () => client.prompt({ sessionID: 'ses_rate', providerID: 'opencode', modelID: 'mini-chat-free', text: 'hi' }),
    (err) => err.status === 429 && err.code === 'zen_rate_limited' && err.retryAfterSeconds === 75,
  );
  assert.equal(hits, 1, '命中 429 应立即失败，不能再重试');

  // 503 重试上限 RETRIES=2：1 次初试 + 2 次重试 = 3 次请求（而非旧版 8 次）
  hits = 0;
  scenario = '503';
  await assert.rejects(
    () => client.prompt({ sessionID: 'ses_503', providerID: 'opencode', modelID: 'mini-chat-free', text: 'hi' }),
    (err) => err.status >= 500,
  );
  assert.equal(hits, 3, '5xx 应封顶 1 + 2 = 3 次尝试');
});

test('Bridge 冷却熔断 + server.js HTTP 响应：429 与连续 5xx 本地熔断，HTTP 带 Retry-After', async (t) => {
  isolateDataDir(t);

  let promptCalls = 0;
  let errorToThrow = null;
  const bridge = new Bridge({ log: () => {}, targets: [] });
  bridge.state.mode = 'embedded';
  bridge.state.models = [DEMO_MODEL];
  bridge.state.verdicts.set(DEMO_MODEL.id, { verdict: 'tool', note: '' });
  bridge.client = {
    isolate: true,
    ready: true,
    providers: async () => [],
    createSession: async () => 'ses_cool',
    deleteSession: async () => {},
    prompt: async () => {
      promptCalls += 1;
      if (errorToThrow) throw errorToThrow;
      return { text: '{"content":"ok","calls":[]}', tokens: null, handoff: null };
    },
    stop: async () => {},
  };

  // 第 1 次上游 429 -> 快照立即进入冷却
  errorToThrow = Object.assign(new Error('Daily free usage limit reached'), {
    status: 429,
    code: 'upstream_rate_limited',
    retryAfterSeconds: 180,
  });
  await assert.rejects(
    () => bridge.complete({ protocol: 'anthropic', body: { model: DEMO_MODEL.id, messages: [{ role: 'user', content: 'hi' }] } }),
    (err) => err.status === 429,
  );
  assert.equal(promptCalls, 1);

  const viewModel = bridge.snapshot().models.find((m) => m.id === DEMO_MODEL.id);
  assert.ok(viewModel.cooldownUntil > Date.now(), '快照模型应带 cooldownUntil');
  assert.match(viewModel.cooldownReason, /Daily free usage limit/);

  // 第 2 次通过 createServer 发 HTTP 请求 -> 本地立即熔断（promptCalls 仍为 1），返回 429 + Retry-After
  const fakeProto = {
    prepareAnthropic: (body) => ({
      model: { id: body.model, providerID: 'opencode', modelID: body.model, name: body.model },
      text: 'hi',
      system: '',
      history: [{ role: 'user', text: 'hi' }],
      images: [],
      tools: [],
      choice: 'auto',
      forced: null,
      parallel: true,
      stream: false,
      maxTokens: 1024,
    }),
    prepareOpenAI: () => { throw new Error('unused'); },
    prepareResponses: () => { throw new Error('unused'); },
    toAnthropicResponse: () => ({}),
    toOpenAIResponse: () => ({}),
    toResponsesResponse: () => ({}),
    sendAnthropicSSE: () => {},
    sendOpenAISSE: () => {},
    sendResponsesSSE: () => {},
    tokenUsage: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }),
  };

  const srv = createServer({ apiKey: 'test-key', log: () => {}, bridge, protocol: fakeProto });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    srv.closeAllConnections?.();
    return new Promise((resolve) => srv.close(resolve));
  });
  const port = srv.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: DEMO_MODEL.id, max_tokens: 100, messages: [{ role: 'user', content: 'again' }] }),
  });
  assert.equal(res.status, 429);
  const retryAfter = Number(res.headers.get('retry-after'));
  assert.ok(Number.isInteger(retryAfter) && retryAfter > 0, '429 响应必须带 Retry-After 头');
  assert.equal(promptCalls, 1, '处于冷却期的请求必须在本地拦截，绝不再打上游');

  // 新建 Bridge 验证连续 3 次 502 后触发 503 熔断，第 4 次不再打上游
  const transientBridge = new Bridge({ log: () => {}, targets: [] });
  let tCalls = 0;
  transientBridge.state.mode = 'embedded';
  transientBridge.state.models = [DEMO_MODEL];
  transientBridge.state.verdicts.set(DEMO_MODEL.id, { verdict: 'tool', note: '' });
  transientBridge.client = {
    isolate: true,
    ready: true,
    providers: async () => [],
    createSession: async () => 'ses_502',
    deleteSession: async () => {},
    prompt: async () => {
      tCalls += 1;
      throw Object.assign(new Error('bad gateway'), { status: 502, code: 'upstream_error' });
    },
    stop: async () => {},
  };
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(
      () => transientBridge.complete({ protocol: 'anthropic', body: { model: DEMO_MODEL.id, messages: [{ role: 'user', content: `q${i}` }] } }),
      (err) => err.status === 502,
    );
  }
  assert.equal(tCalls, 3);
  await assert.rejects(
    () => transientBridge.complete({ protocol: 'anthropic', body: { model: DEMO_MODEL.id, messages: [{ role: 'user', content: 'q4' }] } }),
    (err) => err.status === 503 && err.code === 'model_cooldown' && err.retryAfterSeconds > 0,
  );
  assert.equal(tCalls, 3, '连续 3 次 502 后第 4 次应在本地熔断返回 503');
});

test('Bridge 自动重测默认值（30m）、onlyFailed 跳过冷却模型与主动 probeOne 成功清除冷却', async (t) => {
  isolateDataDir(t);
  await ensureLayout();

  const defaultBridge = new Bridge({ log: () => {}, targets: [] });
  assert.equal(defaultBridge.autoRetryIntervalMs, 30 * 60 * 1000);

  let probeCalls = 0;
  let shouldRateLimit = true;
  const secondModel = { ...DEMO_MODEL, id: 'opencode/second-free', modelID: 'second-free', name: 'Second' };
  const bridge = new Bridge({ log: () => {}, targets: [] });
  bridge.state.mode = 'embedded';
  bridge.state.models = [DEMO_MODEL, secondModel];
  bridge.state.verdicts.set(DEMO_MODEL.id, { verdict: 'tool', note: '' });
  bridge.state.verdicts.set(secondModel.id, { verdict: 'failed', note: '临时失败' });
  bridge.client = {
    isolate: true,
    ready: true,
    providers: async () => [],
    createSession: async () => 'ses_probe',
    deleteSession: async () => {},
    prompt: async () => {
      probeCalls += 1;
      if (shouldRateLimit) {
        throw Object.assign(new Error('rate_limit_exceeded'), { status: 429, code: 'upstream_rate_limited', retryAfterSeconds: 600 });
      }
      return { text: '{"content":"pong","calls":[]}', tokens: null, handoff: null };
    },
    stop: async () => {},
  };

  // 第 1 次请求触发 DEMO_MODEL 冷却，随后把其状态设为 failed
  await assert.rejects(
    () => bridge.complete({ protocol: 'anthropic', body: { model: DEMO_MODEL.id, messages: [{ role: 'user', content: 'x' }] } }),
    (err) => err.status === 429,
  );
  bridge.state.verdicts.set(DEMO_MODEL.id, { verdict: 'failed', note: '限流' });
  probeCalls = 0;

  // onlyFailed 探活自动跳过处于冷却期中的 DEMO_MODEL（只重测没在冷却的 secondModel）
  shouldRateLimit = false;
  await bridge.probe({ onlyFailed: true, force: true });
  // DEMO_MODEL 冷却中被跳过；secondModel 没冷却被探活一次
  assert.ok(probeCalls >= 1 && probeCalls <= 2, `DEMO_MODEL 应被跳过不探活，actual probeCalls=${probeCalls}`);
  assert.ok(bridge.snapshot().models.find((m) => m.id === DEMO_MODEL.id).cooldownUntil > Date.now());

  // 主动单条重测 probeOne 允许强制测试冷却中模型，成功后清除其冷却状态
  const single = await bridge.probeOne(DEMO_MODEL.id);
  assert.equal(single.verdict === 'tool' || single.verdict === 'chat', true);
  assert.equal(bridge.snapshot().models.find((m) => m.id === DEMO_MODEL.id).cooldownUntil, null);
});

test('OcClient._parsePromptResponse + Bridge：保留上游真实 retryAfterMs（如 30071000ms），不被截断成 2h 或 15m', async (t) => {
  isolateDataDir(t);
  const rootDir = mkdtempSync(join(tmpdir(), 'oc-rlafter-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const oc = new OcClient({ dataDir: rootDir });
  let capturedErr = null;
  try {
    await oc._parsePromptResponse(
      {
        ok: true,
        status: 200,
        text: '',
        json: {
          info: {
            role: 'assistant',
            error: {
              type: 'provider.free-limit',
              message: 'Free usage limit exceeded',
              response: { body: '{"error":{"type":"FreeUsageLimitError","message":"Free usage limit exceeded","retryAfterMs":30071000}}' },
              retryAfterMs: 30071000,
            },
          },
          parts: [],
        },
      },
      'ses_rlafter',
    );
  } catch (err) {
    capturedErr = err;
  }

  assert.ok(capturedErr, '应当抛出限流 BridgeError');
  assert.equal(capturedErr.status, 429);
  assert.equal(capturedErr.code, 'upstream_rate_limited');
  assert.equal(capturedErr.retryAfterMs, 30_071_000);
  assert.equal(capturedErr.retryAfterSeconds, 30_071);

  const bridge = new Bridge({ log: () => {}, targets: [] });
  bridge.state.mode = 'embedded';
  bridge.state.models = [DEMO_MODEL];
  bridge.state.verdicts.set(DEMO_MODEL.id, { verdict: 'tool', note: '' });
  let promptCalls = 0;
  bridge.client = {
    isolate: true,
    ready: true,
    providers: async () => [],
    createSession: async () => 'ses_cooldown_long',
    deleteSession: async () => {},
    prompt: async () => {
      promptCalls += 1;
      throw capturedErr;
    },
    stop: async () => {},
  };

  await assert.rejects(
    () => bridge.complete({ protocol: 'anthropic', body: { model: DEMO_MODEL.id, messages: [{ role: 'user', content: 'hi' }] } }),
    (err) => err.status === 429 && err.retryAfterSeconds === 30_071,
  );

  // 第二次请求本地冷却应保持 ~8.35h 窗口并直接 429 拦截
  await assert.rejects(
    () => bridge.complete({ protocol: 'anthropic', body: { model: DEMO_MODEL.id, messages: [{ role: 'user', content: 'hi2' }] } }),
    (err) => err.status === 429 && err.code === 'model_rate_limit_cooldown' && err.retryAfterSeconds > 30_000 && /小时/.test(err.message),
  );
  assert.equal(promptCalls, 1, '命中本地长冷却后不该再次请求上游');
});
