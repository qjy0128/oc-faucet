/**
 * 协议适配测试：
 *  - prepareAnthropic / prepareOpenAI 的各种输入形状
 *  - toAnthropicResponse / toOpenAIResponse 的块顺序与 stop_reason
 *  - sendAnthropicSSE / sendOpenAISSE：在内存流上跑一遍，再把 SSE 文本解析回来验证事件序列
 *  - tokenUsage 的口径
 * 全部本地，不访问公网。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';

import {
  prepareAnthropic,
  prepareOpenAI,
  toAnthropicResponse,
  toOpenAIResponse,
  sendAnthropicSSE,
  sendOpenAISSE,
  tokenUsage,
} from '../src/protocol.js';
import { BridgeError } from '../src/errors.js';

/* ------------------------------------------------------------------ */
/* 公共夹具                                                            */
/* ------------------------------------------------------------------ */

const MODEL = {
  id: 'opencode/deepseek-v4.1-flash-free',
  providerID: 'opencode',
  modelID: 'deepseek-v4.1-flash-free',
  name: 'deepseek-v4.1-flash-free',
  free: true,
  reasoning: true,
  variants: {},
  images: false,
  contextWindow: 200000,
  deprecated: false,
};

const VISION_MODEL = { ...MODEL, id: 'opencode/vision-free', name: 'vision-free', images: true };

const MODELS = [MODEL, VISION_MODEL];

const ANTHROPIC_TOOLS = [
  {
    name: 'read',
    description: '读取一个文本文件',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'write',
    description: '写入一个文本文件',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
  },
];

/** 断言抛 BridgeError，并返回它供进一步检查 */
function throwsBridge(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof BridgeError, `期望 BridgeError，实际是 ${error && error.constructor && error.constructor.name}`);
    return error;
  }
  throw new Error('期望抛错，但没有抛');
}

/** 把 SSE 文本解析成 [{event, data}]，顺带校验每一行都符合 `event: x\ndata: y\n\n` */
function parseSSE(text) {
  assert.ok(text.endsWith('\n\n'), 'SSE 输出必须以空行结尾');
  const frames = [];
  for (const block of text.split('\n\n')) {
    if (!block) continue;
    const lines = block.split('\n');
    const eventLine = lines.find((line) => line.startsWith('event: '));
    const dataLine = lines.find((line) => line.startsWith('data: '));
    assert.ok(dataLine, `SSE 分片缺少 data 行：${block}`);
    frames.push({
      event: eventLine ? eventLine.slice('event: '.length) : null,
      data: dataLine.slice('data: '.length),
      raw: block,
    });
  }
  return frames;
}

/** 在内存流上跑一次 send*，拿到写出去的文本 */
function capture(send) {
  const res = new PassThrough();
  let text = '';
  res.on('data', (chunk) => {
    text += chunk.toString('utf8');
  });
  let ended = false;
  res.on('finish', () => {
    ended = true;
  });
  send(res);
  return { text, isEnded: () => ended || res.writableEnded };
}

/* ------------------------------------------------------------------ */
/* prepareAnthropic：基本形状                                          */
/* ------------------------------------------------------------------ */

test('prepareAnthropic 命中模型并拼出完整请求', () => {
  const prepared = prepareAnthropic(
    {
      model: MODEL.id,
      max_tokens: 2048,
      stream: true,
      system: '你是助手',
      tools: ANTHROPIC_TOOLS,
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: [{ type: 'text', text: '帮我读 a.txt' }] }],
    },
    MODELS
  );

  assert.equal(prepared.model.id, MODEL.id);
  assert.equal(prepared.system, '你是助手');
  assert.equal(prepared.choice, 'auto');
  assert.equal(prepared.forced, null);
  assert.equal(prepared.parallel, true);
  assert.equal(prepared.stream, true);
  assert.equal(prepared.maxTokens, 2048);
  assert.match(prepared.text, /帮我读 a\.txt/);
  // Anthropic tools → OpenAI 形状
  assert.deepEqual(prepared.tools[0], {
    type: 'function',
    function: {
      name: 'read',
      description: '读取一个文本文件',
      parameters: ANTHROPIC_TOOLS[0].input_schema,
    },
  });
  assert.equal(prepared.tools.length, 2);
});

test('prepareAnthropic：找不到模型报 model_not_found', () => {
  const error = throwsBridge(() => prepareAnthropic({ model: 'opencode/nope', messages: [] }, MODELS));
  assert.equal(error.status, 400);
  assert.equal(error.code, 'model_not_found');
  assert.match(error.message, /opencode\/nope/);
});

test('prepareAnthropic：body 不是对象 / 没有 model 都要报错', () => {
  assert.equal(throwsBridge(() => prepareAnthropic(null, MODELS)).code, 'invalid_request');
  assert.equal(throwsBridge(() => prepareAnthropic([], MODELS)).code, 'invalid_request');
  assert.equal(throwsBridge(() => prepareAnthropic({ messages: [] }, MODELS)).code, 'model_not_found');
});

test('prepareAnthropic：system 支持字符串与 [{type:"text",text}]', () => {
  const asString = prepareAnthropic({ model: MODEL.id, system: 'A', messages: [] }, MODELS);
  assert.equal(asString.system, 'A');

  const asBlocks = prepareAnthropic(
    { model: MODEL.id, system: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }], messages: [] },
    MODELS
  );
  assert.equal(asBlocks.system, 'A\n\nB');

  // 不支持的东西明确报错，不静默忽略
  const error = throwsBridge(() => prepareAnthropic({ model: MODEL.id, system: [{ type: 'image', source: {} }], messages: [] }, MODELS));
  assert.equal(error.status, 400);
  assert.match(error.message, /system 数组/);
});

test('prepareAnthropic：四种内容块都进历史（含 is_error）', () => {
  const prepared = prepareAnthropic(
    {
      model: MODEL.id,
      messages: [
        { role: 'user', content: [{ type: 'text', text: '读 a.txt' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'read', input: { path: 'a.txt' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'hello', is_error: false }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_2', content: '没找到文件', is_error: true }] },
      ],
    },
    MODELS
  );

  const history = JSON.parse(prepared.text.split('\n')[1]);
  assert.deepEqual(history[0], { role: 'user', type: 'text', text: '读 a.txt' });
  assert.deepEqual(history[1], { role: 'assistant', type: 'tool_use', id: 'tu_1', name: 'read', arguments: { path: 'a.txt' } });
  assert.deepEqual(history[2], { role: 'user', type: 'tool_result', tool_call_id: 'tu_1', content: 'hello', is_error: false });
  assert.equal(history[3].is_error, true);
  assert.equal(history[3].content, '没找到文件');
});

test('prepareAnthropic：tool_result 的 content 支持数组块', () => {
  const prepared = prepareAnthropic(
    {
      model: MODEL.id,
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: '第一行' }, { type: 'text', text: '第二行' }] }] },
      ],
    },
    MODELS
  );
  const history = JSON.parse(prepared.text.split('\n')[1]);
  assert.equal(history[0].content, '第一行\n第二行');
});

test('prepareAnthropic：不支持的块（thinking 等）明确报错', () => {
  const error = throwsBridge(() =>
    prepareAnthropic({ model: MODEL.id, messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: '嗯……' }] }] }, MODELS)
  );
  assert.equal(error.status, 400);
  assert.equal(error.code, 'unsupported_content');
  assert.match(error.message, /thinking/);

  assert.equal(
    throwsBridge(() => prepareAnthropic({ model: MODEL.id, messages: [{ role: 'user', content: [{ type: 'document', source: {} }] }] }, MODELS)).code,
    'unsupported_content'
  );
});

test('prepareAnthropic：n 不是 1 明确报错', () => {
  const error = throwsBridge(() => prepareAnthropic({ model: MODEL.id, n: 2, messages: [] }, MODELS));
  assert.equal(error.status, 400);
  assert.equal(error.code, 'unsupported_parameter');
  assert.equal(prepareAnthropic({ model: MODEL.id, n: 1, messages: [] }, MODELS).maxTokens, 4096);
});

test('prepareAnthropic：tool_choice 四种类型映射正确', () => {
  const base = { model: MODEL.id, messages: [], tools: ANTHROPIC_TOOLS };

  assert.deepEqual(pick(prepareAnthropic({ ...base, tool_choice: { type: 'auto' } }, MODELS)), { choice: 'auto', forced: null });
  assert.deepEqual(pick(prepareAnthropic({ ...base, tool_choice: { type: 'any' } }, MODELS)), { choice: 'required', forced: null });
  assert.deepEqual(pick(prepareAnthropic({ ...base, tool_choice: { type: 'tool', name: 'read' } }, MODELS)), {
    choice: 'required',
    forced: 'read',
  });
  assert.deepEqual(pick(prepareAnthropic({ ...base, tool_choice: { type: 'none' } }, MODELS)), { choice: 'none', forced: null });
  // 不传默认 auto
  assert.deepEqual(pick(prepareAnthropic(base, MODELS)), { choice: 'auto', forced: null });

  function pick(prepared) {
    return { choice: prepared.choice, forced: prepared.forced };
  }
});

test('prepareAnthropic：tool_choice 指定了不存在的工具要报错', () => {
  const error = throwsBridge(() =>
    prepareAnthropic({ model: MODEL.id, messages: [], tools: ANTHROPIC_TOOLS, tool_choice: { type: 'tool', name: 'grep' } }, MODELS)
  );
  assert.equal(error.status, 400);
  assert.match(error.message, /grep/);
});

test('prepareAnthropic：tool_choice 形状不对要报错', () => {
  assert.equal(throwsBridge(() => prepareAnthropic({ model: MODEL.id, messages: [], tool_choice: 'auto' }, MODELS)).status, 400);
  assert.equal(
    throwsBridge(() => prepareAnthropic({ model: MODEL.id, messages: [], tool_choice: { type: 'weird' } }, MODELS)).status,
    400
  );
});

test('prepareAnthropic：parallel 只由 disable_parallel_tool_use 决定，指定工具不影响它', () => {
  const prepared = prepareAnthropic(
    { model: MODEL.id, messages: [], tools: ANTHROPIC_TOOLS, tool_choice: { type: 'auto', disable_parallel_tool_use: true } },
    MODELS
  );
  assert.equal(prepared.parallel, false);

  // 指定具体工具只约束「调哪个」，不约束「调几个」：parallel 仍是 true
  const forced = prepareAnthropic({ model: MODEL.id, messages: [], tools: ANTHROPIC_TOOLS, tool_choice: { type: 'tool', name: 'read' } }, MODELS);
  assert.equal(forced.forced, 'read');
  assert.equal(forced.parallel, true);

  // 两者可以叠加
  const both = prepareAnthropic(
    { model: MODEL.id, messages: [], tools: ANTHROPIC_TOOLS, tool_choice: { type: 'tool', name: 'read', disable_parallel_tool_use: true } },
    MODELS
  );
  assert.equal(both.forced, 'read');
  assert.equal(both.parallel, false);
});

test('prepareAnthropic：图片只接受 base64；模型不支持图片时报错', () => {
  const body = {
    model: MODEL.id,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '看看这张图' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
        ],
      },
    ],
  };
  // 模型不支持图片 → 报错
  const unsupported = throwsBridge(() => prepareAnthropic(body, MODELS));
  assert.equal(unsupported.status, 400);
  assert.equal(unsupported.code, 'unsupported_content');
  assert.match(unsupported.message, /不支持图片输入/);

  // 支持图片的模型 → 图片单独挂在文本后面
  const ok = prepareAnthropic({ ...body, model: VISION_MODEL.id }, MODELS);
  const lines = ok.text.split('\n');
  const images = JSON.parse(lines[4]);
  assert.equal(images.length, 1);
  assert.equal(images[0].media_type, 'image/png');
  assert.equal(images[0].data, 'aGVsbG8=');
  const history = JSON.parse(lines[1]);
  assert.equal(history[1].type, 'image');
  assert.equal(history[1].image, 1);

  // 非 base64 来源（例如 URL）明确报错
  const urlImage = throwsBridge(() =>
    prepareAnthropic(
      { model: VISION_MODEL.id, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://x/a.png' } }] }] },
      MODELS
    )
  );
  assert.equal(urlImage.code, 'unsupported_content');
  assert.match(urlImage.message, /base64/);
});

test('prepareAnthropic：messages 形状不对要报错，content 允许是纯字符串', () => {
  assert.equal(throwsBridge(() => prepareAnthropic({ model: MODEL.id, messages: ['hi'] }, MODELS)).status, 400);
  const prepared = prepareAnthropic({ model: MODEL.id, messages: [{ role: 'user', content: '你好' }] }, MODELS);
  const history = JSON.parse(prepared.text.split('\n')[1]);
  assert.deepEqual(history[0], { role: 'user', type: 'text', text: '你好' });
});

/* ------------------------------------------------------------------ */
/* prepareOpenAI                                                       */
/* ------------------------------------------------------------------ */

test('prepareOpenAI 支持 system 消息、字符串 content 与 tool_calls', () => {
  const prepared = prepareOpenAI(
    {
      model: MODEL.id,
      max_tokens: 512,
      messages: [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '读 a.txt' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '文件内容：hello' },
      ],
      tools: ANTHROPIC_TOOLS,
    },
    MODELS
  );

  assert.equal(prepared.system, '你是助手');
  assert.equal(prepared.maxTokens, 512);
  assert.equal(prepared.stream, false);
  const history = JSON.parse(prepared.text.split('\n')[1]);
  assert.deepEqual(history[0], { role: 'user', type: 'text', text: '读 a.txt' });
  assert.deepEqual(history[1], { role: 'assistant', type: 'tool_use', id: 'call_1', name: 'read', arguments: { path: 'a.txt' } });
  assert.deepEqual(history[2], { role: 'tool', type: 'tool_result', tool_call_id: 'call_1', content: '文件内容：hello', is_error: false });
});

test('prepareOpenAI：content 块形式的 tool_result 也认', () => {
  const prepared = prepareOpenAI(
    {
      model: MODEL.id,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_call', id: 'call_9', function: { name: 'write', arguments: '{"path":"a.txt","content":"x"}' } }] },
        { role: 'tool', tool_call_id: 'call_9', content: [{ type: 'text', text: '写入失败：权限不足' }] },
      ],
    },
    MODELS
  );
  const history = JSON.parse(prepared.text.split('\n')[1]);
  assert.deepEqual(history[0].arguments, { path: 'a.txt', content: 'x' });
  assert.equal(history[1].content, '写入失败：权限不足');
});

test('prepareOpenAI：tool_choice 的字符串与函数形状', () => {
  const base = { model: MODEL.id, messages: [] };
  assert.equal(prepareOpenAI({ ...base, tool_choice: 'auto' }, MODELS).choice, 'auto');
  assert.equal(prepareOpenAI({ ...base, tool_choice: 'required' }, MODELS).choice, 'required');
  assert.equal(prepareOpenAI({ ...base, tool_choice: 'none' }, MODELS).choice, 'none');
  const named = prepareOpenAI({ ...base, tool_choice: { type: 'function', function: { name: 'read' } } }, MODELS);
  assert.equal(named.choice, 'required');
  assert.equal(named.forced, 'read');
  // 指定函数不隐含「只准一个」：parallel 默认还是 true（要禁止得用 parallel_tool_calls:false）
  assert.equal(named.parallel, true);
  assert.equal(throwsBridge(() => prepareOpenAI({ ...base, tool_choice: 'whatever' }, MODELS)).status, 400);
});

test('prepareOpenAI：parallel_tool_calls 控制 parallel', () => {
  const base = { model: MODEL.id, messages: [] };
  assert.equal(prepareOpenAI({ ...base, tool_choice: { type: 'auto', parallel_tool_calls: false } }, MODELS).parallel, false);
  assert.equal(prepareOpenAI({ ...base, tool_choice: { type: 'auto', parallel_tool_calls: true } }, MODELS).parallel, true);
  assert.equal(prepareOpenAI(base, MODELS).parallel, true);
});

test('prepareOpenAI：n 不是 1 明确报错；模型不支持图片报错', () => {
  assert.equal(throwsBridge(() => prepareOpenAI({ model: MODEL.id, n: 3, messages: [] }, MODELS)).code, 'unsupported_parameter');
  const vision = prepareOpenAI(
    {
      model: VISION_MODEL.id,
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGk=' } }] }],
    },
    MODELS
  );
  const images = JSON.parse(vision.text.split('\n')[4]);
  assert.equal(images[0].data, 'aGk=');
  assert.equal(
    throwsBridge(() =>
      prepareOpenAI(
        { model: MODEL.id, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGk=' } }] }] },
        MODELS
      )
    ).code,
    'unsupported_content'
  );
  assert.equal(
    throwsBridge(() =>
      prepareOpenAI({ model: VISION_MODEL.id, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/a.png' } }] }] }, MODELS)
    ).code,
    'unsupported_content'
  );
});

/* ------------------------------------------------------------------ */
/* toAnthropicResponse                                                 */
/* ------------------------------------------------------------------ */

test('toAnthropicResponse：有 calls 时 text 在前、tool_use 在后，stop_reason=tool_use', () => {
  const response = toAnthropicResponse(MODEL, { content: '我读一下', calls: [{ name: 'read', arguments: { path: 'a.txt' } }] }, {
    input: 10,
    output: 5,
    reasoning: 3,
    cache: { read: 2, write: 1 },
  });

  assert.equal(response.type, 'message');
  assert.equal(response.role, 'assistant');
  assert.equal(response.model, MODEL.id);
  assert.match(response.id, /^msg_/);
  assert.deepEqual(
    response.content.map((block) => block.type),
    ['text', 'tool_use']
  );
  assert.equal(response.content[0].text, '我读一下');
  assert.match(response.content[1].id, /^toolu_/);
  assert.equal(response.content[1].name, 'read');
  assert.deepEqual(response.content[1].input, { path: 'a.txt' });
  assert.equal(response.stop_reason, 'tool_use');
  // input = 10 + 2 + 1，output = 5 + 3
  assert.deepEqual(response.usage, { input_tokens: 13, output_tokens: 8 });
});

test('toAnthropicResponse：没有 calls 时只有 text 块，stop_reason=end_turn', () => {
  const response = toAnthropicResponse(MODEL, { content: '你好呀', calls: [] }, null);
  assert.deepEqual(
    response.content.map((block) => block.type),
    ['text']
  );
  assert.equal(response.stop_reason, 'end_turn');
  assert.deepEqual(response.usage, { input_tokens: 0, output_tokens: 0 });
});

test('toAnthropicResponse：没有文本时不塞空 text 块', () => {
  const response = toAnthropicResponse(MODEL, { content: '', calls: [{ name: 'read', arguments: { path: 'a.txt' } }] }, null);
  assert.deepEqual(
    response.content.map((block) => block.type),
    ['tool_use']
  );
  assert.equal(response.stop_reason, 'tool_use');
});

test('toAnthropicResponse：什么都没有时给一个空 text 块（content 不能是空数组）', () => {
  const response = toAnthropicResponse(MODEL, { content: '', calls: [] }, null);
  assert.deepEqual(response.content, [{ type: 'text', text: '' }]);
  assert.equal(response.stop_reason, 'end_turn');
});

test('toAnthropicResponse：多个 calls 各占一个块', () => {
  const response = toAnthropicResponse(MODEL, { content: '', calls: [{ name: 'read', arguments: {} }, { name: 'write', arguments: {} }] }, null);
  assert.equal(response.content.length, 2);
  assert.notEqual(response.content[0].id, response.content[1].id);
});

/* ------------------------------------------------------------------ */
/* sendAnthropicSSE                                                    */
/* ------------------------------------------------------------------ */

test('sendAnthropicSSE：事件序列完整、顺序正确、最后 end()', () => {
  const decoded = { content: '我读一下这个文件', calls: [{ name: 'read', arguments: { path: 'a.txt' } }] };
  const { text, isEnded } = capture((res) => sendAnthropicSSE(res, MODEL, decoded, { input: 10, output: 5, reasoning: 3, cache: { read: 2, write: 1 } }));
  const frames = parseSSE(text);

  const names = frames.map((frame) => frame.event);
  assert.deepEqual(names, [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ]);
  assert.ok(isEnded(), 'sendAnthropicSSE 必须自己 res.end()');

  const start = JSON.parse(frames[0].data);
  assert.equal(start.type, 'message_start');
  assert.equal(start.message.model, MODEL.id);
  assert.equal(start.message.usage.input_tokens, 13);
  assert.deepEqual(start.message.content, []);

  const textStart = JSON.parse(frames[1].data);
  assert.deepEqual(textStart.content_block, { type: 'text', text: '' });
  assert.equal(textStart.index, 0);
  assert.equal(JSON.parse(frames[2].data).delta.type, 'text_delta');
  assert.equal(JSON.parse(frames[2].data).delta.text, '我读一下这个文件');

  const toolStart = JSON.parse(frames[4].data);
  assert.equal(toolStart.index, 1);
  assert.equal(toolStart.content_block.type, 'tool_use');
  assert.equal(toolStart.content_block.name, 'read');
  assert.deepEqual(toolStart.content_block.input, {});
  const toolDelta = JSON.parse(frames[5].data);
  assert.equal(toolDelta.delta.type, 'input_json_delta');
  assert.deepEqual(JSON.parse(toolDelta.delta.partial_json), { path: 'a.txt' });

  const delta = JSON.parse(frames[7].data);
  assert.deepEqual(delta.delta, { stop_reason: 'tool_use', stop_sequence: null });
  assert.equal(delta.usage.output_tokens, 8);
  assert.equal(JSON.parse(frames[8].data).type, 'message_stop');
});

test('sendAnthropicSSE：文本按 ≤80 字符分片，拼回来还是原文', () => {
  const content = '字'.repeat(250);
  const { text } = capture((res) => sendAnthropicSSE(res, MODEL, { content, calls: [] }, null));
  const frames = parseSSE(text);
  const pieces = frames.filter((frame) => frame.event === 'content_block_delta').map((frame) => JSON.parse(frame.data).delta.text);

  assert.ok(pieces.length >= 4, `应当分成多片，实际 ${pieces.length} 片`);
  for (const piece of pieces) assert.ok(piece.length <= 80, `单片长度 ${piece.length} 超过 80`);
  assert.equal(pieces.join(''), content);
  assert.equal(JSON.parse(frames.at(-1).data).type, 'message_stop');
});

test('sendAnthropicSSE：没有文本时只有 tool_use 块，stop_reason=tool_use', () => {
  const { text } = capture((res) => sendAnthropicSSE(res, MODEL, { content: '', calls: [{ name: 'read', arguments: {} }] }, null));
  const frames = parseSSE(text);
  const starts = frames.filter((frame) => frame.event === 'content_block_start').map((frame) => JSON.parse(frame.data));
  assert.equal(starts.length, 1);
  assert.equal(starts[0].content_block.type, 'tool_use');
  assert.equal(starts[0].index, 0);
  assert.equal(JSON.parse(frames.find((frame) => frame.event === 'message_delta').data).delta.stop_reason, 'tool_use');
});

test('sendAnthropicSSE：纯聊天回复（无 calls）stop_reason=end_turn', () => {
  const { text } = capture((res) => sendAnthropicSSE(res, MODEL, { content: '你好', calls: [] }, null));
  const frames = parseSSE(text);
  assert.equal(JSON.parse(frames.find((frame) => frame.event === 'message_delta').data).delta.stop_reason, 'end_turn');
  assert.equal(frames.filter((frame) => frame.event === 'content_block_start').length, 1);
});

/* ------------------------------------------------------------------ */
/* toOpenAIResponse / sendOpenAISSE                                    */
/* ------------------------------------------------------------------ */

test('toOpenAIResponse：有 calls 时 tool_calls 的 arguments 是 JSON 字符串', () => {
  const response = toOpenAIResponse(MODEL, { content: '我读一下', calls: [{ name: 'read', arguments: { path: 'a.txt' } }] }, {
    input: 10,
    output: 5,
    reasoning: 3,
    cache: { read: 2, write: 1 },
  });

  assert.equal(response.object, 'chat.completion');
  assert.equal(response.model, MODEL.id);
  assert.match(response.id, /^chatcmpl-/);
  assert.equal(response.choices.length, 1);
  const choice = response.choices[0];
  assert.equal(choice.index, 0);
  assert.equal(choice.finish_reason, 'tool_calls');
  assert.equal(choice.message.role, 'assistant');
  assert.equal(choice.message.content, '我读一下');
  assert.equal(choice.message.tool_calls.length, 1);
  assert.match(choice.message.tool_calls[0].id, /^call_/);
  assert.equal(choice.message.tool_calls[0].type, 'function');
  assert.equal(choice.message.tool_calls[0].function.name, 'read');
  assert.equal(typeof choice.message.tool_calls[0].function.arguments, 'string');
  assert.deepEqual(JSON.parse(choice.message.tool_calls[0].function.arguments), { path: 'a.txt' });
  assert.deepEqual(response.usage, { prompt_tokens: 13, completion_tokens: 8, total_tokens: 21 });
});

test('toOpenAIResponse：无 calls 时没有 tool_calls 字段，finish_reason=stop', () => {
  const response = toOpenAIResponse(MODEL, { content: '你好', calls: [] }, null);
  assert.equal(response.choices[0].finish_reason, 'stop');
  assert.equal('tool_calls' in response.choices[0].message, false);
  assert.equal(response.choices[0].message.content, '你好');
  assert.deepEqual(response.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
});

test('sendOpenAISSE：分片序列、[DONE] 结尾、includeUsage 生效', () => {
  const decoded = { content: '好', calls: [{ name: 'read', arguments: { path: 'a.txt' } }] };
  const { text, isEnded } = capture((res) => sendOpenAISSE(res, MODEL, decoded, { input: 4, output: 6 }, true));

  assert.ok(isEnded(), 'sendOpenAISSE 必须自己 res.end()');
  assert.ok(text.endsWith('data: [DONE]\n\n'));

  const payloads = text
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => block.slice('data: '.length));

  assert.equal(payloads.at(-1), '[DONE]');
  const chunks = payloads.slice(0, -1).map((payload) => JSON.parse(payload));
  for (const chunk of chunks) {
    assert.equal(chunk.object, 'chat.completion.chunk');
    assert.equal(chunk.model, MODEL.id);
  }
  // 第一片带 role
  assert.deepEqual(chunks[0].choices[0].delta, { role: 'assistant', content: '' });
  // 文本分片
  assert.equal(chunks[1].choices[0].delta.content, '好');
  // tool_calls 分片
  const toolChunk = chunks.find((chunk) => chunk.choices[0]?.delta?.tool_calls);
  assert.equal(toolChunk.choices[0].delta.tool_calls[0].function.name, 'read');
  assert.deepEqual(JSON.parse(toolChunk.choices[0].delta.tool_calls[0].function.arguments), { path: 'a.txt' });
  // 收尾分片带 finish_reason（OpenAI 标准：带 usage 的那个分片 choices 为空，排在它后面）
  const finishChunk = chunks.find((chunk) => chunk.choices[0]?.finish_reason);
  assert.equal(finishChunk.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(finishChunk.choices[0].delta, {});
  // usage 分片在最后
  const usageChunk = chunks.at(-1);
  assert.deepEqual(usageChunk.choices, []);
  assert.deepEqual(usageChunk.usage, { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 });
});

test('sendOpenAISSE：includeUsage 为假时不发 usage 分片；无 calls 时 finish_reason=stop', () => {
  const { text } = capture((res) => sendOpenAISSE(res, MODEL, { content: '聊天', calls: [] }, null, false));
  const payloads = text
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => block.slice('data: '.length));
  const chunks = payloads.slice(0, -1).map((payload) => JSON.parse(payload));
  assert.equal(chunks.some((chunk) => chunk.usage), false);
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
  assert.equal(payloads.at(-1), '[DONE]');
});

test('sendOpenAISSE：文本按 ≤80 字符分片', () => {
  const content = 'a'.repeat(200);
  const { text } = capture((res) => sendOpenAISSE(res, MODEL, { content, calls: [] }, null, false));
  const pieces = text
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => block.slice('data: '.length))
    .filter((payload) => payload !== '[DONE]')
    .map((payload) => JSON.parse(payload))
    .map((chunk) => chunk.choices[0].delta.content)
    .filter((piece) => typeof piece === 'string' && piece);
  assert.ok(pieces.length >= 3);
  for (const piece of pieces) assert.ok(piece.length <= 80);
  assert.equal(pieces.join(''), content);
});

/* ------------------------------------------------------------------ */
/* 真·HTTP 回环：确认在真实 ServerResponse 上的行为                     */
/* ------------------------------------------------------------------ */

/** 起一个本地假服务器（只监听 127.0.0.1，端口由系统分配），返回 {url, close} */
async function startFakeServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 拿完整响应文本 */
async function fetchText(url) {
  const response = await fetch(url);
  return { status: response.status, contentType: response.headers.get('content-type'), text: await response.text() };
}

test('sendAnthropicSSE 在真 HTTP 上：调用方设 header，函数只写 body 并 end', async () => {
  const decoded = { content: '我读一下这个文件', calls: [{ name: 'read', arguments: { path: 'a.txt' } }] };
  const fake = await startFakeServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
    sendAnthropicSSE(res, MODEL, decoded, { input: 10, output: 5, reasoning: 3, cache: { read: 2, write: 1 } });
  });

  try {
    const { status, contentType, text } = await fetchText(`${fake.url}/v1/messages`);
    assert.equal(status, 200);
    assert.match(contentType, /text\/event-stream/);

    const frames = parseSSE(text);
    assert.deepEqual(
      frames.map((frame) => frame.event),
      [
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop',
      ]
    );
    assert.equal(JSON.parse(frames[0].data).message.usage.input_tokens, 13);
    assert.equal(JSON.parse(frames.at(-1).data).type, 'message_stop');
  } finally {
    await fake.close();
  }
});

test('sendOpenAISSE 在真 HTTP 上：以 data: [DONE] 收尾', async () => {
  const fake = await startFakeServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    sendOpenAISSE(res, MODEL, { content: '聊天', calls: [] }, null, true);
  });

  try {
    const { status, text } = await fetchText(`${fake.url}/v1/chat/completions`);
    assert.equal(status, 200);
    assert.ok(text.endsWith('data: [DONE]\n\n'));
    const payloads = text
      .split('\n\n')
      .filter((block) => block.startsWith('data: '))
      .map((block) => block.slice('data: '.length));
    assert.equal(payloads.at(-1), '[DONE]');
    assert.equal(JSON.parse(payloads[0]).choices[0].delta.role, 'assistant');
    const chunks = payloads.slice(0, -1).map((payload) => JSON.parse(payload));
    assert.equal(chunks.at(-1).choices.length, 0, 'usage 分片在最后，choices 为空');
    assert.equal(chunks.map((chunk) => chunk.choices[0]?.finish_reason).find(Boolean), 'stop');
  } finally {
    await fake.close();
  }
});

test('流式与非流式的 SSE 文本一致：同一个 decoded 走两次结果相同（除随机 id）', () => {
  const decoded = { content: '一样的内容'.repeat(30), calls: [{ name: 'read', arguments: { path: 'a.txt' } }] };
  const first = capture((res) => sendAnthropicSSE(res, MODEL, decoded, null)).text;
  const second = capture((res) => sendAnthropicSSE(res, MODEL, decoded, null)).text;

  const strip = (text) =>
    text
      .split('\n\n')
      .map((block) => block.replace(/(msg_|toolu_)[0-9a-f]+/g, '$1X'))
      .join('\n\n');
  assert.equal(strip(first), strip(second));
});

/* ------------------------------------------------------------------ */
/* tokenUsage                                                          */
/* ------------------------------------------------------------------ */

test('tokenUsage 拆出 OpenCode 的四个口径', () => {
  assert.deepEqual(tokenUsage({ input: 10, output: 5, reasoning: 3, cache: { read: 2, write: 1 } }), {
    input: 10,
    output: 5,
    cacheRead: 2,
    cacheWrite: 1,
    reasoning: 3,
  });
});

test('tokenUsage 取不到就全给 0', () => {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  assert.deepEqual(tokenUsage(null), zero);
  assert.deepEqual(tokenUsage(undefined), zero);
  assert.deepEqual(tokenUsage({}), zero);
  assert.deepEqual(tokenUsage({ input: 'x', cache: null }), zero);
  assert.deepEqual(tokenUsage(42), zero);
});

test('tokenUsage 也能认 Anthropic / OpenAI 的字段名', () => {
  assert.deepEqual(tokenUsage({ input_tokens: 7, output_tokens: 9 }), {
    input: 7,
    output: 9,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
  });
  assert.deepEqual(tokenUsage({ prompt_tokens: 4, completion_tokens: 6, reasoning_tokens: 2 }), {
    input: 4,
    output: 6,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 2,
  });
});

/* ------------------------------------------------------------------ */
/* 推理档位：客户端选了什么，就得真的传下去                                */
/* ------------------------------------------------------------------ */

/** 一个带档位的模型：low / high / max */
const EFFORT_MODEL = {
  ...MODEL,
  id: 'opencode/effort-free',
  name: 'effort-free',
  variants: {
    low: { reasoningEffort: 'low' },
    high: { reasoningEffort: 'high' },
    max: { reasoningEffort: 'max' },
  },
};
const EFFORT_MODELS = [...MODELS, EFFORT_MODEL];

test('prepareAnthropic：ZCode 选「最高」时，thinking + output_config.effort 翻成 variant', () => {
  const prepared = prepareAnthropic(
    {
      model: EFFORT_MODEL.id,
      messages: [{ role: 'user', content: '你好' }],
      thinking: { type: 'enabled' },
      output_config: { effort: 'max' },
    },
    EFFORT_MODELS,
  );
  assert.equal(prepared.variant, 'max', '选了最高就必须真的传 max，不能按默认跑');
});

test('prepareAnthropic：没选档位时不传 variant', () => {
  const prepared = prepareAnthropic(
    { model: EFFORT_MODEL.id, messages: [{ role: 'user', content: '你好' }] },
    EFFORT_MODELS,
  );
  assert.equal(prepared.variant, null);
});

test('prepareAnthropic：要了模型没有的档位 → 明确报错，不静默降级', () => {
  const error = throwsBridge(() =>
    prepareAnthropic(
      {
        model: EFFORT_MODEL.id,
        messages: [{ role: 'user', content: '你好' }],
        thinking: { type: 'enabled' },
        output_config: { effort: 'medium' },
      },
      EFFORT_MODELS,
    ),
  );
  assert.equal(error.code, 'unsupported_reasoning_effort');
  assert.equal(error.status, 400);
  // 报错里要把它支持的档位列出来，用户才知道该怎么改
  assert.match(error.message, /low/);
  assert.match(error.message, /high/);
  assert.match(error.message, /max/);
});

test('prepareAnthropic：想关思考但模型关不掉 → 不报错、不传 variant', () => {
  const prepared = prepareAnthropic(
    {
      model: EFFORT_MODEL.id,
      messages: [{ role: 'user', content: '你好' }],
      thinking: { type: 'disabled' },
    },
    EFFORT_MODELS,
  );
  assert.equal(prepared.variant, null, '关不掉是模型的能力边界，不该因此拒绝请求');
});

test('prepareOpenAI：reasoning_effort 翻成 variant', () => {
  const prepared = prepareOpenAI(
    { model: EFFORT_MODEL.id, messages: [{ role: 'user', content: '你好' }], reasoning_effort: 'high' },
    EFFORT_MODELS,
  );
  assert.equal(prepared.variant, 'high');
});

test('prepareOpenAI：同样的档位不支持也要报错', () => {
  const error = throwsBridge(() =>
    prepareOpenAI(
      { model: EFFORT_MODEL.id, messages: [{ role: 'user', content: '你好' }], reasoning_effort: 'medium' },
      EFFORT_MODELS,
    ),
  );
  assert.equal(error.code, 'unsupported_reasoning_effort');
});
