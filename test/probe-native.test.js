/**
 * 体检判定新口径的测试（2026-10-23）：
 *   1. 回信不符合信封、但回合内真调过本机工具（nativeBlocked>0）→ tool（转交链路能兜住）；
 *   2. 失败也写缓存且走短 TTL——免费池轮换后自动重试有机会翻案。
 * 全部用假 client（probe 的 client 是注入的），不触网。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { probe, probeMany, PROBE_FINGERPRINT } from '../src/probe.js';
import { ProbeCache } from '../src/probe-cache.js';

/** 造一个假 client：prompt 的行为可编程（拿得到请求内容），调用次数记下来 */
function fakeClient({ reply, error } = {}) {
  const calls = [];
  return {
    calls,
    async createSession() { return 'ses_fake'; },
    async deleteSession() {},
    async prompt(options) {
      calls.push(Date.now());
      if (error) throw error;
      return typeof reply === 'function' ? reply(options, calls.length) : reply;
    },
  };
}

/** 从体检的 user 文本里抠出靶子文件的绝对路径（体检每次用随机文件名，不能写死） */
function targetPathIn(text) {
  return (String(text).match(/\/[^\s'"]+\.txt/) || [])[0] ?? '/tmp/unknown.txt';
}

async function makeWorkdir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'oc-probe-native-'));
  await writeFile(join(dir, 'target.txt'), 'OZ-NATIVE-1234\n', 'utf8');
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('指纹已是 v2：判定口径改过，旧缓存必须全部作废', () => {
  assert.equal(PROBE_FINGERPRINT, 'v2');
});

test('真调过本机工具的模型判 tool：纯文本回信也翻案', async (t) => {
  const workdir = await makeWorkdir(t);
  const client = fakeClient({ reply: { text: '抱歉，我直接读文件被拦了，只能这样回复你。', tokens: null, nativeBlocked: 1 } });
  const result = await probe(client, { id: 'opencode/demo', name: 'demo' }, { workdir });
  assert.equal(result.verdict, 'tool');
  assert.match(result.note, /转交/);
});

test('真调过本机工具的模型判 tool：空 calls 的合格信封也翻案', async (t) => {
  const workdir = await makeWorkdir(t);
  const client = fakeClient({
    reply: { text: '{"content":"我调不了工具，只能聊天","calls":[]}', tokens: null, nativeBlocked: 2 },
  });
  const result = await probe(client, { id: 'opencode/demo', name: 'demo' }, { workdir });
  assert.equal(result.verdict, 'tool');
  assert.match(result.note, /2 次/);
});

test('没真调过本机工具的照旧判 chat（口径没有整体放宽）', async (t) => {
  const workdir = await makeWorkdir(t);
  const client = fakeClient({ reply: { text: '我读不了文件，只能聊天。', tokens: null, nativeBlocked: 0 } });
  const result = await probe(client, { id: 'opencode/demo', name: 'demo' }, { workdir });
  assert.equal(result.verdict, 'chat');
});

test('失败写缓存且走短 TTL：TTL 内重测不再发请求，过期后自动真测', async (t) => {
  const workdir = await makeWorkdir(t);
  const dir = await mkdtemp(join(tmpdir(), 'oc-probe-native-cache-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // 第一次：失败（上游 500 那种），要写进缓存
  let fail = true;
  const client = fakeClient({
    reply: (options) => {
      if (fail) throw new Error('模型这次没能给出回答（HTTP 500）');
      return {
        text: `{"content":"","calls":[{"name":"read","arguments":{"filePath":"${targetPathIn(options.text)}"}}]}`,
        tokens: null,
        nativeBlocked: 0,
      };
    },
  });
  const cache = new ProbeCache({ file: join(dir, 'probe-cache.json'), ttlMs: 3_600_000, failureTtlMs: 80 });

  const first = await probeMany({ client, models: [{ id: 'opencode/demo', name: 'demo' }], workdir, cache });
  assert.equal(first[0].verdict, 'failed');
  assert.equal(client.calls.length, 1);
  assert.ok(cache.get('opencode/demo', PROBE_FINGERPRINT), '失败结论要进缓存');

  // TTL 内再测：吃缓存，不发请求
  const second = await probeMany({ client, models: [{ id: 'opencode/demo', name: 'demo' }], workdir, cache });
  assert.equal(second[0].verdict, 'failed');
  assert.equal(second[0].cached, true, 'TTL 内的失败直接回缓存结论');
  assert.equal(client.calls.length, 1, '不该再发请求');

  // 过期后（池子轮换）上游修好了：真测一次翻案成 tool
  await new Promise((r) => setTimeout(r, 120));
  fail = false;
  const third = await probeMany({ client, models: [{ id: 'opencode/demo', name: 'demo' }], workdir, cache });
  assert.equal(third[0].verdict, 'tool');
  assert.equal(client.calls.length, 2, '过期后要真测');
});

test('failed 判定能落盘再读回（重启不丢，过期自动作废）', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-probe-native-disk-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'probe-cache.json');

  const writer = new ProbeCache({ file, failureTtlMs: 60 });
  await writer.set('opencode/gone', PROBE_FINGERPRINT, 'failed', '体检失败：HTTP 500');
  const reader = new ProbeCache({ file, failureTtlMs: 60 });
  await reader.load();
  assert.equal(reader.get('opencode/gone', PROBE_FINGERPRINT)?.verdict, 'failed');

  await new Promise((r) => setTimeout(r, 90));
  assert.equal(reader.get('opencode/gone', PROBE_FINGERPRINT), null, '短 TTL 过期后自动作废');
});

test('当场重试：上游 5xx 类失败重试一次，第二次通了就翻案', async (t) => {
  const workdir = await makeWorkdir(t);
  const client = fakeClient({
    reply: (options, attempt) => {
      if (attempt === 1) {
        // 第一次：端点抖动（上游 5xx 那类）；第二次：正常交信封
        const error = new Error('模型这次没能给出回答（HTTP 500）');
        error.code = 'upstream_error';
        throw error;
      }
      return {
        text: `{"content":"","calls":[{"name":"read","arguments":{"filePath":"${targetPathIn(options.text)}"}}]}`,
        tokens: null,
        nativeBlocked: 0,
      };
    },
  });
  const logs = [];
  const [result] = await probeMany({
    client, models: [{ id: 'opencode/flaky', name: 'flaky' }], workdir,
    onLog: (line) => logs.push(line),
  });
  assert.equal(result.verdict, 'tool', '端点抖一下不该把模型标红');
  assert.equal(client.calls.length, 2, '重试恰好一次');
  assert.ok(logs.some((line) => /当场重试/.test(line)));
});

test('当场重试：确定性失败（读不懂的回复）不重试，超时类也不重试；语义打偏重试', async (t) => {
  const workdir = await makeWorkdir(t);
  const deterministic = fakeClient({ reply: { text: '{}', tokens: null, nativeBlocked: 0 } });
  const [r1] = await probeMany({ client: deterministic, models: [{ id: 'opencode/a', name: 'a' }], workdir });
  assert.equal(r1.verdict, 'failed');
  assert.equal(deterministic.calls.length, 1, '读不懂的回复是确定性的，不重试');

  const slow = fakeClient({
    reply: () => {
      const error = new Error('体检超时：模型没有回话');
      error.code = 'probe_timeout';
      throw error;
    },
  });
  const [r2] = await probeMany({ client: slow, models: [{ id: 'opencode/b', name: 'b' }], workdir });
  assert.equal(r2.verdict, 'failed');
  assert.equal(slow.calls.length, 1, '超时反映的是负载，不重试（同一口径）');

  // 编造工具名属于语义打偏（随机坏运气）：重试一次
  const mismatch = fakeClient({ reply: { text: '{"calls":[{"name":"编的工具","arguments":{}}]}', tokens: null, nativeBlocked: 0 } });
  const [r3] = await probeMany({ client: mismatch, models: [{ id: 'opencode/c', name: 'c' }], workdir });
  assert.equal(r3.verdict, 'failed', '两次都打偏才最终标红');
  assert.equal(mismatch.calls.length, 2, '语义打偏要当场重试一次');
});
