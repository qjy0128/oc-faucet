import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server.js';
import { BridgeError } from '../src/errors.js';

/**
 * server.js 的测试。
 *
 * 重点是它**自己**的逻辑：鉴权、浏览器围栏、路由、请求体限制、并发排队、错误映射、日志。
 * 协议翻译（Anthropic/OpenAI 形状）由 protocol.js 负责，这里注入一个最小替身，
 * 让两个模块的测试互不牵连。
 */

const API_KEY = 'oc-test-key-do-not-leak';

/** 最小协议替身：只做我们在意的形状转换，不碰真 protocol.js */
function fakeProtocol(overrides = {}) {
  return {
    prepareAnthropic: (body) => ({
      model: { id: body.model, providerID: 'opencode', modelID: body.model, name: body.model },
      text: '用户说了话',
      tools: [],
      choice: 'auto',
      forced: null,
      parallel: true,
      stream: Boolean(body.stream),
      maxTokens: 1024,
    }),
    prepareOpenAI: (body) => ({
      model: { id: body.model, providerID: 'opencode', modelID: body.model, name: body.model },
      text: '用户说了话',
      tools: [],
      choice: 'auto',
      forced: null,
      parallel: true,
      stream: Boolean(body.stream),
      maxTokens: 1024,
    }),
    toAnthropicResponse: (model, decoded) => ({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: model.id,
      content: [{ type: 'text', text: decoded.content }],
      stop_reason: decoded.calls?.length ? 'tool_use' : 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    toOpenAIResponse: (model, decoded) => ({
      id: 'chatcmpl_test',
      object: 'chat.completion',
      model: model.id,
      choices: [{ index: 0, message: { role: 'assistant', content: decoded.content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    sendAnthropicSSE: (res) => {
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      res.end();
    },
    sendOpenAISSE: (res) => {
      res.write('data: {"object":"chat.completion.chunk"}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    },
    prepareResponses: (body) => ({
      model: { id: body.model, providerID: 'opencode', modelID: body.model, name: body.model },
      text: '用户说了话',
      tools: [],
      choice: 'auto',
      forced: null,
      parallel: true,
      stream: Boolean(body.stream),
      maxTokens: 1024,
      namespaced: {},
    }),
    toResponsesResponse: (model, decoded) => ({
      id: 'resp_test',
      object: 'response',
      model: model.id,
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: decoded.content }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }),
    sendResponsesSSE: (res) => {
      res.write('data: {"type":"response.created"}\n\n');
      res.write('data: {"type":"response.completed"}\n\n');
      res.end();
    },
    tokenUsage: (tokens) => ({
      input: tokens?.input ?? 0,
      output: tokens?.output ?? 0,
      cacheRead: tokens?.cache?.read ?? 0,
      cacheWrite: tokens?.cache?.write ?? 0,
      reasoning: tokens?.reasoning ?? 0,
    }),
    ...overrides,
  };
}

/** 默认的假 bridge：一个模型、回复固定内容 */
function fakeBridge(overrides = {}) {
  return {
    getModels: async () => [{ id: 'opencode/free-model', providerID: 'opencode', modelID: 'free-model', name: 'free-model' }],
    complete: async () => ({
      model: { id: 'opencode/free-model', providerID: 'opencode', modelID: 'free-model', name: 'free-model' },
      decoded: { content: '这是模型的回答', calls: [] },
      tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 5, write: 0 } },
    }),
    ...overrides,
  };
}

/** 起一个服务器，用完自动关掉 */
async function withServer(options, fn) {
  const server = createServer({ apiKey: API_KEY, log: () => {}, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base, server);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const auth = { 'x-api-key': API_KEY, 'content-type': 'application/json' };

/* ---------------- 鉴权与围栏 ---------------- */

test('没有密钥 → 401', async () => {
  await withServer({ bridge: fakeBridge(), protocol: fakeProtocol() }, async (base) => {
    for (const path of ['/health', '/v1/models', '/v1/messages', '/v1/chat/completions', '/v1/responses']) {
      const isCompletion = path !== '/health' && path !== '/v1/models';
      const res = await fetch(`${base}${path}`, {
        method: isCompletion ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json' },
        body: isCompletion ? '{}' : undefined,
      });
      assert.equal(res.status, 401, `${path} 应该要求密钥`);
    }
  });
});

test('密钥错误 → 401；密钥正确 → 通', async () => {
  await withServer({ bridge: fakeBridge(), protocol: fakeProtocol() }, async (base) => {
    const bad = await fetch(`${base}/v1/models`, { headers: { 'x-api-key': 'wrong-key' } });
    assert.equal(bad.status, 401);

    const good = await fetch(`${base}/v1/models`, { headers: auth });
    assert.equal(good.status, 200);
    const body = await good.json();
    assert.equal(body.object, 'list');
    assert.equal(body.data[0].id, 'opencode/free-model');
  });
});

test('Authorization: Bearer 也能鉴权', async () => {
  await withServer({ bridge: fakeBridge(), protocol: fakeProtocol() }, async (base) => {
    const res = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${API_KEY}` } });
    assert.equal(res.status, 200);
  });
});

/* ---------------- 运行时换密钥 ---------------- */

test('运行时换密钥：旧 key 立刻 401、新 key 立刻 200，进程不重启', async () => {
  await withServer({ bridge: fakeBridge(), protocol: fakeProtocol() }, async (base, server) => {
    const before = await fetch(`${base}/v1/models`, { headers: auth });
    assert.equal(before.status, 200, '换之前旧密钥当然能用');

    server.setApiKey('oc-brand-new-key');

    const oldKey = await fetch(`${base}/v1/models`, { headers: auth });
    assert.equal(oldKey.status, 401, '旧密钥必须立刻作废');
    const newKey = await fetch(`${base}/v1/models`, { headers: { 'x-api-key': 'oc-brand-new-key' } });
    assert.equal(newKey.status, 200, '新密钥必须立刻生效——同一个进程、同一个端口');
    // Bearer 形态也认新密钥
    const bearer = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer oc-brand-new-key' } });
    assert.equal(bearer.status, 200);
  });
});

test('setApiKey 拒绝空密钥，原密钥不受影响', async () => {
  await withServer({ bridge: fakeBridge(), protocol: fakeProtocol() }, async (base, server) => {
    assert.throws(() => server.setApiKey(''), /密钥/);
    assert.throws(() => server.setApiKey('   '), /密钥/);
    assert.throws(() => server.setApiKey(123), /密钥/);
    assert.equal((await fetch(`${base}/v1/models`, { headers: auth })).status, 200);
  });
});

test('换密钥之后，日志照样抹掉新密钥', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-log-rekey-'));
  await withServer({ bridge: fakeBridge(), protocol: fakeProtocol(), dataDir: dir }, async (base, server) => {
    server.setApiKey('oc-new-secret-12345');
    const res = await fetch(`${base}/v1/models`, { headers: { 'x-api-key': 'oc-new-secret-12345' } });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 60));

    const text = await readFile(join(dir, 'requests.jsonl'), 'utf8');
    assert.doesNotMatch(text, /oc-new-secret-12345/, '新密钥也不许出现在日志里');
  });
});

test('带 Origin 的请求 → 403，哪怕密钥是对的', async () => {
  await withServer({ bridge: fakeBridge(), protocol: fakeProtocol() }, async (base) => {
    const res = await fetch(`${base}/v1/models`, { headers: { ...auth, origin: 'https://evil.example.com' } });
    assert.equal(res.status, 403, '浏览器来的请求必须被挡住');
    const body = await res.json();
    assert.equal(body.error.type, 'browser_not_allowed');
  });
});

test('createServer 缺键或缺 bridge 时拒绝启动', async () => {
  assert.throws(() => createServer({ apiKey: API_KEY }), /bridge/);
  assert.throws(() => createServer({ bridge: fakeBridge(), apiKey: '' }), /apiKey/);
});

/* ---------------- 路由 ---------------- */

test('未知路由 → 404 JSON', async () => {
  await withServer({ bridge: fakeBridge(), protocol: fakeProtocol() }, async (base) => {
    const res = await fetch(`${base}/v1/不存在的路径`, { headers: auth });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.type, 'error');
  });
});

test('GET /health 返回就绪状态与模型数', async () => {
  await withServer({ bridge: fakeBridge(), protocol: fakeProtocol() }, async (base) => {
    const res = await fetch(`${base}/health`, { headers: auth });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.models, 1);
    assert.ok(typeof body.uptimeMs === 'number');
  });
});

test('Anthropic 非流式：返回 message 形状', async () => {
  await withServer({ bridge: fakeBridge(), protocol: fakeProtocol() }, async (base) => {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'opencode/free-model', messages: [{ role: 'user', content: '你好' }] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.type, 'message');
    assert.equal(body.content[0].text, '这是模型的回答');
    assert.equal(body.stop_reason, 'end_turn');
  });
});

test('OpenAI 非流式：返回 chat.completion 形状', async () => {
  await withServer({ bridge: fakeBridge(), protocol: fakeProtocol() }, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'opencode/free-model', messages: [{ role: 'user', content: '你好' }] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.choices[0].message.content, '这是模型的回答');
  });
});

test('Responses 非流式：走 /v1/responses，并把 protocol 标成 responses', async () => {
  const seen = [];
  const bridge = fakeBridge({
    complete: async (o) => {
      seen.push(o.protocol);
      return {
        model: { id: 'opencode/free-model' },
        decoded: { content: '这是模型的回答', calls: [] },
        tokens: { input: 100, output: 20 },
      };
    },
  });
  await withServer({ bridge, protocol: fakeProtocol() }, async (base) => {
    const res = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'opencode/free-model', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '你好' }] }] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.object, 'response');
    assert.equal(body.status, 'completed');
    assert.deepEqual(seen, ['responses']);
  });
});

test('Responses 流式：SSE 由 sendResponsesSSE 收尾', async () => {
  await withServer({ bridge: fakeBridge(), protocol: fakeProtocol() }, async (base) => {
    const res = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'opencode/free-model', stream: true, input: '你好' }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const text = await res.text();
    assert.match(text, /"type":"response.created"/);
    assert.match(text, /"type":"response.completed"/);
  });
});

test('流式：Content-Type 是 text/event-stream 且分片能读出来', async () => {
  await withServer({ bridge: fakeBridge(), protocol: fakeProtocol() }, async (base) => {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'opencode/free-model', stream: true, messages: [{ role: 'user', content: '你好' }] }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const text = await res.text();
    assert.match(text, /event: message_start/);
    assert.match(text, /event: message_stop/);
  });
});

test('count_tokens 按 4 字符 ≈ 1 token 粗算', async () => {
  await withServer({ bridge: fakeBridge(), protocol: fakeProtocol() }, async (base) => {
    const res = await fetch(`${base}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: '一二三四五六七八' }] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.input_tokens >= 2, `至少该算出 2 个 token，实际 ${body.input_tokens}`);
  });
});

/* ---------------- 请求体限制 ---------------- */

test('请求体不是合法 JSON → 400 invalid_json', async () => {
  await withServer({ bridge: fakeBridge(), protocol: fakeProtocol() }, async (base) => {
    const res = await fetch(`${base}/v1/messages`, { method: 'POST', headers: auth, body: '{ 这不是 JSON' });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.type, 'invalid_json');
  });
});

test('请求体超过上限 → 413', async () => {
  await withServer({ bridge: fakeBridge(), protocol: fakeProtocol(), maxBodyBytes: 1024 }, async (base) => {
    const huge = JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'x'.repeat(4000) }] });
    const res = await fetch(`${base}/v1/messages`, { method: 'POST', headers: auth, body: huge });
    assert.equal(res.status, 413);
  });
});

/* ---------------- 错误映射 ---------------- */

test('bridge 抛 BridgeError → 按它的状态码和代号返回', async () => {
  const bridge = fakeBridge({
    complete: async () => {
      throw new BridgeError('找不到模型 opencode/nope', 400, 'model_not_found');
    },
  });
  await withServer({ bridge, protocol: fakeProtocol() }, async (base) => {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'opencode/nope', messages: [{ role: 'user', content: '嗨' }] }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.type, 'error');
    assert.equal(body.error.type, 'model_not_found');
    assert.match(body.error.message, /找不到模型/);
  });
});

test('bridge 抛普通 Error → 500，且不泄漏堆栈', async () => {
  const bridge = fakeBridge({
    complete: async () => {
      throw new Error('内部数据库连接字符串 postgres://user:pw@host/db');
    },
  });
  await withServer({ bridge, protocol: fakeProtocol() }, async (base) => {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'opencode/free-model', messages: [{ role: 'user', content: '嗨' }] }),
    });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error.type, 'internal_error');
    // 内部细节不该原样抛给客户端
    assert.doesNotMatch(body.error.message, /postgres:\/\//);
  });
});

/* ---------------- 并发排队 ---------------- */

test('并发上限为 1 时，第二个请求要排在第一个之后', async () => {
  let active = 0;
  let maxActive = 0;
  let seq = 0;
  const order = [];
  const bridge = fakeBridge({
    complete: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const n = ++seq;
      order.push(`start${n}`);
      await new Promise((r) => setTimeout(r, 120));
      active -= 1;
      order.push(`end${n}`);
      return {
        model: { id: 'opencode/free-model', providerID: 'opencode', modelID: 'free-model', name: 'free-model' },
        decoded: { content: '好', calls: [] },
        tokens: null,
      };
    },
  });

  await withServer({ bridge, protocol: fakeProtocol(), concurrency: 1 }, async (base) => {
    const call = () =>
      fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ model: 'opencode/free-model', messages: [{ role: 'user', content: '嗨' }] }),
      });
    const [a, b] = await Promise.all([call(), call()]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(maxActive, 1, '同一时刻只能有一个上游请求');
    assert.deepEqual(order, ['start1', 'end1', 'start2', 'end2'], `实际顺序：${order.join(',')}`);
  });
});

test('并发上限为 2 时确实能并行', async () => {
  let active = 0;
  let maxActive = 0;
  const bridge = fakeBridge({
    complete: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 100));
      active -= 1;
      return {
        model: { id: 'opencode/free-model', providerID: 'opencode', modelID: 'free-model', name: 'free-model' },
        decoded: { content: '好', calls: [] },
        tokens: null,
      };
    },
  });

  await withServer({ bridge, protocol: fakeProtocol(), concurrency: 2 }, async (base) => {
    const call = () =>
      fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ model: 'opencode/free-model', messages: [{ role: 'user', content: '嗨' }] }),
      });
    await Promise.all([call(), call()]);
    assert.equal(maxActive, 2, '应该有两个请求同时在跑');
  });
});

/* ---------------- 日志 ---------------- */

test('requests.jsonl 会落盘，且里面没有密钥', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-log-'));
  await withServer({ bridge: fakeBridge(), protocol: fakeProtocol(), dataDir: dir }, async (base) => {
    await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'opencode/free-model', messages: [{ role: 'user', content: '你好' }] }),
    });
    // 日志是同步写的，但给它一点余量
    await new Promise((r) => setTimeout(r, 60));

    const text = await readFile(join(dir, 'requests.jsonl'), 'utf8');
    assert.ok(text.trim().length > 0, '应该写了至少一行');
    assert.doesNotMatch(text, new RegExp(API_KEY), '日志里绝不能出现密钥');

    const entry = JSON.parse(text.trim().split('\n')[0]);
    assert.equal(entry.model, 'opencode/free-model');
    assert.equal(entry.status, 200);
    assert.equal(entry.protocol, 'anthropic');
    assert.ok(typeof entry.elapsedMs === 'number');
  });
});

test('上游失败时也会记一行，带上错误代号', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-log-err-'));
  const bridge = fakeBridge({
    complete: async () => {
      throw new BridgeError('上游超时了', 504, 'upstream_timeout');
    },
  });
  await withServer({ bridge, protocol: fakeProtocol(), dataDir: dir }, async (base) => {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'opencode/free-model', messages: [{ role: 'user', content: '嗨' }] }),
    });
    assert.equal(res.status, 504);
    await new Promise((r) => setTimeout(r, 60));

    const text = await readFile(join(dir, 'requests.jsonl'), 'utf8');
    const entry = JSON.parse(text.trim().split('\n')[0]);
    assert.equal(entry.status, 504);
    assert.equal(entry.error, 'upstream_timeout');
  });
});

test('协议模块缺函数时明确报错，不是静默返回空', async () => {
  await withServer({ bridge: fakeBridge(), protocol: fakeProtocol({ sendOpenAISSE: undefined }) }, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'opencode/free-model', messages: [{ role: 'user', content: '嗨' }] }),
    });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.match(body.error.message, /不完整/);
  });
});
