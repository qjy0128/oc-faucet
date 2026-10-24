/**
 * OpenAI Responses 协议适配测试（Codex 走这一种）。
 *
 * 覆盖：input 各项的解析、扁平/命名空间工具声明、工具调用往返、
 * 流式事件序列（Codex 硬要求的三件事：response.created、完整的 output_item.done、
 * 结尾 response.completed 且 usage 字段齐）、报错与不支持的内容。
 * 全部本地，不访问公网、不调真模型。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import {
  prepareResponses,
  toResponsesResponse,
  sendResponsesSSE,
} from '../src/protocol.js';

const MODEL = {
  id: 'opencode/big-pickle',
  providerID: 'opencode',
  modelID: 'big-pickle',
  name: 'big-pickle',
  reasoning: true,
  variants: { high: { reasoningEffort: 'high' } },
  images: false,
  contextWindow: 1_000_000,
};
const VISION_MODEL = { ...MODEL, id: 'opencode/vision-free', modelID: 'vision-free', name: 'vision-free', images: true };
const MODELS = [MODEL, VISION_MODEL];

const EXEC_TOOL = {
  type: 'function',
  name: 'exec_command',
  description: 'Runs a command',
  parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] },
};

/** 一个只收集写出内容的假 res */
function fakeRes() {
  const stream = new PassThrough();
  const chunks = [];
  stream.on('data', (c) => chunks.push(c));
  stream.done = () => Buffer.concat(chunks).toString('utf8');
  stream.ended = false;
  const realEnd = stream.end.bind(stream);
  stream.end = (...args) => {
    stream.ended = true;
    return realEnd(...args);
  };
  return stream;
}

/** 把 SSE 文本拆成 [{event, data}] */
function parseSSE(text) {
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      const event = /^event: (.+)$/m.exec(frame)?.[1];
      const data = /^data: (.+)$/m.exec(frame)?.[1];
      return { event, data: data ? JSON.parse(data) : null };
    });
}

/* ------------------------------------------------------------------ */
/* 下行：请求解析                                                       */
/* ------------------------------------------------------------------ */

test('Responses：developer 消息进 system，用户/助手消息进历史', () => {
  const prepared = prepareResponses(
    {
      model: MODEL.id,
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '基础指令' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '帮我看看' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好的' }] },
      ],
    },
    MODELS,
  );
  assert.equal(prepared.system, '基础指令');
  assert.match(prepared.text, /帮我看看/);
  assert.match(prepared.text, /好的/);
  assert.equal(prepared.model.id, MODEL.id);
});

test('Responses：input 传字符串也能读', () => {
  const prepared = prepareResponses({ model: MODEL.id, input: '一句话' }, MODELS);
  assert.match(prepared.text, /一句话/);
});

test('Responses：function_call 与 function_call_output 还原成调用与回执', () => {
  const prepared = prepareResponses(
    {
      model: MODEL.id,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '跑一下' }] },
        { type: 'function_call', call_id: 'call_1', name: 'exec_command', arguments: '{"cmd":"ls"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'a.txt\nb.txt' },
      ],
    },
    MODELS,
  );
  // 历史是塞进一段 JSON 文本里的，直接查关键字段
  assert.match(prepared.text, /"type":"tool_use"/);
  assert.match(prepared.text, /"tool_call_id":"call_1"/);
  assert.match(prepared.text, /a\.txt/);
});

test('Responses：reasoning 项跳过，不报错也不当用户内容', () => {
  const prepared = prepareResponses(
    {
      model: MODEL.id,
      input: [
        { type: 'reasoning', summary: [], encrypted_content: 'gAAA' },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续' }] },
      ],
    },
    MODELS,
  );
  assert.doesNotMatch(prepared.text, /gAAA/);
  assert.match(prepared.text, /继续/);
});

test('Responses：不认识的输入项明确拒绝，不静默丢内容', () => {
  assert.throws(
    () => prepareResponses({ model: MODEL.id, input: [{ type: 'something_new' }] }, MODELS),
    /还不支持这种输入项/,
  );
});

test('Responses：扁平工具声明按 parameters 收，命名空间摊平', () => {
  const prepared = prepareResponses(
    {
      model: MODEL.id,
      input: 'hi',
      tools: [
        EXEC_TOOL,
        { type: 'web_search', external_web_access: false },
        { type: 'namespace', name: 'multi_agent_v1', tools: [{ ...EXEC_TOOL, name: 'spawn_agent' }] },
      ],
    },
    MODELS,
  );
  const names = prepared.tools.map((tool) => tool.function.name);
  assert.deepEqual(names, ['exec_command', 'multi_agent_v1.spawn_agent']);
  assert.deepEqual(prepared.namespaced['multi_agent_v1.spawn_agent'], {
    namespace: 'multi_agent_v1',
    name: 'spawn_agent',
  });
  assert.equal(prepared.tools[0].function.parameters.required[0], 'cmd');
});

test('Responses：tool_choice 的字符串与对象形状都能读', () => {
  assert.deepEqual(
    [prepareResponses({ model: MODEL.id, input: 'hi', tool_choice: 'required' }, MODELS).choice,
      prepareResponses({ model: MODEL.id, input: 'hi', tool_choice: { type: 'function', name: 'exec_command' } }, MODELS).forced],
    ['required', 'exec_command'],
  );
});

test('Responses：档位取 reasoning.effort，模型没这档就报错', () => {
  const ok = prepareResponses({ model: MODEL.id, input: 'hi', reasoning: { effort: 'high' } }, MODELS);
  assert.equal(ok.variant, 'high');
  assert.throws(
    () => prepareResponses({ model: MODEL.id, input: 'hi', reasoning: { effort: 'xhigh' } }, MODELS),
    /没有「xhigh」这个推理档位/,
  );
});

test('Responses：stream / parallel 按 Codex 的形状读', () => {
  const prepared = prepareResponses(
    { model: MODEL.id, input: 'hi', stream: true, parallel_tool_calls: false, store: false, include: ['reasoning.encrypted_content'] },
    MODELS,
  );
  assert.equal(prepared.stream, true);
  assert.equal(prepared.parallel, false);
  assert.equal('maxTokens' in prepared, false);
});

test('Responses：无法落实 max_output_tokens 时明确拒绝', () => {
  assert.throws(
    () => prepareResponses({ model: MODEL.id, input: 'hi', max_output_tokens: 2048 }, MODELS),
    (error) => error.status === 400 && error.code === 'unsupported_parameter' && /无法.*限制.*回复长度/.test(error.message),
  );
});

test('Responses：模型不在清单里 → 人话报错', () => {
  assert.throws(() => prepareResponses({ model: 'opencode/nope', input: 'hi' }, MODELS), /不在本机可用的模型列表里/);
});

test('Responses：图片进了不支持图片的模型要报错', () => {
  assert.throws(
    () => prepareResponses(
      { model: MODEL.id, input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AA==' }] }] },
      MODELS,
    ),
    /不支持图片输入/,
  );
  const ok = prepareResponses(
    { model: VISION_MODEL.id, input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AA==' }] }] },
    MODELS,
  );
  assert.match(ok.text, /media_type/);
});

/* ------------------------------------------------------------------ */
/* 上行：响应形状                                                       */
/* ------------------------------------------------------------------ */

test('Responses：非流式响应带 completed 状态与齐套 usage', () => {
  const body = toResponsesResponse(MODEL, { content: '回答', calls: [{ name: 'exec_command', arguments: { cmd: 'ls' } }] }, { input: 10, output: 4, cache: { read: 2, write: 0 }, reasoning: 1 });
  assert.equal(body.object, 'response');
  assert.equal(body.status, 'completed');
  const types = body.output.map((item) => item.type);
  assert.deepEqual(types, ['message', 'function_call']);
  const call = body.output[1];
  assert.equal(typeof call.arguments, 'string');
  assert.deepEqual(JSON.parse(call.arguments), { cmd: 'ls' });
  assert.ok(call.call_id);
  assert.deepEqual(body.usage, {
    input_tokens: 12,
    output_tokens: 5,
    total_tokens: 17,
    input_tokens_details: { cached_tokens: 2 },
    output_tokens_details: { reasoning_tokens: 1 },
  });
});

test('Responses：命名空间工具回程拆回 namespace + 原工具名', () => {
  const prepared = { namespaced: { 'multi_agent_v1.spawn_agent': { namespace: 'multi_agent_v1', name: 'spawn_agent' } } };
  const body = toResponsesResponse(MODEL, { content: '', calls: [{ name: 'multi_agent_v1.spawn_agent', arguments: {} }] }, null, prepared);
  assert.equal(body.output[0].type, 'function_call');
  assert.equal(body.output[0].name, 'spawn_agent');
  assert.equal(body.output[0].namespace, 'multi_agent_v1');
});

test('Responses：拆开的命名空间工具名在下一轮历史里还原', () => {
  const tools = [{
    type: 'namespace',
    name: 'multi_agent_v1',
    tools: [{ ...EXEC_TOOL, name: 'spawn_agent' }],
  }];
  const prepared = prepareResponses({ model: MODEL.id, input: '安排任务', tools }, MODELS);
  const response = toResponsesResponse(
    MODEL,
    { content: '', calls: [{ name: 'multi_agent_v1.spawn_agent', arguments: { task: '检查项目' } }] },
    null,
    prepared,
  );
  const nextTurn = prepareResponses({ model: MODEL.id, input: response.output, tools }, MODELS);
  const history = JSON.parse(nextTurn.text.split('\n')[1]);

  assert.equal(response.output[0].name, 'spawn_agent');
  assert.equal(response.output[0].namespace, 'multi_agent_v1');
  assert.equal(history[0].name, 'multi_agent_v1.spawn_agent');
});

test('Responses：既没文本也没调用时给一条空消息，output 不许为空', () => {
  const body = toResponsesResponse(MODEL, { content: '', calls: [] }, null);
  assert.equal(body.output.length, 1);
  assert.equal(body.output[0].content[0].text, '');
});

test('Responses：流式必须收尾在 response.completed，工具 item 给完整参数', () => {
  const res = fakeRes();
  sendResponsesSSE(res, MODEL, { content: '一段话', calls: [{ name: 'exec_command', arguments: { cmd: 'ls' } }] }, { input: 5, output: 2 }, { namespaced: {} });
  assert.equal(res.ended, true);
  const frames = parseSSE(res.done());
  const types = frames.map((frame) => frame.data?.type);
  assert.equal(types[0], 'response.created');
  assert.equal(types.at(-1), 'response.completed');
  assert.ok(frames[0].data.response.id, 'response.created 要带 response.id');
  const doneItems = frames.filter((frame) => frame.data?.type === 'response.output_item.done').map((frame) => frame.data.item);
  assert.deepEqual(doneItems.map((item) => item.type), ['message', 'function_call']);
  assert.deepEqual(JSON.parse(doneItems[1].arguments), { cmd: 'ls' }, '参数必须在 done 里给全（Codex 忽略增量）');
  assert.deepEqual(frames.at(-1).data.response.usage.total_tokens, 7);
  // 序列号连续，Codex 按事件顺序处理
  assert.deepEqual(frames.map((frame) => frame.data.sequence_number), frames.map((_, index) => index));
});

test('Responses：流式文本分片能拼回原文', () => {
  const res = fakeRes();
  const long = '一'.repeat(300);
  sendResponsesSSE(res, MODEL, { content: long, calls: [] }, null, { namespaced: {} });
  const deltas = parseSSE(res.done())
    .filter((frame) => frame.data?.type === 'response.output_text.delta')
    .map((frame) => frame.data.delta)
    .join('');
  assert.equal(deltas, long);
});

test('Responses：流式内部出错时用 response.failed 收尾，不半途抛异常', () => {
  const res = fakeRes();
  sendResponsesSSE(res, MODEL, { content: 'x', calls: [{ name: '', arguments: {} }] }, null, { namespaced: {} });
  const frames = parseSSE(res.done());
  assert.equal(frames.length, 1);
  assert.equal(frames[0].data.type, 'response.failed');
  assert.equal(frames[0].data.response.status, 'failed');
  assert.equal(res.ended, true);
});
