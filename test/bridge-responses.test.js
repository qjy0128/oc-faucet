/**
 * 桥处理 Responses 请求的链路测试：假 OpenCode、临时设置目录，不调真模型。
 * 覆盖：Codex 的 input 项如何落到 system/正文/档位，以及工具调用原样回给客户端。
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
  reasoning: true,
  variants: { high: { reasoningEffort: 'high' } },
  images: false,
  contextWindow: 200_000,
};

function bridgeWithPrompt(responseText) {
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
      return { text: responseText, tokens: { input: 10, output: 4 } };
    },
    async deleteSession() {},
  };
  return { bridge, seen };
}

const dir = await mkdtemp(join(tmpdir(), 'oc-bridge-responses-'));
process.env.OCF_DATA_DIR = dir;

test('Responses 请求：对话项进历史，档位进 variant，工具名原样回', async () => {
  const { bridge, seen } = bridgeWithPrompt('{"content":"答案","calls":[{"name":"exec_command","arguments":{"cmd":"ls"}}]}');
  const result = await bridge.complete({
    protocol: 'responses',
    body: {
      model: MODEL.id,
      stream: true,
      instructions: 'Codex 顶层指令',
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Codex 基础指令' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '列一下文件' }] },
        { type: 'function_call', call_id: 'call_1', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
        { type: 'function_call_output', call_id: 'call_1', output: '/tmp' },
      ],
      tools: [{ type: 'function', name: 'exec_command', description: '跑命令', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } }],
      reasoning: { effort: 'high' },
    },
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].providerID, 'opencode');
  assert.equal(seen[0].modelID, 'demo');
  assert.equal(seen[0].variant, 'high');
  // 客户端系统指令仍按系统级内容透传，桥自己的信封约束排在后面并保留优先级。
  assert.match(seen[0].system, /Codex 顶层指令/);
  assert.match(seen[0].system, /Codex 基础指令/);
  assert.match(seen[0].system, /OpenAI Responses 协议客户端（Codex）/);
  assert.match(seen[0].system, /只返回一个 JSON 对象/);
  assert.ok(seen[0].system.indexOf('Codex 顶层指令') < seen[0].system.indexOf('Codex 基础指令'));
  assert.ok(seen[0].system.indexOf('Codex 基础指令') < seen[0].system.indexOf('只返回一个 JSON 对象'));
  assert.doesNotMatch(seen[0].text, /Codex (?:顶层|基础)指令/);
  assert.match(seen[0].text, /列一下文件/);
  assert.match(seen[0].text, /\/tmp/);
  assert.equal(result.decoded.content, '答案');
  assert.deepEqual(result.decoded.calls.map((call) => call.name), ['exec_command']);
});

test('Responses 请求：模型不在清单里就在调上游之前挡下', async () => {
  const { bridge, seen } = bridgeWithPrompt('{"content":"x","calls":[]}');
  await assert.rejects(
    () => bridge.complete({ protocol: 'responses', body: { model: 'opencode/没有这个', input: 'hi' } }),
    /不在本机可用的模型列表里/,
  );
  assert.equal(seen.length, 0, '不该把请求发给上游');
});

test('三种方言都走同一个 complete 入口', async () => {
  const { bridge, seen } = bridgeWithPrompt('{"content":"ok","calls":[]}');
  await bridge.complete({ protocol: 'anthropic', body: { model: MODEL.id, system: 'Claude 指令', max_tokens: 100, messages: [{ role: 'user', content: '你好' }] } });
  await bridge.complete({ protocol: 'openai', body: { model: MODEL.id, messages: [{ role: 'developer', content: 'OpenAI 指令' }, { role: 'user', content: '你好' }] } });
  await bridge.complete({ protocol: 'responses', body: { model: MODEL.id, instructions: 'Codex 指令', input: '你好' } });
  assert.equal(seen.length, 3);
  assert.match(seen[0].system, /Claude 指令/);
  assert.match(seen[0].system, /Anthropic Messages 协议客户端/);
  assert.match(seen[1].system, /OpenAI 指令/);
  assert.match(seen[1].system, /OpenAI Chat Completions 协议客户端/);
  assert.match(seen[2].system, /Codex 指令/);
  assert.match(seen[2].system, /OpenAI Responses 协议客户端（Codex）/);
});
