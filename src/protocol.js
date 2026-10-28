/**
 * 协议适配层：把客户端说的 Anthropic Messages、OpenAI Chat Completions、OpenAI Responses
 * 三种方言，统一翻译成「信封协议」的一问一答。三个适配器共用 envelope.js。
 *
 * 方向：
 *   下行 prepareAnthropic / prepareOpenAI / prepareResponses：请求体 → { model, system, text, tools, choice, forced, parallel, stream, maxTokens? }
 *   上行 toAnthropicResponse / toOpenAIResponse / toResponsesResponse：信封结果 → 客户端要的响应对象
 *   流式 sendAnthropicSSE / sendOpenAISSE / sendResponsesSSE：把已经校验好的结果按 SSE 分片吐出去
 *
 * 关键约定：**信封校验通过之前，一个字节都不许发给客户端。**
 * 所以流式不是「边生成边解析」，而是「先 await 完整结果 → 解析成功 → 再按 SSE 分片发」，
 * 让客户端有流式观感。校验失败时响应头还没发，调用方（server.js）可以正常返回 502 JSON 错误。
 */
import { BridgeError } from './errors.js';
import { requestedEffort, resolveVariant } from './efforts.js';

/**
 * 把客户端要求的推理档位翻成 OpenCode 的 variant，顺便守住「不许静默降级」。
 *
 * 客户端明确选了档位、而模型没有这个档位时直接报错，而不是当默认跑：
 * 用户以为自己选了"最高"，实际跑的是默认档，他永远不会发现——
 * 这种安静的错误比一个红字报错坏得多。
 *
 * @param {object} model
 * @param {'anthropic'|'openai'} protocol
 * @param {object} body
 * @returns {string|null}
 */
function reasoningVariant(model, protocol, body) {
  const resolved = resolveVariant(model, requestedEffort(protocol, body));
  if (resolved.unsupported) {
    const supported = describeSupportedEfforts(model);
    throw new BridgeError(
      `模型「${model.id}」没有「${resolved.effort}」这个推理档位。` +
        `它支持的档位是：${supported || '（一个都没有，只能按默认跑）'}。` +
        '请在当前客户端里换一个档位，或者换一个支持该档位的模型。',
      400,
      'unsupported_reasoning_effort',
    );
  }
  return resolved.variant;
}

/** 给报错文案用：把模型支持的档位列成人话 */
function describeSupportedEfforts(model) {
  const variants = model && typeof model.variants === 'object' && model.variants ? model.variants : {};
  const names = [];
  for (const options of Object.values(variants)) {
    const effort = options && typeof options === 'object' ? options.reasoningEffort : undefined;
    if (typeof effort === 'string' && !names.includes(effort)) names.push(effort);
  }
  return names.join('、');
}

/** 一次请求默认最多生成多少 token（客户端没给时用） */
const DEFAULT_MAX_TOKENS = 4096;

/** 流式分片：每片最多多少字符（契约要求 ~80） */
const CHUNK_SIZE = 80;

/* ================================================================== */
/* Anthropic Messages                                                  */
/* ================================================================== */

/**
 * 解析 Anthropic /v1/messages 请求体。
 * @param {object} body
 * @param {Array} models
 * @returns {{model:object, system:string, text:string, tools:Array, choice:string,
 *            forced:string|null, parallel:boolean, stream:boolean, maxTokens:number}}
 */
export function prepareAnthropic(body, models) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BridgeError('请求体必须是一个 JSON 对象。请检查客户端发来的内容。', 400, 'invalid_request');
  }

  const model = findModel(models, body.model);
  const system = systemToText(body.system);

  // 契约里明确说了「不要静默忽略」的东西：先查清楚再动手
  assertSingleChoice(body.n);
  assertNumberOrAbsent(body.temperature, 'temperature');
  assertNumberOrAbsent(body.top_p, 'top_p');

  const toolChoice = anthropicToolChoice(body.tool_choice, body.tools);
  const tools = (Array.isArray(body.tools) ? body.tools : []).map(toOpenAITool);

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const history = [];
  const images = [];

  messages.forEach((message, index) => {
    if (!message || typeof message !== 'object') {
      throw new BridgeError(
        `messages 里的第 ${index + 1} 条消息不是一个对象，桥读不懂。请检查客户端发来的请求。`,
        400,
        'invalid_request'
      );
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const where = `messages 的第 ${index + 1} 条（${role}）`;
    const blocks = messageBlocks(message.content, where);

    blocks.forEach((block, blockIndex) => {
      const at = `${where} 的第 ${blockIndex + 1} 个内容块`;
      const type = block && typeof block === 'object' ? block.type : undefined;

      switch (type) {
        case 'text': {
          if (typeof block.text !== 'string') {
            throw new BridgeError(`${at}的 text 字段必须是字符串。请检查客户端发来的请求。`, 400, 'invalid_request');
          }
          history.push({ role, type: 'text', text: block.text });
          break;
        }
        case 'image': {
          if (!model.images) {
            throw new BridgeError(
              `这条对话里带了图片，但模型「${model.id}」不支持图片输入。请换一个支持图片的模型，或把图片去掉后重发。`,
              400,
              'unsupported_content'
            );
          }
          const ref = imageToRef(block, images.length + 1, at);
          images.push(ref.image);
          history.push({ role, type: 'image', image: ref.index, mediaType: ref.image.media_type });
          break;
        }
        case 'tool_use': {
          if (typeof block.name !== 'string' || !block.name) {
            throw new BridgeError(`${at}是 tool_use 块，但没有给出工具名（name）。请检查客户端发来的请求。`, 400, 'invalid_request');
          }
          history.push({
            role,
            type: 'tool_use',
            id: typeof block.id === 'string' ? block.id : `toolu_${history.length + 1}`,
            name: block.name,
            arguments: isPlainObject(block.input) ? block.input : {},
          });
          break;
        }
        case 'tool_result': {
          history.push({
            role,
            type: 'tool_result',
            tool_call_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : null,
            content: toolResultText(block.content),
            is_error: block.is_error === true,
          });
          break;
        }
        default:
          throw new BridgeError(
            `${at}的类型是「${String(type)}」，本桥还不支持这种内容块（目前只支持 text / image / tool_use / tool_result）。` +
              `为了不静默丢掉你的内容，这次请求被拒绝。请在客户端里去掉它，或者告诉我们你需要它。`,
            400,
            'unsupported_content'
          );
      }
    });
  });

  return {
    model,
    system,
    text: buildUserText(history, images),
    tools,
    choice: toolChoice.choice,
    forced: toolChoice.forced,
    parallel: parallelOf(body.tool_choice, toolChoice.forced),
    stream: body.stream === true,
    maxTokens: maxTokensOf(body.max_tokens),
    variant: reasoningVariant(model, 'anthropic', body),
  };
}

/**
 * 把信封结果转成 Anthropic Messages 响应对象。
 * @param {object} model
 * @param {{content:string, calls:Array}} decoded
 * @param {object|null} tokens
 * @returns {object}
 */
export function toAnthropicResponse(model, decoded, tokens) {
  const result = normalizeDecoded(decoded);
  const usage = anthropicUsage(tokens);
  const content = [];
  if (result.content) content.push({ type: 'text', text: result.content });
  for (const call of result.calls) {
    content.push({ type: 'tool_use', id: `toolu_${randomId()}`, name: call.name, input: call.arguments });
  }
  if (!content.length) content.push({ type: 'text', text: '' }); // content 不允许是空数组
  return {
    id: `msg_${randomId()}`,
    type: 'message',
    role: 'assistant',
    model: model && model.id ? model.id : 'unknown',
    content,
    stop_reason: result.calls.length ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: usage.input, output_tokens: usage.output },
  };
}

/**
 * Anthropic 流式：把已经校验好的结果按 SSE 事件吐出去。
 * 调用方负责先设好 statusCode 与 Content-Type: text/event-stream，然后在调用本函数后不要再写。
 * @param {import('node:http').ServerResponse} res
 * @param {object} model
 * @param {{content:string, calls:Array}} decoded
 * @param {object|null} tokens
 */
export function sendAnthropicSSE(res, model, decoded, tokens) {
  const result = normalizeForStream(res, decoded, 'anthropic');
  if (!result) return; // 已经以 error 事件收尾
  const usage = anthropicUsage(tokens);
  const modelId = model && model.id ? model.id : 'unknown';
  const messageId = `msg_${randomId()}`;
  const stopReason = result.calls.length ? 'tool_use' : 'end_turn';

  event(res, 'message_start', {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: modelId,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: usage.input, output_tokens: 0 },
    },
  });

  const blocks = [];
  // 文本块（没有文本时整个块都不出现，避免客户端显示一个空气泡）
  if (result.content) {
    const pieces = chunkText(result.content, CHUNK_SIZE);
    blocks.push({
      start: { type: 'text', text: '' },
      deltas: pieces.map((piece) => ({ type: 'text_delta', text: piece })),
      stop: {},
    });
  }
  for (const call of result.calls) {
    const inputJson = JSON.stringify(call.arguments);
    blocks.push({
      start: { type: 'tool_use', id: `toolu_${randomId()}`, name: call.name, input: {} },
      deltas: chunkText(inputJson, CHUNK_SIZE).map((piece) => ({ type: 'input_json_delta', partial_json: piece })),
      stop: {},
    });
  }

  blocks.forEach((block, index) => {
    event(res, 'content_block_start', { type: 'content_block_start', index, content_block: block.start });
    for (const delta of block.deltas) {
      event(res, 'content_block_delta', { type: 'content_block_delta', index, delta });
    }
    event(res, 'content_block_stop', { type: 'content_block_stop', index });
  });

  event(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: usage.output },
  });
  event(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

/* ================================================================== */
/* OpenAI Chat Completions                                             */
/* ================================================================== */

/** @param {object} body @param {Array} models @returns 同 prepareAnthropic 的形状 */
export function prepareOpenAI(body, models) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BridgeError('请求体必须是一个 JSON 对象。请检查客户端发来的内容。', 400, 'invalid_request');
  }

  const model = findModel(models, body.model);
  const system = openAISystemToText(body.messages);
  assertSingleChoice(body.n);
  assertNumberOrAbsent(body.temperature, 'temperature');
  assertNumberOrAbsent(body.top_p, 'top_p');

  const toolChoice = openAIToolChoice(body.tool_choice);
  const tools = (Array.isArray(body.tools) ? body.tools : []).map(toOpenAITool);

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const history = [];
  const images = [];

  messages.forEach((message, index) => {
    if (!message || typeof message !== 'object') {
      throw new BridgeError(
        `messages 里的第 ${index + 1} 条消息不是一个对象，桥读不懂。请检查客户端发来的请求。`,
        400,
        'invalid_request'
      );
    }
    // system 消息已经在上面的 openAISystemToText 里收进 system 字段，这里不再重复进对话历史
    if (message.role === 'system' || message.role === 'developer') return;

    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const where = `messages 的第 ${index + 1} 条（${String(message.role)}）`;

    // 工具结果：OpenAI 用独立的 role:'tool' 消息承载，要还原成带 tool_call_id 的观察值
    if (message.role === 'tool' || message.role === 'function') {
      history.push({
        role: 'tool',
        type: 'tool_result',
        tool_call_id: typeof message.tool_call_id === 'string' ? message.tool_call_id : null,
        content: toolResultText(message.content),
        // OpenAI 协议本身没有 is_error 字段：只有客户端明确标了 true 才算失败，
        // 不去猜正文里像不像报错（猜错会让模型误判成败）
        is_error: message.is_error === true,
      });
      return;
    }

    const blocks = messageBlocks(message.content, where, { allowToolCalls: message.role === 'assistant' });
    // OpenAI 标准写法：assistant 消息的 content 为 null，调用放在顶层的 tool_calls 里
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      blocks.push(...message.tool_calls.map((call) => ({ ...(call || {}), type: 'tool_call' })));
    }

    blocks.forEach((block, blockIndex) => {
      const at = `${where} 的第 ${blockIndex + 1} 个内容块`;
      const type = block && typeof block === 'object' ? block.type : undefined;

      switch (type) {
        case 'text': {
          if (typeof block.text !== 'string') {
            throw new BridgeError(`${at}的 text 字段必须是字符串。请检查客户端发来的请求。`, 400, 'invalid_request');
          }
          history.push({ role, type: 'text', text: block.text });
          break;
        }
        case 'image_url': {
          if (!model.images) {
            throw new BridgeError(
              `这条对话里带了图片，但模型「${model.id}」不支持图片输入。请换一个支持图片的模型，或把图片去掉后重发。`,
              400,
              'unsupported_content'
            );
          }
          const url = block.image_url && typeof block.image_url === 'object' ? block.image_url.url : block.image_url;
          const parsed = parseDataUrl(url, at);
          images.push(parsed.image);
          history.push({ role, type: 'image', image: images.length, mediaType: parsed.image.media_type });
          break;
        }
        case 'tool_result': {
          history.push({
            role: 'tool',
            type: 'tool_result',
            tool_call_id: typeof block.tool_call_id === 'string' ? block.tool_call_id : null,
            content: toolResultText(block.content),
            is_error: block.is_error === true,
          });
          break;
        }
        case 'tool_call':
        case 'tool_use': {
          const fn = block.function && typeof block.function === 'object' ? block.function : block;
          if (typeof fn.name !== 'string' || !fn.name) {
            throw new BridgeError(`${at}是工具调用块，但没有给出工具名。请检查客户端发来的请求。`, 400, 'invalid_request');
          }
          history.push({
            role: 'assistant',
            type: 'tool_use',
            id: typeof block.id === 'string' ? block.id : `call_${history.length + 1}`,
            name: fn.name,
            arguments: parseArgumentsLoose(fn.arguments, at),
          });
          break;
        }
        default:
          throw new BridgeError(
            `${at}的类型是「${String(type)}」，本桥还不支持这种内容块（目前支持 text / image_url / tool_call / tool_result）。` +
              `为了不静默丢掉你的内容，这次请求被拒绝。`,
            400,
            'unsupported_content'
          );
      }
    });
  });

  return {
    model,
    system,
    text: buildUserText(history, images),
    tools,
    choice: toolChoice.choice,
    forced: toolChoice.forced,
    parallel: parallelOf(body.tool_choice, toolChoice.forced),
    stream: body.stream === true,
    maxTokens: maxTokensOf(body.max_tokens ?? body.max_completion_tokens),
    variant: reasoningVariant(model, 'openai', body),
  };
}

/** OpenAI 非流式响应 */
export function toOpenAIResponse(model, decoded, tokens) {
  const result = normalizeDecoded(decoded);
  const usage = openAIUsage(tokens);
  const message = { role: 'assistant', content: result.content };
  if (result.calls.length) {
    message.content = result.content; // 有工具调用时 content 仍可为 ''（OpenAI 允许）
    message.tool_calls = result.calls.map((call) => ({
      id: `call_${randomId()}`,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    }));
  }
  return {
    id: `chatcmpl-${randomId()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model && model.id ? model.id : 'unknown',
    choices: [
      {
        index: 0,
        message,
        logprobs: null,
        finish_reason: result.calls.length ? 'tool_calls' : 'stop',
      },
    ],
    usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output },
  };
}

/**
 * OpenAI 流式：`data: {...}\n\n` 若干 + `data: [DONE]\n\n`。
 * @param {import('node:http').ServerResponse} res
 * @param {object} model
 * @param {{content:string, calls:Array}} decoded
 * @param {object|null} tokens
 * @param {boolean} [includeUsage] 结尾是否多送一个 usage 分片
 */
export function sendOpenAISSE(res, model, decoded, tokens, includeUsage) {
  const result = normalizeForStream(res, decoded, 'openai');
  if (!result) return; // 已经以 error 事件收尾
  const usage = openAIUsage(tokens);
  const modelId = model && model.id ? model.id : 'unknown';
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-${randomId()}`;
  const frame = (delta, finishReason) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model: modelId,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
  });

  sse(res, { ...frame({ role: 'assistant', content: '' }, null), system_fingerprint: null });

  for (const piece of chunkText(result.content, CHUNK_SIZE)) {
    sse(res, frame({ content: piece }, null));
  }

  if (result.calls.length) {
    const toolCalls = result.calls.map((call, index) => ({
      index,
      id: `call_${randomId()}`,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    }));
    sse(res, frame({ tool_calls: toolCalls }, null));
  }

  sse(res, frame({}, result.calls.length ? 'tool_calls' : 'stop'));

  if (includeUsage) {
    sse(res, {
      id,
      object: 'chat.completion.chunk',
      created,
      model: modelId,
      choices: [],
      usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output },
    });
  }

  res.write('data: [DONE]\n\n');
  res.end();
}

/* ================================================================== */
/* OpenAI Responses（Codex 走的正是这一种 OpenAI 协议，不是 Chat）        */
/* ================================================================== */

/**
 * 解析 POST /v1/responses 请求体。
 *
 * Codex 每轮都把整段对话重发在 input 数组里：
 *   message(role: developer/system) → 系统提示
 *   message(role: user/assistant)   → 对话正文
 *   function_call                   → 模型上一轮发起的工具调用
 *   function_call_output            → 客户端执行完工具的回执
 *   reasoning                       → 模型自己的思考（给的是加密串，桥读不懂，也不含用户内容）
 * 工具声明是 Responses 的扁平形状（参数在 parameters 上，不是 function 里），
 * 命名空间工具（multi_agent 那一类）摊平成「命名空间.工具名」，回程再拆回去。
 *
 * @param {object} body
 * @param {Array} models
 * @returns {{model:object, system:string, text:string, tools:Array, choice:string,
 *            forced:string|null, parallel:boolean, stream:boolean,
 *            variant:string|null, namespaced:Object<string,{namespace:string,name:string}>}}
 */
export function prepareResponses(body, models) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BridgeError('请求体必须是一个 JSON 对象。请检查客户端发来的内容。', 400, 'invalid_request');
  }

  const model = findModel(models, body.model);
  assertSingleChoice(body.n);
  assertNumberOrAbsent(body.temperature, 'temperature');
  assertNumberOrAbsent(body.top_p, 'top_p');
  if (body.max_output_tokens !== undefined && body.max_output_tokens !== null) {
    throw new BridgeError(
      '本桥当前无法让 OpenCode 按 max_output_tokens 限制单次回复长度，请从请求中移除此参数后重试。',
      400,
      'unsupported_parameter',
    );
  }

  const namespaced = Object.create(null);
  const tools = responsesTools(body.tools, namespaced);
  const toolChoice = responsesToolChoice(body.tool_choice);

  const systemParts = [];
  if (typeof body.instructions === 'string' && body.instructions) systemParts.push(body.instructions);

  const history = [];
  const images = [];
  const items = typeof body.input === 'string'
    ? [{ type: 'message', role: 'user', content: body.input }]
    : Array.isArray(body.input)
      ? body.input
      : [];

  items.forEach((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new BridgeError(
        `input 里的第 ${index + 1} 项不是一个对象，桥读不懂。请检查客户端发来的请求。`,
        400,
        'invalid_request',
      );
    }
    const where = `input 的第 ${index + 1} 项（${String(item.type)}）`;

    switch (item.type) {
      case 'message': {
        const role = item.role === 'assistant' ? 'assistant' : 'user';
        if (item.role === 'system' || item.role === 'developer') {
          for (const block of messageBlocks(item.content, `${where} 的系统提示`)) {
            if (block?.type === 'input_text' || block?.type === 'text') {
              if (typeof block.text !== 'string') {
                throw new BridgeError(`${where}里的文本不是字符串。请检查客户端发来的请求。`, 400, 'invalid_request');
              }
              systemParts.push(block.text);
            } else if (block?.type === 'input_image' || block?.type === 'image_url') {
              // 系统提示位里塞图片极少见，但既然来了就不能丢
              history.push(responsesImage(model, block, images, role, atOf(where, 1)));
            } else {
              throw unsupported(where, block?.type);
            }
          }
          return;
        }
        for (const [blockIndex, block] of messageBlocks(item.content, where).entries()) {
          const at = atOf(where, blockIndex + 1);
          switch (block?.type) {
            case 'input_text':
            case 'output_text':
            case 'text': {
              if (typeof block.text !== 'string') {
                throw new BridgeError(`${at}的 text 字段必须是字符串。请检查客户端发来的请求。`, 400, 'invalid_request');
              }
              history.push({ role, type: 'text', text: block.text });
              break;
            }
            case 'input_image':
            case 'image_url': {
              history.push(responsesImage(model, block, images, role, at));
              break;
            }
            default:
              throw unsupported(where, block?.type);
          }
        }
        return;
      }
      case 'function_call': {
        if (typeof item.name !== 'string' || !item.name) {
          throw new BridgeError(`${where}是工具调用，但没有给出工具名。请检查客户端发来的请求。`, 400, 'invalid_request');
        }
        const namespace = typeof item.namespace === 'string' ? item.namespace : '';
        const name = namespace && !item.name.startsWith(`${namespace}.`)
          ? `${namespace}.${item.name}`
          : item.name;
        history.push({
          role: 'assistant',
          type: 'tool_use',
          id: typeof item.call_id === 'string' ? item.call_id : `call_${history.length + 1}`,
          name,
          arguments: parseArgumentsLoose(item.arguments, where),
        });
        return;
      }
      case 'function_call_output': {
        history.push({
          role: 'tool',
          type: 'tool_result',
          tool_call_id: typeof item.call_id === 'string' ? item.call_id : null,
          content: toolResultText(item.output),
          // 只有客户端明确标失败才算失败，不去猜正文像不像报错
          is_error: item.is_error === true || item.status === 'failed',
        });
        return;
      }
      case 'reasoning':
        return; // 模型的思考记录，不含用户内容
      default:
        throw new BridgeError(
          `${where}的类型是「${String(item.type)}」，本桥还不支持这种输入项` +
            '（目前支持 message / function_call / function_call_output，reasoning 会被跳过）。' +
            '为了不静默丢掉你的内容，这次请求被拒绝。',
          400,
          'unsupported_content',
        );
    }
  });

  return {
    model,
    system: systemParts.filter(Boolean).join('\n\n'),
    text: buildUserText(history, images),
    tools,
    choice: toolChoice.choice,
    forced: toolChoice.forced,
    parallel: body.parallel_tool_calls !== false,
    stream: body.stream === true,
    variant: reasoningVariant(model, 'responses', body),
    namespaced,
  };
}

/** Responses 的非流式响应体 */
export function toResponsesResponse(model, decoded, tokens, prepared) {
  const result = normalizeDecoded(decoded);
  const response = responsesShell(model, prepared);
  response.output = responsesOutput(result, response.id, prepared);
  response.usage = responsesUsage(tokens);
  return response;
}

/**
 * Responses 的流式：Codex 只看 data 行里的 type，且要求
 *   1. 开头有 response.created（要带 response.id）；
 *   2. 工具调用必须在 response.output_item.done 里**给完整 item**（它显式忽略参数增量事件）；
 *   3. 结尾必须有 response.completed，且 response 里的 usage 字段齐全，否则解析失败。
 * @param {import('node:http').ServerResponse} res
 */
export function sendResponsesSSE(res, model, decoded, tokens, prepared) {
  const result = normalizeForStream(res, decoded, 'responses');
  if (!result) return; // 已经以 response.failed 收尾
  const response = responsesShell(model, prepared);
  const output = responsesOutput(result, response.id, prepared);
  const usage = responsesUsage(tokens);
  let sequenceNumber = 0;
  const send = (type, payload) => {
    sse(res, { type, sequence_number: sequenceNumber++, ...payload });
  };

  send('response.created', { response: { ...response, status: 'in_progress', output: [] } });

  output.forEach((item, outputIndex) => {
    const isMessage = item.type === 'message';
    send('response.output_item.added', {
      output_index: outputIndex,
      item: isMessage ? { ...item, status: 'in_progress', content: [] } : { ...item, arguments: '' },
    });
    if (!isMessage) {
      send('response.output_item.done', { output_index: outputIndex, item });
      return;
    }
    const text = item.content[0]?.text ?? '';
    send('response.content_part.added', {
      item_id: item.id,
      output_index: outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
    for (const piece of chunkText(text, CHUNK_SIZE)) {
      send('response.output_text.delta', { item_id: item.id, output_index: outputIndex, content_index: 0, delta: piece });
    }
    send('response.output_text.done', { item_id: item.id, output_index: outputIndex, content_index: 0, text });
    send('response.content_part.done', {
      item_id: item.id,
      output_index: outputIndex,
      content_index: 0,
      part: { type: 'output_text', text, annotations: [] },
    });
    send('response.output_item.done', { output_index: outputIndex, item });
  });

  send('response.completed', { response: { ...response, status: 'completed', output, usage } });
  res.end();
}

/** 输入项 → 信封历史里的图片；模型不支持图片时明确报错 */
function responsesImage(model, block, images, role, at) {
  if (!model.images) {
    throw new BridgeError(
      `这条对话里带了图片，但模型「${model.id}」不支持图片输入。请换一个支持图片的模型，或把图片去掉后重发。`,
      400,
      'unsupported_content',
    );
  }
  const url = block.image_url && typeof block.image_url === 'object' ? block.image_url.url : block.image_url;
  const parsed = parseDataUrl(typeof url === 'string' ? url : block.image_url, at);
  images.push(parsed.image);
  return { role, type: 'image', image: images.length, mediaType: parsed.image.media_type };
}

function unsupported(where, type) {
  return new BridgeError(
    `${where}里有一个类型是「${String(type)}」的内容块，本桥还不支持（Responses 侧支持 input_text / output_text / input_image）。` +
      '为了不静默丢掉你的内容，这次请求被拒绝。',
    400,
    'unsupported_content',
  );
}

function atOf(where, index) {
  return `${where} 的第 ${index} 个内容块`;
}

/** Responses 的工具声明 → 桥内部的 OpenAI 形状；命名空间摊平，代不了的客户端工具不声明 */
function responsesTools(tools, namespaced) {
  const flat = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!tool || typeof tool !== 'object') {
      throw new BridgeError('tools 列表里有一个不是对象的工具定义。请检查客户端发来的请求。', 400, 'invalid_request');
    }
    if (tool.type === 'namespace') {
      const namespace = typeof tool.name === 'string' ? tool.name : '';
      if (!namespace) {
        throw new BridgeError('tools 里有一个命名空间工具没有名字。请检查客户端发来的请求。', 400, 'invalid_request');
      }
      for (const inner of Array.isArray(tool.tools) ? tool.tools : []) {
        const normalized = toOpenAITool(responsesToolShape(inner, namespace));
        const exposed = `${namespace}.${normalized.function.name}`;
        namespaced[exposed] = { namespace, name: normalized.function.name };
        flat.push({ type: 'function', function: { ...normalized.function, name: exposed } });
      }
      continue;
    }
    // web_search / file_search 这类没有名字的内置客户端工具，桥代不了，就不声明给模型
    if (tool.type && tool.type !== 'function' && tool.type !== 'custom' && typeof tool.name !== 'string') continue;
    flat.push(toOpenAITool(responsesToolShape(tool)));
  }
  return flat;
}

/** Responses 的扁平工具声明 → toOpenAITool 认的形状 */
function responsesToolShape(tool, namespace) {
  if (!tool || typeof tool !== 'object') {
    throw new BridgeError(`tools 列表里有一个不是对象的工具定义${namespace ? `（命名空间「${namespace}」）` : ''}。请检查客户端发来的请求。`, 400, 'invalid_request');
  }
  if (typeof tool.name !== 'string' || !tool.name) {
    throw new BridgeError(
      `tools 里有一个工具定义没有名字${namespace ? `（命名空间「${namespace}」）` : ''}。桥没法把它交给模型，请检查客户端发来的请求。`,
      400,
      'invalid_request',
    );
  }
  const parameters = isPlainObject(tool.parameters) ? tool.parameters : tool.input_schema;
  return { name: tool.name, description: tool.description, input_schema: parameters };
}

/** Responses 的 tool_choice：字符串或 {"type":"function","name":"..."} */
function responsesToolChoice(toolChoice) {
  if (typeof toolChoice === 'object' && toolChoice !== null && !Array.isArray(toolChoice)
    && toolChoice.type === 'function' && typeof toolChoice.name === 'string') {
    return openAIToolChoice({ type: 'function', function: { name: toolChoice.name } });
  }
  return openAIToolChoice(toolChoice);
}

function responsesShell(model, prepared) {
  return {
    id: `resp_${randomId()}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: model && model.id ? model.id : 'unknown',
    output: [],
    tool_choice: prepared?.choice ?? 'auto',
    parallel_tool_calls: prepared?.parallel !== false,
    previous_response_id: null,
  };
}

/** 信封结果 → Responses 的 output 项（一条助手消息 + 若干 function_call） */
function responsesOutput(result, responseId, prepared) {
  const output = [];
  if (result.content) {
    output.push({
      id: `msg_${randomId()}`,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: result.content, annotations: [] }],
    });
  }
  result.calls.forEach((call, index) => {
    const owner = prepared && prepared.namespaced ? prepared.namespaced[call.name] : null;
    const item = {
      id: `fc_${randomId()}`,
      type: 'function_call',
      call_id: `call_${responseId}_${index + 1}`,
      name: owner ? owner.name : call.name,
      arguments: JSON.stringify(call.arguments),
      status: 'completed',
    };
    if (owner) item.namespace = owner.namespace;
    output.push(item);
  });
  if (!output.length) {
    output.push({
      id: `msg_${randomId()}`,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: '', annotations: [] }],
    });
  }
  return output;
}

/** Responses 的口径：缓存读、思考要分别挂在 details 上，缺了 Codex 会解析失败 */
function responsesUsage(tokens) {
  const usage = tokenUsage(tokens);
  const input = usage.input + usage.cacheRead + usage.cacheWrite;
  const output = usage.output + usage.reasoning;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
    input_tokens_details: { cached_tokens: usage.cacheRead },
    output_tokens_details: { reasoning_tokens: usage.reasoning },
  };
}

/** OpenCode 把缓存读写和思考单独计价，OpenAI / Anthropic 口径要合并回去 */
export function tokenUsage(tokens) {
  const source = tokens && typeof tokens === 'object' && !Array.isArray(tokens) ? tokens : {};
  const cache = source.cache && typeof source.cache === 'object' && !Array.isArray(source.cache) ? source.cache : {};
  return {
    input: numberOrZero(source.input ?? source.prompt_tokens ?? source.input_tokens),
    output: numberOrZero(source.output ?? source.completion_tokens ?? source.output_tokens),
    cacheRead: numberOrZero(cache.read ?? source.cache_read_input_tokens ?? source.cacheRead),
    cacheWrite: numberOrZero(cache.write ?? source.cache_creation_input_tokens ?? source.cacheWrite),
    reasoning: numberOrZero(source.reasoning ?? source.reasoning_tokens),
  };
}

/** Anthropic 口径：缓存的读和写都算在输入里，思考算在输出里 */
function anthropicUsage(tokens) {
  const usage = tokenUsage(tokens);
  return {
    input: usage.input + usage.cacheRead + usage.cacheWrite,
    output: usage.output + usage.reasoning,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
  };
}

/** OpenAI 口径同理 */
function openAIUsage(tokens) {
  const usage = tokenUsage(tokens);
  return {
    input: usage.input + usage.cacheRead + usage.cacheWrite,
    output: usage.output + usage.reasoning,
  };
}

/* ================================================================== */
/* 内部：下行（把两边的请求形状对上）                                    */
/* ================================================================== */

function findModel(models, id) {
  const list = Array.isArray(models) ? models : [];
  if (typeof id !== 'string' || !id) {
    throw new BridgeError('请求里没有指定 model。请在客户端里选一个模型再发。', 400, 'model_not_found');
  }
  const model = list.find((item) => item && item.id === id);
  if (!model) {
    const sample = list.slice(0, 8).map((item) => item && item.id).filter(Boolean);
    const tail = list.length > sample.length ? `（共 ${list.length} 个）` : '';
    throw new BridgeError(
      `模型「${id}」不在本机可用的模型列表里，用不了。可用的模型有：${sample.join('、') || '（当前一个都没有）'}${tail}。` +
        `请在当前客户端里重新选一个模型。`,
      400,
      'model_not_found'
    );
  }
  return model;
}

/** body.system 可以是字符串，也可以是 [{type:'text',text}] 数组 */
function systemToText(system) {
  if (system === undefined || system === null) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .map((block, index) => {
        if (typeof block === 'string') return block;
        if (!block || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string') {
          throw new BridgeError(
            `system 数组里的第 ${index + 1} 项不是 {"type":"text","text":"..."}，桥读不懂这个系统提示。请检查客户端发来的请求。`,
            400,
            'invalid_request'
          );
        }
        return block.text;
      })
      .filter((text) => text)
      .join('\n\n');
  }
  throw new BridgeError(
    `system 字段必须是字符串或内容块数组，实际是 ${Array.isArray(system) ? '数组' : typeof system}。请检查客户端发来的请求。`,
    400,
    'invalid_request'
  );
}

/** OpenAI 侧的 system：所有 role 为 system/developer 的消息拼起来 */
function openAISystemToText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const texts = [];
  for (const message of list) {
    if (!message || (message.role !== 'system' && message.role !== 'developer')) continue;
    for (const block of messageBlocks(message.content, 'system 消息')) {
      if (block && block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    }
  }
  return texts.join('\n\n');
}

/** 把 content 统一成内容块数组；字符串视为单个 text 块 */
function messageBlocks(content, where, o = {}) {
  if (content === undefined || content === null) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) {
    throw new BridgeError(
      `${where}的 content 必须是字符串或内容块数组，实际是 ${typeof content}。请检查客户端发来的请求。`,
      400,
      'invalid_request'
    );
  }
  return content.map((block, index) => {
    if (typeof block === 'string') return { type: 'text', text: block };
    if (!block || typeof block !== 'object') {
      throw new BridgeError(`${where} 的第 ${index + 1} 个内容块不是对象。请检查客户端发来的请求。`, 400, 'invalid_request');
    }
    // OpenAI 的 assistant 消息在 content 里内嵌 tool_calls 的写法，规范一下再按统一逻辑处理
    if (o.allowToolCalls && block.type === undefined && Array.isArray(block.tool_calls)) {
      return { type: '__tool_calls_inside__', tool_calls: block.tool_calls };
    }
    if (o.allowToolCalls && (block.type === 'tool_calls' || block.type === 'tool_call')) {
      return { type: '__tool_calls_inside__', tool_calls: block.tool_calls ?? [block] };
    }
    return block;
  }).flatMap((block) => {
    if (block.type === '__tool_calls_inside__') {
      return block.tool_calls.map((call) => ({ ...(call || {}), type: 'tool_call' }));
    }
    return [block];
  });
}

/** 图片：只接受 base64 source（Anthropic 形状） */
function imageToRef(block, index, at) {
  const source = block.source;
  if (!source || typeof source !== 'object' || source.type !== 'base64' || typeof source.data !== 'string') {
    throw new BridgeError(
      `${at}是 image 块，但桥只接受 base64 编码的图片（source.type 必须是 'base64'）。` +
        `请换成本地图片，或把图片转成 base64 再发。`,
      400,
      'unsupported_content'
    );
  }
  return {
    index,
    image: {
      media_type: typeof source.media_type === 'string' && source.media_type ? source.media_type : 'image/png',
      data: source.data,
    },
  };
}

/** 图片：OpenAI 的 data URL（也接受纯 base64，media_type 缺省 png） */
function parseDataUrl(url, at) {
  if (typeof url !== 'string' || !url) {
    throw new BridgeError(`${at}是图片块，但里面没有可用的图片数据（url 为空）。请检查客户端发来的请求。`, 400, 'unsupported_content');
  }
  if (url.startsWith('data:')) {
    const match = url.match(/^data:([^;,]+)?(;[^,]*)?,(.*)$/s);
    if (!match) {
      throw new BridgeError(`${at}的图片是一个读不出来的 data URL。请换成 base64 图片再发。`, 400, 'unsupported_content');
    }
    return { image: { media_type: match[1] || 'image/png', data: match[3] } };
  }
  if (/^https?:\/\//i.test(url)) {
    throw new BridgeError(
      `${at}的图片是一个网络地址（${url}）。本桥不替你去下载网络图片，请改成本地图片（base64）。`,
      400,
      'unsupported_content'
    );
  }
  return { image: { media_type: 'image/png', data: url } };
}

/** Anthropic 的 tools: [{name,description,input_schema}] → OpenAI 形状 */
function toOpenAITool(tool) {
  if (!tool || typeof tool !== 'object') {
    throw new BridgeError('tools 列表里有一个不是对象的工具定义。请检查客户端发来的请求。', 400, 'invalid_request');
  }
  if (tool.type === 'function' && tool.function && typeof tool.function === 'object') {
    const fn = tool.function;
    if (typeof fn.name !== 'string' || !fn.name) {
      throw new BridgeError('tools 里有一个 OpenAI 形状的工具没有名字。请检查客户端发来的请求。', 400, 'invalid_request');
    }
    const parameters = isPlainObject(fn.parameters)
      ? fn.parameters
      : { type: 'object', properties: {} };
    return {
      type: 'function',
      function: {
        name: fn.name,
        description: typeof fn.description === 'string' ? fn.description : '',
        parameters,
      },
    };
  }
  if (typeof tool.name !== 'string' || !tool.name) {
    throw new BridgeError('tools 里有一个工具定义没有名字。请检查客户端发来的请求。', 400, 'invalid_request');
  }
  // Anthropic 的 input_schema 就是 JSON Schema，和 OpenAI 的 parameters 同义
  const parameters = isPlainObject(tool.input_schema) ? tool.input_schema : { type: 'object', properties: {} };
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : '',
      parameters,
    },
  };
}

/** Anthropic 的 tool_choice → choice/forced */
function anthropicToolChoice(toolChoice, tools) {
  if (toolChoice === undefined || toolChoice === null) return { choice: 'auto', forced: null };
  if (typeof toolChoice !== 'object' || Array.isArray(toolChoice)) {
    throw new BridgeError('tool_choice 必须是一个对象，例如 {"type":"auto"}。请检查客户端发来的请求。', 400, 'invalid_request');
  }
  switch (toolChoice.type) {
    case 'auto':
      return { choice: 'auto', forced: null };
    case 'any':
      // Anthropic 的 any = 必须用工具（但没说用哪个）
      return { choice: 'required', forced: null };
    case 'tool': {
      if (typeof toolChoice.name !== 'string' || !toolChoice.name) {
        throw new BridgeError('tool_choice 的类型是 tool，但没有给出工具名（name）。请检查客户端发来的请求。', 400, 'invalid_request');
      }
      const names = (Array.isArray(tools) ? tools : []).map((tool) => (tool && typeof tool.name === 'string' ? tool.name : null));
      if (!names.includes(toolChoice.name)) {
        throw new BridgeError(
          `tool_choice 指定的工具「${toolChoice.name}」不在本次请求的 tools 列表里。请检查客户端发来的请求。`,
          400,
          'invalid_request'
        );
      }
      return { choice: 'required', forced: toolChoice.name };
    }
    case 'none':
      return { choice: 'none', forced: null };
    default:
      throw new BridgeError(
        `不认识的 tool_choice 类型「${String(toolChoice.type)}」（支持 auto / any / tool / none）。请检查客户端发来的请求。`,
        400,
        'invalid_request'
      );
  }
}

/** OpenAI 的 tool_choice → choice/forced */
function openAIToolChoice(toolChoice) {
  if (toolChoice === undefined || toolChoice === null) return { choice: 'auto', forced: null };
  if (typeof toolChoice === 'string') {
    switch (toolChoice) {
      case 'auto':
        return { choice: 'auto', forced: null };
      case 'required':
        return { choice: 'required', forced: null };
      case 'none':
        return { choice: 'none', forced: null };
      default:
        throw new BridgeError(
          `不认识的 tool_choice「${toolChoice}」（支持 auto / required / none，或 {"type":"function","function":{"name":"..."}}）。`,
          400,
          'invalid_request'
        );
    }
  }
  if (typeof toolChoice === 'object' && !Array.isArray(toolChoice)) {
    if (toolChoice.type === 'function') {
      const name = toolChoice.function && typeof toolChoice.function === 'object' ? toolChoice.function.name : null;
      if (typeof name !== 'string' || !name) {
        throw new BridgeError('tool_choice 指定了具体函数，但没有给出函数名。请检查客户端发来的请求。', 400, 'invalid_request');
      }
      return { choice: 'required', forced: name };
    }
    if (typeof toolChoice.type === 'string') return openAIToolChoice(toolChoice.type);
  }
  throw new BridgeError('tool_choice 的形状不对，桥读不懂。请检查客户端发来的请求。', 400, 'invalid_request');
}

/**
 * parallel 由客户端显式开关决定。
 * OpenAI：parallel_tool_calls:false；Anthropic：tool_choice.disable_parallel_tool_use:true。
 *
 * 注意：指定了具体工具（tool_choice 为某个 tool / function）**不等于**禁止并行。
 * 真正的约束由 forced 在 decodeEnvelope 里单独执行「每个调用都必须是这个名字」，
 * 所以这里不能顺手把 parallel 也锁死——那会把客户端合法的一批调用误判成 502。
 */
function parallelOf(toolChoice, _forced) {
  if (toolChoice && typeof toolChoice === 'object' && !Array.isArray(toolChoice)) {
    if (toolChoice.parallel_tool_calls !== undefined) return toolChoice.parallel_tool_calls !== false;
    if (toolChoice.disable_parallel_tool_use === true) return false;
  }
  return true;
}

/** n 必须是 1，否则明确报错（不支持一次生成多份候选） */
function assertSingleChoice(n) {
  if (n === undefined || n === null || n === 1) return;
  throw new BridgeError(
    `本桥一次请求只生成一份回复，暂不支持 n=${JSON.stringify(n)}（多份候选）。请把 n 改成 1 或不传。`,
    400,
    'unsupported_parameter'
  );
}

/** temperature / top_p 传了但值不合法就明确报错，避免被上游悄悄忽略 */
function assertNumberOrAbsent(value, name) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new BridgeError(`${name} 必须是数字。请检查客户端发来的请求。`, 400, 'invalid_request');
  }
}

function maxTokensOf(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_MAX_TOKENS;
  return Math.floor(value);
}

/* ================================================================== */
/* 内部：上行（把信封结果变成客户端要的形状）                            */
/* ================================================================== */

/**
 * 上行的 decoded 由 decodeEnvelope 校验过，这里是最后一道兜底。
 * 注意：兜底也绝不「编造」——工具名或参数不对时宁可抛错，
 * 因为替模型编一个工具名或补一个空参数，会让客户端拿着错误的信息去执行动作。
 */
function normalizeDecoded(decoded) {
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new BridgeError('桥内部错误：准备发给客户端的回复不是有效对象。请把日志发给开发者。', 500, 'internal_error');
  }
  const content = typeof decoded.content === 'string' ? decoded.content : '';
  const calls = Array.isArray(decoded.calls) ? decoded.calls : [];
  return {
    content,
    calls: calls.map((call, index) => {
      if (!call || typeof call.name !== 'string' || !call.name) {
        throw new BridgeError(
          `桥内部错误：第 ${index + 1} 个工具调用没有可用的工具名，不能编造一个发给客户端。请把日志发给开发者。`,
          500,
          'internal_error'
        );
      }
      if (!isPlainObject(call.arguments)) {
        throw new BridgeError(
          `桥内部错误：工具「${call.name}」的调用参数不是对象，不能瞎补一个发给客户端。请把日志发给开发者。`,
          500,
          'internal_error'
        );
      }
      return { name: call.name, arguments: call.arguments };
    }),
  };
}

/**
 * 流式路径上的兜底校验。
 * 因为调用方已经设好响应头（甚至可能已经写过字节），这时候不能直接抛错——那样会让连接悬在半空。
 * 契约规定：头已经发了就只能以 error 事件收尾。所以这里把错误翻成对应的错误事件，再正常收尾。
 * 两种协议的收尾形状不同：Anthropic 用 `event: error` 行，OpenAI 只用 `data:` 行。
 * @param {'anthropic'|'openai'} flavor
 * @returns {{content:string, calls:Array}|null} null 表示已经作为错误收尾，调用方直接返回
 */
function normalizeForStream(res, decoded, flavor) {
  try {
    return normalizeDecoded(decoded);
  } catch (error) {
    if (flavor === 'responses') {
      // Responses 没有 error 事件的说法，失败要包在 response.failed 的 response.error 里
      sse(res, {
        type: 'response.failed',
        sequence_number: 0,
        response: {
          id: `resp_${randomId()}`,
          object: 'response',
          created_at: Math.floor(Date.now() / 1000),
          status: 'failed',
          error: { code: error.code || 'internal_error', message: error.message },
        },
      });
      res.end();
      return null;
    }
    const payload = { type: 'error', error: { type: error.code || 'internal_error', message: error.message } };
    if (flavor === 'openai') sse(res, payload);
    else event(res, 'error', payload);
    res.end();
    return null;
  }
}

/** 工具结果内容：可以是字符串，也可以是 [{type:'text',text}]，还要容忍 JSON 结果 */
function toolResultText(content) {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = [];
    for (const block of content) {
      if (typeof block === 'string') texts.push(block);
      else if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    }
    return texts.join('\n');
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/** OpenAI 消息里的 arguments 通常是 JSON 字符串；解不开或不是对象就明确报错（和上行同一个原则） */
function parseArgumentsLoose(value, where) {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value === 'string') {
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new BridgeError(
        `${where}的参数（arguments）不是合法的 JSON 字符串，桥没法还原成参数对象。请检查客户端发来的请求。`,
        400,
        'invalid_request'
      );
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    throw new BridgeError(`${where}的参数（arguments）解析出来不是对象。请检查客户端发来的请求。`, 400, 'invalid_request');
  }
  if (isPlainObject(value)) return value;
  throw new BridgeError(`${where}的参数（arguments）必须是对象或 JSON 字符串。请检查客户端发来的请求。`, 400, 'invalid_request');
}

/**
 * 把历史拼成一段给「只会聊天」的模型看的文本。
 * 模型看不到真正的 messages 数组（OpenCode 侧只收一段文本），所以这里要写得足够清楚：
 * 每条工具调用和它的结果都带上 tool_call_id，第 8 条约束靠它才能对上号。
 */
function buildUserText(history, images) {
  const lines = [];
  if (history.length) {
    lines.push('以下是本轮对话历史（JSON 数组，按时间顺序）：');
    lines.push(JSON.stringify(history));
  } else {
    lines.push('以下是本轮对话历史（JSON 数组，按时间顺序）：');
    lines.push('[]');
  }
  if (images.length) {
    lines.push('');
    lines.push(
      `另外，本轮对话里带了 ${images.length} 张图片，按上面历史里出现 image 的顺序排在下面（image 字段就是它的序号）：`
    );
    lines.push(JSON.stringify(images));
  }
  lines.push('');
  lines.push('请只回复一个 JSON 对象，不要加代码围栏，格式：{"content":"给用户的文字","calls":[{"name":"工具名","arguments":{}}]}');
  return lines.join('\n');
}

/* ================================================================== */
/* 内部：通用小工具                                                     */
/* ================================================================== */

function event(res, name, payload) {
  if (!res || typeof res.write !== 'function') return;
  res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function sse(res, payload) {
  if (!res || typeof res.write !== 'function') return;
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/** 按字符数分片，不切断代理对（emoji 之类的两个字节算一个字符） */
function chunkText(text, size) {
  if (typeof text !== 'string' || !text) return [];
  const units = Array.from(text);
  const chunks = [];
  for (let index = 0; index < units.length; index += size) {
    chunks.push(units.slice(index, index + size).join(''));
  }
  return chunks;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function randomId() {
  return Math.random().toString(16).slice(2, 12);
}
