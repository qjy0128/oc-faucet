/**
 * Bridge.complete 的转交接线测试：假 OpenCode、临时设置目录，不调真模型。
 * 覆盖：handoff 回调在什么条件下传给上游客户端、转交结果如何变成 decoded.calls、
 * chatOnly / choice:none / forced 时目标工具表如何收缩。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Bridge } from '../src/main.js';

const MODEL = {
  id: 'opencode/demo',
  providerID: 'opencode',
  modelID: 'demo',
  name: '演示模型',
  free: true,
  reasoning: false,
  images: false,
  contextWindow: 200_000,
};

const READ_TOOL = {
  name: 'Read',
  description: '读文件',
  input_schema: {
    type: 'object',
    properties: { file_path: { type: 'string' } },
    required: ['file_path'],
  },
};
const BASH_TOOL = {
  name: 'Bash',
  description: '跑命令',
  input_schema: {
    type: 'object',
    properties: { command: { type: 'string' } },
    required: ['command'],
  },
};

/**
 * 造一个带假上游的 Bridge。promptBehavior 决定假 prompt 怎么回：
 * 默认把收到的 handoff 回调拿去现场翻译一个被拦的 read 动作。
 */
function bridgeWithFakeClient(promptBehavior) {
  const seen = [];
  const bridge = new Bridge({ log: () => {}, targets: [] });
  bridge.state.port = 41982;
  bridge.state.apiKey = 'test-key';
  bridge.state.models = [MODEL];
  bridge.state.verdicts.set(MODEL.id, { verdict: 'tool', note: '' });
  bridge.client = {
    ready: true,
    isolate: true,
    async createSession() { return 'sess-1'; },
    async prompt(options) {
      seen.push(options);
      return promptBehavior(options);
    },
    async deleteSession() {},
  };
  return { bridge, seen };
}

const anthropicBody = (extra = {}) => ({
  model: MODEL.id,
  max_tokens: 100,
  messages: [{ role: 'user', content: '读一下文件' }],
  ...extra,
});

const dir = await mkdtemp(join(tmpdir(), 'oc-bridge-handoff-'));
process.env.OCF_DATA_DIR = dir;
test.after(() => rm(dir, { recursive: true, force: true }));

test('complete：客户端申报了工具时，prompt 收到转交回调，且真能翻译', async () => {
  const { bridge, seen } = bridgeWithFakeClient(async (options) => {
    // 上游没拦下任何动作：正常信封作答
    assert.equal(typeof options.handoff, 'function', '带工具的请求要把转交回调交给上游客户端');
    return { text: '{"content":"ok","calls":[]}', tokens: null, handoff: null };
  });

  await bridge.complete({
    protocol: 'anthropic',
    body: anthropicBody({ tools: [READ_TOOL] }),
  });

  const translated = seen[0].handoff({ native: 'read', input: { filePath: '/tmp/a.txt' } });
  assert.deepEqual(translated, { name: 'Read', arguments: { file_path: '/tmp/a.txt' } });
});

test('complete：转交命中时跳过信封解析，直接变成 decoded.calls', async () => {
  const { bridge } = bridgeWithFakeClient(async () => ({
    // text 故意放一段解不出信封的内容：转交路径根本不该去碰它
    text: '这不是 JSON',
    tokens: { input: 3, output: 4 },
    handoff: { name: 'Read', arguments: { file_path: '/tmp/target.txt' } },
  }));

  const result = await bridge.complete({
    protocol: 'anthropic',
    body: anthropicBody({ tools: [READ_TOOL] }),
  });

  assert.deepEqual(result.decoded, {
    content: '',
    calls: [{ name: 'Read', arguments: { file_path: '/tmp/target.txt' } }],
  });
  assert.deepEqual(result.tokens, { input: 3, output: 4 });
});

test('complete：仅对话模型不带转交回调', async () => {
  const { bridge, seen } = bridgeWithFakeClient(async (options) => {
    assert.equal(options.handoff, null, 'chatOnly 模型没有可转交的目标工具');
    return { text: '{"content":"我只能聊天","calls":[]}', tokens: null, handoff: null };
  });
  bridge.state.verdicts.set(MODEL.id, { verdict: 'chat', note: '' });

  await bridge.complete({
    protocol: 'anthropic',
    body: anthropicBody({ tools: [READ_TOOL] }),
  });
  assert.equal(seen.length, 1);
});

test('complete：tool_choice 为 none 时不带转交回调', async () => {
  const { bridge, seen } = bridgeWithFakeClient(async (options) => {
    assert.equal(options.handoff, null, '本次请求不允许调用工具，转交目标表应为空');
    return { text: '{"content":"ok","calls":[]}', tokens: null, handoff: null };
  });

  await bridge.complete({
    protocol: 'anthropic',
    body: anthropicBody({ tools: [READ_TOOL], tool_choice: { type: 'none' } }),
  });
  assert.equal(seen.length, 1);
});

test('complete：forced 时只允许把动作转交给被强制的那个工具', async () => {
  // 强制 Bash：被拦的 read 翻不到 Bash，回调必须返回 null（退回纠正性拒批）
  const bashOnly = bridgeWithFakeClient(async (options) => {
    assert.equal(options.handoff({ native: 'read', input: { filePath: '/tmp/a' } }), null);
    return { text: '{"content":"","calls":[{"name":"Bash","arguments":{"command":"ls"}}]}', tokens: null, handoff: null };
  });
  await bashOnly.bridge.complete({
    protocol: 'anthropic',
    body: anthropicBody({ tools: [READ_TOOL, BASH_TOOL], tool_choice: { type: 'tool', name: 'Bash' } }),
  });

  // 强制 Read：read 动作能翻到 Read，但 bash 动作翻不到
  const readOnly = bridgeWithFakeClient(async (options) => {
    assert.deepEqual(
      options.handoff({ native: 'read', input: { filePath: '/tmp/a' } }),
      { name: 'Read', arguments: { file_path: '/tmp/a' } },
    );
    assert.equal(options.handoff({ native: 'bash', input: { command: 'ls' } }), null);
    return { text: '{"content":"","calls":[{"name":"Read","arguments":{"file_path":"/tmp/a"}}]}', tokens: null, handoff: null };
  });
  await readOnly.bridge.complete({
    protocol: 'anthropic',
    body: anthropicBody({ tools: [READ_TOOL, BASH_TOOL], tool_choice: { type: 'tool', name: 'Read' } }),
  });
});

test('complete：没申报工具的请求不带转交回调', async () => {
  const { bridge, seen } = bridgeWithFakeClient(async (options) => {
    assert.equal(options.handoff, null, '没有工具表就没有转交目标');
    return { text: '{"content":"ok","calls":[]}', tokens: null, handoff: null };
  });

  await bridge.complete({
    protocol: 'anthropic',
    body: anthropicBody(),
  });
  assert.equal(seen.length, 1);
});
