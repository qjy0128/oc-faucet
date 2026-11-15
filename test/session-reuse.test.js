/**
 * 会话复用与增量/多轮消息构造测试：
 *   1. ConversationSessionPool 增量延续、压缩/编辑轮换、handoff 脏标记淘汰、LRU/TTL 清理、stateless KV 亲和；
 *   2. Bridge.complete() 对接有状态假 OcClient：首轮全量建会话 -> 续轮增量 delta（不重发前缀）-> 压缩轮换 -> handoff 轮换 -> 404 session_not_found 自动建新重放；
 *   3. OcClient._promptV2：isContinuation 为 true 时跳过重复注入 body.system；
 *   4. ZenClient 伪装模式端到端：多轮保持相同 ses_ x-opencode-session / x-session-affinity，且发结构化多轮数组（不扁平退化），前缀逐轮一致命中 KV 缓存。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ConversationSessionPool,
  computeConversationHashes,
  extractSessionHint,
} from '../src/session-pool.js';
import { OcClient } from '../src/oc-client.js';
import { ZenClient } from '../src/zen-client.js';
import { Bridge } from '../src/main.js';

function isolateDataDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'oc-session-reuse-'));
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

const READ_TOOL = {
  name: 'Read',
  description: '读取文件',
  input_schema: {
    type: 'object',
    properties: { file_path: { type: 'string' } },
    required: ['file_path'],
  },
};

test('ConversationSessionPool：支持有状态增量延续、压缩轮换、handoff 淘汰、stateless 复用与串行锁', async () => {
  const pool = new ConversationSessionPool({ maxEntries: 2, idleTtlMs: 1000 });
  const h1 = computeConversationHashes('SYS_A', [{ role: 'user', text: 'hi' }]);
  const key = pool.makeKey({
    clientToken: 'tok1',
    modelId: 'opencode/demo',
    systemHash: h1.systemHash,
    firstItemHash: h1.cumulativeHashes[0],
    explicitHint: null,
  });
  const otherKey = pool.makeKey({
    clientToken: 'tok2',
    modelId: 'opencode/demo',
    systemHash: h1.systemHash,
    firstItemHash: h1.cumulativeHashes[0],
    explicitHint: null,
  });
  assert.notEqual(key, otherKey);

  // 首轮未命中 -> commit ses_1
  const a1 = pool.acquire(key, { stateful: true, ...h1, now: 100 });
  assert.equal(a1.reuseSessionID, null);
  pool.commit(key, { sessionID: 'ses_1', stateful: true, ...h1, now: 100 });

  // 续轮同前缀扩展 -> 复用 ses_1，增量起点为 1
  const h2 = computeConversationHashes('SYS_A', [
    { role: 'user', text: 'hi' },
    { role: 'assistant', text: 'hello' },
    { role: 'user', text: 'next' },
  ]);
  const a2 = pool.acquire(key, { stateful: true, ...h2, now: 200 });
  assert.equal(a2.reuseSessionID, 'ses_1');
  assert.equal(a2.sendDeltaFromIndex, 1);
  pool.commit(key, { sessionID: 'ses_1', stateful: true, ...h2, now: 200 });

  // 压缩/改写第 0 条 -> 退役 ses_1，回到全量新建
  const hCompact = computeConversationHashes('SYS_A', [{ role: 'user', text: 'summary' }]);
  const compactKey = pool.makeKey({
    clientToken: 'tok1',
    modelId: 'opencode/demo',
    systemHash: hCompact.systemHash,
    firstItemHash: hCompact.cumulativeHashes[0],
    explicitHint: 'thread-1',
  });
  pool.commit(compactKey, { sessionID: 'ses_sticky', stateful: true, ...h2, now: 210 });
  const a3 = pool.acquire(compactKey, { stateful: true, ...hCompact, now: 220 });
  assert.equal(a3.reuseSessionID, null);
  assert.deepEqual(a3.retiredSessionIDs, ['ses_sticky']);

  // handoff dirty 标记下轮强制轮换
  pool.commit(compactKey, { sessionID: 'ses_dirty', stateful: true, ...hCompact, dirty: true, now: 230 });
  const hAfterDirty = computeConversationHashes('SYS_A', [
    { role: 'user', text: 'summary' },
    { role: 'assistant', text: 'tool' },
    { role: 'user', text: 'continue' },
  ]);
  const a4 = pool.acquire(compactKey, { stateful: true, ...hAfterDirty, now: 240 });
  assert.equal(a4.reuseSessionID, null);
  assert.deepEqual(a4.retiredSessionIDs, ['ses_dirty']);

  // stateless 模式：沿用相同 sessionID，但 sendDeltaFromIndex 保持 null（发完整多轮结构）
  const sKey = 'stateless-k';
  pool.commit(sKey, { sessionID: 'ses_zen_1', stateful: false, ...h1, now: 300 });
  const s2 = pool.acquire(sKey, { stateful: false, ...h2, now: 350 });
  assert.equal(s2.reuseSessionID, 'ses_zen_1');
  assert.equal(s2.sendDeltaFromIndex, null);

  // LRU 超过 maxEntries (2) 会淘汰最旧有状态会话
  pool.commit('lru-a', { sessionID: 'ses_lru_a', stateful: true, ...h1, now: 360 });
  pool.commit('lru-b', { sessionID: 'ses_lru_b', stateful: true, ...h1, now: 370 });
  const evicted = pool.commit('lru-c', { sessionID: 'ses_lru_c', stateful: true, ...h1, now: 380 });
  assert.deepEqual(evicted, ['ses_lru_a'], 'LRU 溢出应返回待删有状态会话 ID');

  // extractSessionHint 提取头或请求体提示
  assert.equal(
    extractSessionHint({ headers: { 'X-Opencode-Session': 'ses_from_header' }, body: {} }),
    'ses_from_header',
  );
  assert.equal(
    extractSessionHint({ headers: {}, body: { metadata: { user_id: 'usr_conv_99' } } }),
    'usr_conv_99',
  );

  // withLock 对相同 key 严格串行
  const trace = [];
  await Promise.all([
    pool.withLock('lock-k', async () => {
      trace.push('1-start');
      await new Promise((r) => setTimeout(r, 15));
      trace.push('1-end');
    }),
    pool.withLock('lock-k', async () => {
      trace.push('2-start');
      trace.push('2-end');
    }),
  ]);
  assert.deepEqual(trace, ['1-start', '1-end', '2-start', '2-end']);
});

test('Bridge.complete（有状态 OcClient 语义）：会话复用增量发送、压缩轮换、handoff 轮换与 404 自动恢复', async (t) => {
  isolateDataDir(t);

  let seq = 0;
  const created = [];
  const deleted = [];
  const promptCalls = [];
  let behavior = async (options) => ({
    text: '{"content":"普通回复","calls":[]}',
    tokens: null,
    handoff: null,
  });

  const bridge = new Bridge({ log: () => {}, targets: [] });
  bridge.state.mode = 'embedded';
  bridge.state.models = [DEMO_MODEL];
  bridge.state.verdicts.set(DEMO_MODEL.id, { verdict: 'tool', note: '' });
  bridge.client = {
    isolate: true,
    ready: true,
    providers: async () => [],
    createSession: async () => {
      seq += 1;
      const sid = `ses_stateful_${seq}`;
      created.push(sid);
      return sid;
    },
    deleteSession: async (sid) => {
      deleted.push(sid);
    },
    prompt: async (options) => {
      promptCalls.push({
        sessionID: options.sessionID,
        isContinuation: Boolean(options.isContinuation),
        text: options.text,
      });
      return behavior(options);
    },
    stop: async () => {},
  };

  // 第 1 轮：全量新建 ses_stateful_1
  await bridge.complete({
    protocol: 'anthropic',
    headers: { 'x-session-id': 'thread-alpha' },
    body: {
      model: DEMO_MODEL.id,
      system: '你是一个助手',
      max_tokens: 1024,
      tools: [READ_TOOL],
      messages: [{ role: 'user', content: 'FIRST_TURN_UNIQUE_TOKEN' }],
    },
  });
  assert.deepEqual(created, ['ses_stateful_1']);
  assert.equal(promptCalls[0].sessionID, 'ses_stateful_1');
  assert.equal(promptCalls[0].isContinuation, false);
  assert.match(promptCalls[0].text, /FIRST_TURN_UNIQUE_TOKEN/);

  // 第 2 轮：前缀匹配 -> 复用 ses_stateful_1，仅发增量，不含第 1 轮词
  await bridge.complete({
    protocol: 'anthropic',
    headers: { 'x-session-id': 'thread-alpha' },
    body: {
      model: DEMO_MODEL.id,
      system: '你是一个助手',
      max_tokens: 1024,
      tools: [READ_TOOL],
      messages: [
        { role: 'user', content: 'FIRST_TURN_UNIQUE_TOKEN' },
        { role: 'assistant', content: '普通回复' },
        { role: 'user', content: 'SECOND_TURN_DELTA_ONLY' },
      ],
    },
  });
  assert.equal(created.length, 1, '续轮不应重复 createSession');
  assert.equal(deleted.length, 0, '续轮不应销毁原会话');
  assert.equal(promptCalls[1].sessionID, 'ses_stateful_1');
  assert.equal(promptCalls[1].isContinuation, true);
  assert.match(promptCalls[1].text, /SECOND_TURN_DELTA_ONLY/);
  assert.doesNotMatch(promptCalls[1].text, /FIRST_TURN_UNIQUE_TOKEN/);

  // 第 3 轮：历史被压缩/改写 -> 删掉旧 ses_stateful_1，新建 ses_stateful_2 全量发送
  await bridge.complete({
    protocol: 'anthropic',
    headers: { 'x-session-id': 'thread-alpha' },
    body: {
      model: DEMO_MODEL.id,
      system: '你是一个助手',
      max_tokens: 1024,
      tools: [READ_TOOL],
      messages: [{ role: 'user', content: 'COMPACTED_HISTORY_SUMMARY' }],
    },
  });
  assert.deepEqual(deleted, ['ses_stateful_1']);
  assert.deepEqual(created, ['ses_stateful_1', 'ses_stateful_2']);
  assert.equal(promptCalls[2].sessionID, 'ses_stateful_2');
  assert.equal(promptCalls[2].isContinuation, false);
  assert.match(promptCalls[2].text, /COMPACTED_HISTORY_SUMMARY/);

  // 第 4 轮触发 handoff -> 标记 dirty -> 第 5 轮不得复用 ses_stateful_2，自动轮换到 ses_stateful_3
  behavior = async (options) => {
    const translated = options.handoff({ native: 'read', input: { filePath: '/tmp/foo.txt' } });
    return { text: '', tokens: null, handoff: [translated] };
  };
  await bridge.complete({
    protocol: 'anthropic',
    headers: { 'x-session-id': 'thread-alpha' },
    body: {
      model: DEMO_MODEL.id,
      system: '你是一个助手',
      max_tokens: 1024,
      tools: [READ_TOOL],
      messages: [
        { role: 'user', content: 'COMPACTED_HISTORY_SUMMARY' },
        { role: 'assistant', content: '普通回复' },
        { role: 'user', content: 'READ_FILE_TURN' },
      ],
    },
  });
  assert.equal(promptCalls[3].sessionID, 'ses_stateful_2');

  behavior = async () => ({ text: '{"content":"读完继续","calls":[]}', tokens: null, handoff: null });
  await bridge.complete({
    protocol: 'anthropic',
    headers: { 'x-session-id': 'thread-alpha' },
    body: {
      model: DEMO_MODEL.id,
      system: '你是一个助手',
      max_tokens: 1024,
      tools: [READ_TOOL],
      messages: [
        { role: 'user', content: 'COMPACTED_HISTORY_SUMMARY' },
        { role: 'assistant', content: '普通回复' },
        { role: 'user', content: 'READ_FILE_TURN' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/tmp/foo.txt' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file body' }] },
      ],
    },
  });
  assert.ok(deleted.includes('ses_stateful_2'), 'handoff 污染过的会话应被淘汰并删除');
  assert.equal(promptCalls[4].sessionID, 'ses_stateful_3');
  assert.equal(promptCalls[4].isContinuation, false);

  // 第 6 轮测试 404 session_not_found 自动建新并全量重放恢复
  behavior = async (options) => {
    if (options.isContinuation) {
      throw Object.assign(new Error('session missing'), { status: 404, code: 'session_not_found' });
    }
    return { text: '{"content":"404 已自动恢复","calls":[]}', tokens: null, handoff: null };
  };
  const recovered = await bridge.complete({
    protocol: 'anthropic',
    headers: { 'x-session-id': 'thread-alpha' },
    body: {
      model: DEMO_MODEL.id,
      system: '你是一个助手',
      max_tokens: 1024,
      tools: [READ_TOOL],
      messages: [
        { role: 'user', content: 'COMPACTED_HISTORY_SUMMARY' },
        { role: 'assistant', content: '普通回复' },
        { role: 'user', content: 'READ_FILE_TURN' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/tmp/foo.txt' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file body' }] },
        { role: 'assistant', content: '读完继续' },
        { role: 'user', content: 'FOLLOW_AFTER_EXPIRE' },
      ],
    },
  });
  assert.equal(recovered.decoded.content, '404 已自动恢复');
  // 第 5 次发送尝试了 ses_stateful_3 续轮（被 404），随后自动新建 ses_stateful_4 全量重试
  assert.equal(promptCalls[5].sessionID, 'ses_stateful_3');
  assert.equal(promptCalls[5].isContinuation, true);
  assert.equal(promptCalls[6].sessionID, 'ses_stateful_4');
  assert.equal(promptCalls[6].isContinuation, false);
  assert.match(promptCalls[6].text, /COMPACTED_HISTORY_SUMMARY/);
  assert.match(promptCalls[6].text, /FOLLOW_AFTER_EXPIRE/);
});

test('OcClient._promptV2：isContinuation 为 true 时不重复注入 system', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'oc-v2-cont-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  const client = new OcClient({ dataDir });
  client.port = 43210;
  client.started = true;
  client.exited = false;
  client.apiMajor = 2;

  const sentBodies = [];
  client._handlePermissions = () => () => {};
  client._abortSession = async () => {};
  client._request = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/model')) {
      return { ok: true, status: 200, json: {} };
    }
    if (path.endsWith('/prompt')) {
      sentBodies.push(options.body);
      return { ok: true, status: 200, json: {} };
    }
    if (path.endsWith('/wait')) {
      return { ok: true, status: 200, json: { ok: true } };
    }
    if (path.endsWith('/message')) {
      return {
        ok: true,
        status: 200,
        json: [
          {
            info: { role: 'assistant', time: { completed: Date.now() } },
            parts: [{ type: 'text', text: '{"content":"ok","calls":[]}' }],
          },
        ],
      };
    }
    throw new Error(`unexpected path: ${path}`);
  };

  await client.prompt({
    sessionID: 'ses_v2_demo',
    providerID: 'opencode',
    modelID: 'demo-free',
    system: 'SYSTEM_ENVELOPE_ONCE',
    text: 'TURN_ONE_TEXT',
    isContinuation: false,
  });
  await client.prompt({
    sessionID: 'ses_v2_demo',
    providerID: 'opencode',
    modelID: 'demo-free',
    system: 'SYSTEM_ENVELOPE_SECOND_IGNORED',
    text: 'TURN_TWO_DELTA',
    isContinuation: true,
  });

  const sysFile = join(client.runtimeRoot, 'session-systems', 'ses_v2_demo.txt');
  assert.equal(readFileSync(sysFile, 'utf8'), 'SYSTEM_ENVELOPE_ONCE');
  assert.equal(sentBodies.length, 2);
  assert.equal(sentBodies[0].text, 'TURN_ONE_TEXT');
  assert.equal(sentBodies[1].text, 'TURN_TWO_DELTA');

  // 非隔离模式下退回按首轮内联注入、续轮跳过
  const plain = new OcClient({ dataDir, isolate: false });
  plain.port = 43210;
  plain.started = true;
  plain.exited = false;
  plain.apiMajor = 2;
  plain._handlePermissions = () => () => {};
  plain._abortSession = async () => {};
  plain._request = client._request;
  await plain.prompt({
    sessionID: 'ses_v2_plain',
    providerID: 'opencode',
    modelID: 'demo-free',
    system: 'SYSTEM_ENVELOPE_ONCE',
    text: 'PLAIN_ONE',
    isContinuation: false,
  });
  await plain.prompt({
    sessionID: 'ses_v2_plain',
    providerID: 'opencode',
    modelID: 'demo-free',
    system: 'SYSTEM_ENVELOPE_ONCE',
    text: 'PLAIN_TWO',
    isContinuation: true,
  });
  assert.match(sentBodies[2].text, /SYSTEM_ENVELOPE_ONCE[\s\S]*PLAIN_ONE/);
  assert.equal(sentBodies[3].text, 'PLAIN_TWO');

  await client.deleteSession('ses_v2_demo');
  assert.equal(existsSync(sysFile), false);
});

test('ZenClient 伪装模式（通过 Bridge.complete）：跨轮稳定复用 ses_ 会话头并发送前缀一致的结构化多轮消息', async (t) => {
  isolateDataDir(t);

  const captured = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let body = null;
    if (req.method === 'POST') {
      body = await new Promise((resolve) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => resolve(raw ? JSON.parse(raw) : null));
      });
    }
    if (url.pathname === '/modelsdev') {
      const text = JSON.stringify({
        opencode: {
          models: {
            'minimax-style-free': {
              name: 'Messages 系',
              cost: { input: 0, output: 0 },
              provider: { npm: '@ai-sdk/anthropic' },
              limit: { context: 100000, output: 8192 },
            },
          },
        },
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(text);
      return;
    }
    if (url.pathname === '/inference/openai/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'minimax-style-free' }] }));
      return;
    }
    if (url.pathname === '/inference/v1/messages') {
      captured.push({ headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 10 } } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"content":"好的，收到","calls":[]}' } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
      res.end();
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

  const zenClient = new ZenClient({
    baseUrl: `http://127.0.0.1:${port}`,
    modelsDevUrl: `http://127.0.0.1:${port}/modelsdev`,
  });
  t.after(() => zenClient.stop());
  await zenClient.start();
  await zenClient.providers();

  const zenModel = {
    id: 'opencode/minimax-style-free',
    providerID: 'opencode',
    modelID: 'minimax-style-free',
    name: 'Messages 系',
    free: true,
    reasoning: false,
    images: false,
    contextWindow: 100_000,
  };
  const bridge = new Bridge({ log: () => {}, targets: [] });
  bridge.state.mode = 'masquerade';
  bridge.state.models = [zenModel];
  bridge.state.verdicts.set(zenModel.id, { verdict: 'tool', note: '' });
  bridge.client = zenClient;

  await bridge.complete({
    protocol: 'anthropic',
    body: {
      model: zenModel.id,
      system: '遵循代码规范',
      max_tokens: 1024,
      tools: [READ_TOOL],
      messages: [
        { role: 'user', content: '帮我查一下 README' },
      ],
    },
  });

  await bridge.complete({
    protocol: 'anthropic',
    body: {
      model: zenModel.id,
      system: '遵循代码规范',
      max_tokens: 1024,
      tools: [READ_TOOL],
      messages: [
        { role: 'user', content: '帮我查一下 README' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '我先读一下 README' },
            { type: 'tool_use', id: 'tu_readme', name: 'Read', input: { file_path: 'README.md' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_readme', content: '# Project Title' },
            { type: 'text', text: '总结一下标题' },
          ],
        },
      ],
    },
  });

  assert.equal(captured.length, 2);
  const ses1 = captured[0].headers['x-opencode-session'];
  const ses2 = captured[1].headers['x-opencode-session'];
  assert.match(ses1, /^ses_/);
  assert.equal(ses1, ses2, '伪装模式同一对话应复用完全一致的 ses_ 会话 ID');
  assert.equal(captured[0].headers['x-opencode-session-id'], ses1);
  assert.equal(captured[1].headers['x-opencode-session-id'], ses2);

  // 结构化多轮数组 + 前缀一致命中服务端 Prompt Cache
  assert.ok(Array.isArray(captured[1].body.messages));
  assert.equal(captured[1].body.messages.length, 3, '第 2 轮应保留 user -> assistant -> user 多轮结构而非压平成 1 条 user');
  assert.equal(captured[1].body.messages[0].role, 'user');
  assert.equal(captured[1].body.messages[1].role, 'assistant');
  assert.equal(captured[1].body.messages[2].role, 'user');
  assert.deepEqual(captured[1].body.system, captured[0].body.system, 'system 前缀应对齐以命中 KV 缓存');
  assert.deepEqual(captured[1].body.messages[0], captured[0].body.messages[0], '第 0 条消息前缀必须逐字节一致');

  // 第 3 轮：历史里只有纯文本 assistant 回复时，仍按信封 JSON 序列化，避免打破后续轮次的 JSON 格式遵循
  await bridge.complete({
    protocol: 'anthropic',
    body: {
      model: zenModel.id,
      system: '遵循代码规范',
      max_tokens: 1024,
      tools: [READ_TOOL],
      messages: [
        { role: 'user', content: '帮我查一下 README' },
        { role: 'assistant', content: '好的，收到' },
        { role: 'user', content: '继续' },
      ],
    },
  });
  assert.equal(captured[2].body.messages[1].role, 'assistant');
  assert.deepEqual(JSON.parse(captured[2].body.messages[1].content), { content: '好的，收到', calls: [] });
});
