/**
 * zen-client.js 的测试：本地起一个 http 桩同时冒充 zen 和 models.dev，
 * 断言伪装头、请求体形状、三种方言的流式收齐、桩调用转交与错误映射。
 * 全程只连 127.0.0.1，不访问公网。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { ZenClient } from '../src/zen-client.js';
import { OPENCODE_ID_PATTERN, OPENCODE_TOOL_DESCRIPTIONS, OPENCODE_USER_AGENT } from '../src/zen-impersonate.js';
import { collectModels, faucetModels } from '../src/models.js';

/* ------------------------------------------------------------------ */
/* 桩：zen + models.dev 二合一                                          */
/* ------------------------------------------------------------------ */

/** 按场景回 SSE/JSON 的小工厂。scenario 由测试直接改 stub.scenario 切换。 */
function makeZenStub() {
  const requests = [];
  const stub = {
    requests,
    scenario: 'chat-ok',
    /** 场景计数（第几轮 chat 请求），纠正轮的场景靠它区分 */
    chatRounds: 0,
  };

  const sse = (res, events) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const ev of events) res.write(`data: ${typeof ev === 'string' ? ev : JSON.stringify(ev)}\n\n`);
    res.end();
  };
  const json = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };

  const MODELS_DEV = {
    opencode: {
      models: {
        'demo-free': {
          name: 'Demo Free', reasoning: true, modalities: { input: ['text', 'image'] },
          cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
          limit: { context: 100000, input: 50000, output: 8192 },
        },
        'mini-chat-free': { name: 'Mini Chat', cost: { input: 0, output: 0 }, limit: { context: 32000, output: 4096 } },
        'paid-model': { name: 'Paid', cost: { input: 1, output: 2 }, limit: { context: 1000, output: 10 } },
        'gemini-free': { name: 'Gemini 系', cost: { input: 0, output: 0 }, provider: { npm: '@ai-sdk/google' } },
        'minimax-style-free': { name: 'Messages 系', cost: { input: 0, output: 0 }, provider: { npm: '@ai-sdk/anthropic' } },
        'spark-free': { name: 'Responses 系', cost: { input: 0, output: 0 }, provider: { npm: '@ai-sdk/openai' } },
      },
    },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let body = null;
    if (req.method === 'POST') {
      body = await new Promise((resolve) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
          try { resolve(raw ? JSON.parse(raw) : null); } catch { resolve(raw); }
        });
      });
    }
    requests.push({ method: req.method, path: url.pathname, headers: req.headers, body });
    const path = url.pathname;

    if (path === '/modelsdev') {
      // modelsdev-empty 场景模拟 models.dev 撤掉 opencode 条目
      json(res, 200, stub.scenario === 'modelsdev-empty' ? {} : MODELS_DEV);
      return;
    }

    if (path === '/inference/v1/models') {
      json(res, 200, { object: 'list', data: [{ id: 'live-free' }, { id: 'big-pickle' }, { id: 'paid-one' }] });
      return;
    }

    if (path === '/inference/v1/chat/completions') {
      stub.chatRounds += 1;
      const corrective = Array.isArray(body?.messages) && body.messages.some((m) => m.role === 'tool');
      switch (stub.scenario) {
        case 'chat-ok':
          sse(res, [
            { choices: [{ delta: { role: 'assistant' } }] },
            { choices: [{ delta: { content: '你好' } }] },
            { choices: [{ delta: {}, finish_reason: 'stop' }], usage: null },
            { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 1 } } },
            '[DONE]',
          ]);
          return;
        case 'chat-toolcall':
          if (!corrective) {
            sse(res, [
              { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '' } }] } }] },
              { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"filePath":"/tmp/a.txt"}' } }] } }] },
              { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
              '[DONE]',
            ]);
          } else {
            sse(res, [
              { choices: [{ delta: { content: '{"content":"改为文字","calls":[]}' } }] },
              { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 6 } },
              '[DONE]',
            ]);
          }
          return;
        case 'chat-toolcall-insist':
          sse(res, [
            { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_x', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] } }] },
            '[DONE]',
          ]);
          return;
        case 'http-403':
          json(res, 403, { error: { type: 'FreeTierError', message: 'OpenCode\'s free tier can only be used from within OpenCode' } });
          return;
        case 'http-426':
          json(res, 426, { error: { message: 'OpenCode 1.18.0 or newer is required to use the free tier' } });
          return;
        case 'http-410':
          json(res, 410, { type: 'error', error: { type: 'ModelDeprecated', message: 'Model demo-free has been deprecated. Use other instead.' }, metadata: { replacement: 'other' } });
          return;
        case 'http-429':
          json(res, 429, { error: { type: 'server_error', message: 'Upstream request failed: Endpoint is unavailable.' } });
          return;
        default:
          json(res, 500, { error: { message: 'unexpected scenario ' + stub.scenario } });
      }
      return;
    }

    if (path === '/inference/v1/messages') {
      switch (stub.scenario) {
        case 'anthropic-ok':
          sse(res, [
            { type: 'message_start', message: { usage: { input_tokens: 7 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好的' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
            { type: 'message_stop' },
          ]);
          return;
        case 'anthropic-toolcall':
          sse(res, [
            { type: 'message_start', message: { usage: { input_tokens: 7 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'bash' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"ls -la"}' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
            { type: 'message_stop' },
          ]);
          return;
        default:
          json(res, 500, { error: { message: 'unexpected scenario ' + stub.scenario } });
      }
      return;
    }

    if (path === '/inference/v1/responses') {
      switch (stub.scenario) {
        case 'responses-ok':
          sse(res, [
            { type: 'response.output_text.delta', delta: '答案' },
            { type: 'response.completed', response: { usage: { input_tokens: 9, output_tokens: 2, input_tokens_details: { cached_tokens: 1 }, output_tokens_details: { reasoning_tokens: 4 } } } },
          ]);
          return;
        case 'responses-toolcall':
          sse(res, [
            { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'read', arguments: '' } },
            { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"filePath":"/tmp/b.txt"}' },
            { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 1 } } },
          ]);
          return;
        default:
          json(res, 500, { error: { message: 'unexpected scenario ' + stub.scenario } });
      }
      return;
    }

    json(res, 404, { error: { message: 'no route ' + path } });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      stub.port = port;
      stub.close = () => new Promise((done) => server.close(done));
      resolve(stub);
  });
  });
}

/** 造一个指向桩的客户端 */
function makeClient(stub) {
  return new ZenClient({
    baseUrl: `http://127.0.0.1:${stub.port}`,
    modelsDevUrl: `http://127.0.0.1:${stub.port}/modelsdev`,
    onLog: () => {},
  });
}

const stub = await makeZenStub();
test.after(() => stub.close());

const chatPosts = () => stub.requests.filter((r) => r.path === '/inference/v1/chat/completions');

/* ------------------------------------------------------------------ */
/* 目录                                                                */
/* ------------------------------------------------------------------ */

test('providers：models.dev 主源——付费与 Gemini 剔除、字段映射成 collectModels 认的形状', async () => {
  stub.scenario = 'chat-ok';
  const client = makeClient(stub);
  await client.start();
  const payload = await client.providers();

  const provider = payload.providers[0];
  assert.equal(provider.id, 'opencode', 'provider id 不变，切模式后各目标配置不用改');
  // 载荷里保留全部非 Gemini 模型（含付费的）——免费与否是 faucetModels 按价格筛的事
  assert.deepEqual(Object.keys(provider.models).sort(), ['demo-free', 'mini-chat-free', 'minimax-style-free', 'paid-model', 'spark-free']);
  // 直接喂本项目的目录解析链，形状对不对它说了算
  const picked = faucetModels(collectModels(payload));
  assert.deepEqual(picked.map((m) => m.modelID).sort(), ['demo-free', 'mini-chat-free', 'minimax-style-free', 'spark-free'], '付费与 Gemini 剔除，其余免费保留');
  const demo = picked.find((m) => m.modelID === 'demo-free');
  assert.equal(demo.name, 'Demo Free');
  assert.equal(demo.reasoning, true);
  assert.equal(demo.images, true, 'modalities.input 里的 image 要映射到位');
  assert.equal(demo.contextWindow, 100000);
  assert.equal(demo.upstreamLimits.input, 50000);
});

test('providers：models.dev 撤掉 opencode 条目时退 zen 实时清单，免费判定走后缀+白名单', async () => {
  stub.scenario = 'modelsdev-empty';
  const client = makeClient(stub);
  await client.start();
  const payload = await client.providers();

  const picked = faucetModels(collectModels(payload));
  assert.deepEqual(picked.map((m) => m.modelID).sort(), ['big-pickle', 'live-free'], '-free 后缀与白名单算免费，其余按收费剔除');

  // 退路也要带伪装头（zen 的门禁不分目录还是推理）
  const listReq = stub.requests.find((r) => r.path === '/inference/v1/models');
  assert.equal(listReq.headers['user-agent'], OPENCODE_USER_AGENT);
  assert.match(listReq.headers['x-opencode-session'], /^ses_/);
  stub.scenario = 'chat-ok';
});

/* ------------------------------------------------------------------ */
/* prompt：伪装头与请求体（chat 方言）                                   */
/* ------------------------------------------------------------------ */

test('prompt：chat 方言的伪装头逐项到位，请求体带桩工具且永远流式', async () => {
  stub.scenario = 'chat-ok';
  const client = makeClient(stub);
  await client.start();
  await client.providers();

  const sessionID = await client.createSession();
  const result = await client.prompt({ sessionID, modelID: 'demo-free', system: '你是测试', text: '你好' });

  assert.equal(result.text, '你好');
  assert.deepEqual(result.tokens, { input: 10, output: 5, cache: { read: 2, write: 0 }, reasoning: 1 });
  assert.equal(result.handoff, null);

  const req = chatPosts().at(-1);
  const headers = req.headers;
  assert.equal(headers['user-agent'], OPENCODE_USER_AGENT);
  assert.match(headers['x-opencode-session'], /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.equal(headers['x-opencode-session-id'], headers['x-opencode-session']);
  assert.match(headers['x-opencode-request'], /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.equal(headers['x-opencode-client'], 'cli');
  assert.equal(headers['x-opencode-project'], 'global');
  assert.equal(headers.authorization, 'Bearer public');
  assert.equal(headers['x-session-affinity'], undefined, '带了会被免费池 403');
  assert.equal(headers['x-session-id'], undefined);

  assert.equal(req.body.stream, true, '上游永远流式');
  assert.deepEqual(req.body.stream_options, { include_usage: true });
  assert.equal(req.body.system, undefined);
  assert.deepEqual(
    req.body.messages,
    [{ role: 'system', content: '你是测试' }, { role: 'user', content: '你好' }],
  );
  const names = req.body.tools.map((t) => t.function.name).sort();
  assert.deepEqual(names, ['bash', 'read']);
  assert.equal(req.body.tools[0].function.description, OPENCODE_TOOL_DESCRIPTIONS.bash);
  assert.ok(req.body.tools[0].function.parameters.required.length > 0, '空 schema 会被 403');
});

test('prompt：每次请求都换新的 x-opencode-request（纠正轮也是）', async () => {
  stub.scenario = 'chat-toolcall';
  const client = makeClient(stub);
  await client.start();
  await client.providers();
  const sessionID = await client.createSession();
  // handoff 回调返回 null → 会走纠正轮，共两个 chat 请求
  await client.prompt({ sessionID, modelID: 'demo-free', system: '', text: '读文件', handoff: () => null });

  const posts = chatPosts().slice(-2);
  assert.equal(posts.length, 2);
  assert.notEqual(posts[0].headers['x-opencode-request'], posts[1].headers['x-opencode-request'], '回合 id 必须次次新');
  assert.equal(posts[0].headers['x-opencode-session'], posts[1].headers['x-opencode-session'], '会话 id 全程复用');
});

/* ------------------------------------------------------------------ */
/* prompt：桩调用 → 转交 / 纠正                                          */
/* ------------------------------------------------------------------ */

test('prompt：模型真调 read 桩 → 结构化转交直接当答案', async () => {
  stub.scenario = 'chat-toolcall';
  const client = makeClient(stub);
  await client.start();
  await client.providers();
  const sessionID = await client.createSession();

  const blocked = [];
  const result = await client.prompt({
    sessionID, modelID: 'demo-free', system: '', text: '读文件',
    handoff: (action) => {
      blocked.push(action);
      return action.native === 'read' ? { name: 'Read', arguments: { file_path: action.input.filePath } } : null;
    },
  });

  assert.deepEqual(blocked, [{ native: 'read', input: { filePath: '/tmp/a.txt' } }], '桩调用以原生名+参数直达转交映射');
  assert.deepEqual(result.handoff, { name: 'Read', arguments: { file_path: '/tmp/a.txt' } });
  assert.equal(result.text, '');
  assert.equal(chatPosts().length - stub.chatRounds, 0, '不该有多余轮次');
});

test('prompt：翻不了时纠正一轮——认领桩调用、回「工具不可用」，模型退回文字', async () => {
  stub.scenario = 'chat-toolcall';
  const client = makeClient(stub);
  await client.start();
  await client.providers();
  const sessionID = await client.createSession();

  const result = await client.prompt({
    sessionID, modelID: 'demo-free', system: '', text: '读文件',
    handoff: () => null,
  });

  assert.equal(result.handoff, null);
  assert.equal(result.text, '{"content":"改为文字","calls":[]}');

  const posts = chatPosts().slice(-2);
  // 纠正轮是第二个请求：seed + 模型的桩调用认领 + 「工具不可用」结果
  const msgs = posts[1].body.messages;
  const assistant = msgs.find((m) => m.role === 'assistant');
  assert.ok(assistant, '模型的桩调用要原样认领回去');
  assert.equal(assistant.tool_calls[0].function.name, 'read');
  const toolResult = msgs.find((m) => m.role === 'tool');
  assert.equal(toolResult.tool_call_id, assistant.tool_calls[0].id);
  assert.match(toolResult.content, /信封/);
});

test('prompt：纠正过一次还在调桩 → 宽容返回（与内嵌一致），不静默丢证据', async () => {
  stub.scenario = 'chat-toolcall-insist';
  const client = makeClient(stub);
  await client.start();
  await client.providers();
  const sessionID = await client.createSession();

  const result = await client.prompt({ sessionID, modelID: 'demo-free', system: '', text: '跑命令', handoff: () => null });
  // 两轮各调了一次桩：计数要带上；文本照实返回（这个场景模型什么都没说）
  assert.equal(result.handoff, null);
  assert.equal(result.nativeBlocked, 2);
  assert.equal(result.text, '');
  stub.scenario = 'chat-ok';
});

test('prompt：variant（推理档位）不透传，也不会让请求失败', async () => {
  stub.scenario = 'chat-ok';
  const client = makeClient(stub);
  await client.start();
  await client.providers();
  const sessionID = await client.createSession();
  const result = await client.prompt({ sessionID, modelID: 'demo-free', system: '', text: 'hi', variant: 'high' });
  assert.equal(result.text, '你好');
  assert.equal('reasoning_effort' in chatPosts().at(-1).body, false, 'v1 不往上游塞没实测过的档位参数');
});

/* ------------------------------------------------------------------ */
/* prompt：anthropic / responses 方言                                    */
/* ------------------------------------------------------------------ */

test('prompt：anthropic 方言——x-api-key+版本头、input_schema 工具、流式收齐', async () => {
  stub.scenario = 'anthropic-ok';
  const client = makeClient(stub);
  await client.start();
  await client.providers();
  const sessionID = await client.createSession();

  const result = await client.prompt({ sessionID, modelID: 'minimax-style-free', system: '系统词', text: '你好' });
  assert.equal(result.text, '好的');
  assert.deepEqual(result.tokens, { input: 7, output: 3, cache: { read: 0, write: 0 } });

  const req = stub.requests.find((r) => r.path === '/inference/v1/messages');
  assert.equal(req.headers['x-api-key'], 'public');
  assert.equal(req.headers['anthropic-version'], '2023-06-01');
  assert.equal(req.headers.authorization, 'Bearer public');
  assert.equal(req.body.system, '系统词');
  assert.equal(req.body.messages[0].role, 'user');
  assert.equal(req.body.tools[0].name, 'bash');
  assert.ok(req.body.tools[0].input_schema.required.length > 0);
});

test('prompt：anthropic 方言的桩调用一样能转交', async () => {
  stub.scenario = 'anthropic-toolcall';
  const client = makeClient(stub);
  await client.start();
  await client.providers();
  const sessionID = await client.createSession();

  const result = await client.prompt({
    sessionID, modelID: 'minimax-style-free', system: '', text: '跑命令',
    handoff: (action) => action.native === 'bash' ? { name: 'Bash', arguments: { command: action.input.command } } : null,
  });
  assert.deepEqual(result.handoff, { name: 'Bash', arguments: { command: 'ls -la' } });
});

test('prompt：responses 方言——扁平工具、output_text/function_call 事件收齐', async () => {
  stub.scenario = 'responses-ok';
  const client = makeClient(stub);
  await client.start();
  await client.providers();
  const sessionID = await client.createSession();

  const result = await client.prompt({ sessionID, modelID: 'spark-free', system: '系统词', text: '你好' });
  assert.equal(result.text, '答案');
  assert.deepEqual(result.tokens, { input: 9, output: 2, cache: { read: 1, write: 0 }, reasoning: 4 });

  const req = stub.requests.find((r) => r.path === '/inference/v1/responses');
  assert.equal(req.headers.authorization, 'Bearer public');
  assert.equal(req.headers['x-api-key'], undefined);
  assert.equal(req.body.instructions, '系统词');
  assert.equal(req.body.input, '你好');
  assert.equal(req.body.tools[0].type, 'function');
  assert.equal(req.body.tools[0].name, 'bash');
});

test('prompt：responses 方言的桩调用转交', async () => {
  stub.scenario = 'responses-toolcall';
  const client = makeClient(stub);
  await client.start();
  await client.providers();
  const sessionID = await client.createSession();

  const result = await client.prompt({
    sessionID, modelID: 'spark-free', system: '', text: '读文件',
    handoff: (action) => action.native === 'read' ? { name: 'Read', arguments: { file_path: action.input.filePath } } : null,
  });
  assert.deepEqual(result.handoff, { name: 'Read', arguments: { file_path: '/tmp/b.txt' } });
  stub.scenario = 'chat-ok';
});

/* ------------------------------------------------------------------ */
/* 错误映射与杂项                                                        */
/* ------------------------------------------------------------------ */

test('错误映射：403/426/410/429 都翻成能看懂的人话', async () => {
  const client = makeClient(stub);
  await client.start();
  await client.providers();
  const sessionID = await client.createSession();

  const cases = [
    ['http-403', 'zen_forbidden', /免费|轮下线|内嵌/],
    ['http-426', 'zen_version_rejected', /OPENCODE_VERSION/],
    ['http-410', 'zen_model_deprecated', /弃用/],
    ['http-429', 'zen_rate_limited', /限流/],
  ];
  for (const [scenario, code, pattern] of cases) {
    stub.scenario = scenario;
    await assert.rejects(
      () => client.prompt({ sessionID, modelID: 'demo-free', system: '', text: 'hi' }),
      (error) => {
        assert.equal(error.code, code, scenario);
        assert.match(error.message, pattern, scenario);
        return true;
      },
    );
  }
  stub.scenario = 'chat-ok';
});

test('杂项：createSession 给真形状 ses_ id；deleteSession 无害；上下文覆盖明确拒绝', async () => {
  const client = makeClient(stub);
  await client.start();
  const sessionID = await client.createSession();
  assert.match(sessionID, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.match(sessionID, OPENCODE_ID_PATTERN);
  await client.deleteSession(sessionID);
  await assert.rejects(
    () => client.setModelContextWindows([]),
    (error) => error.code === 'context_window_unsupported_mode',
  );
  await client.stop();
  assert.equal(client.ready, false);
  assert.equal(client.isolate, false);
  assert.equal(client.baseUrl, `http://127.0.0.1:${stub.port}/inference/v1`);
});
