/**
 * oc-client.js 的测试。
 *
 * 纪律：**不碰真 OpenCode**。这里起一个 `node:http` 假服务器冒充 opencode，
 * 它照着实测到的真实返回形状回话（包括各种出错的形状）。
 * 全程只连 127.0.0.1，不访问公网。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OcClient } from '../src/oc-client.js';
import { BridgeError } from '../src/errors.js';

/* ------------------------------------------------------------------ */
/* 假 opencode：一个能顶替 `opencode serve` 的可执行脚本                */
/* ------------------------------------------------------------------ */

/**
 * 这个脚本的行为由**消息内容和环境变量**驱动，测试想模拟哪种情况就发哪种消息：
 *   - modelID = 'missing-model' : HTTP 500 + {name:'UnknownError',data:{...}}（实测形状）
 *   - modelID = 'info-error'    : HTTP 200 但 info.error 非空
 *   - modelID = 'no-parts'      : HTTP 200 但没有任何 text / step-finish
 *   - 文本里含 __SLOW__          : 一直不回，用来测超时
 *   - 会话 id 不存在             : HTTP 404 + {name:'NotFoundError',data:{...}}（实测形状）
 * 另外把收到的每个请求追加写进 STUB_LOG（JSONL），方便断言请求体形状。
 */
const STUB_SOURCE = `#!${process.execPath}
import http from 'node:http';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const portIdx = argv.indexOf('--port');
const requestedPort = portIdx >= 0 ? Number(argv[portIdx + 1]) : 0;
const host = '127.0.0.1';

if (process.env.STUB_EXIT_IMMEDIATELY === '1') {
  console.log('simulating immediate crash');
  process.exit(7);
}

// 用来验证"换端口重试"：前 N 次启动故意立刻退出，第 N+1 次才正常服务
if (process.env.STUB_ATTEMPT_FILE) {
  let attempts = 0;
  try { attempts = Number(readFileSync(process.env.STUB_ATTEMPT_FILE, 'utf8')) || 0; } catch {}
  attempts += 1;
  try { writeFileSync(process.env.STUB_ATTEMPT_FILE, String(attempts)); } catch {}
  const failFirst = Number(process.env.STUB_FAIL_FIRST || 0);
  if (attempts <= failFirst) {
    console.log('simulating failure on attempt ' + attempts);
    process.exit(9);
  }
}

const sessions = new Map();
let seq = 0;
/** 运行时可切换的开关：测试先正常 start()，再打开它模拟上游出故障 */
const flags = { failProviders: false };

// 「模型真调工具」的彩排：permission-model 的消息会挂一条 read 审批，被拒批后才作答
const permissions = new Map();
let permSeq = 0;

// 事件总线（/event SSE）：真实 OpenCode 里工具 part 事件比审批先到，且在途 part
// 用 HTTP 列消息查不到——所以转交只能靠这条流通名传参。backlog 让晚连上的客户端也能回放。
const eventClients = new Set();
const eventBacklog = [];
function emitEvent(obj) {
  eventBacklog.push(obj);
  if (eventBacklog.length > 50) eventBacklog.shift();
  for (const client of eventClients) {
    try { client.write('data:' + JSON.stringify(obj) + '\\n\\n'); } catch {}
  }
}

// 转交彩排状态：哪些会话被 abort 过；每个会话落过哪些消息（供 ?limit=1 查 token）
const abortedSessions = new Set();
const messageLog = new Map();
function recordMessage(sessionID, payload) {
  if (!messageLog.has(sessionID)) messageLog.set(sessionID, []);
  messageLog.get(sessionID).push(payload);
}

const PROVIDERS = {
  providers: [
    {
      id: 'opencode',
      name: 'opencode',
      models: {
        'deepseek-v4.1-flash-free': {
          id: 'deepseek-v4.1-flash-free',
          name: 'DeepSeek V4.1 Flash Free',
          capabilities: { reasoning: true, attachment: true, input: { image: true } },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: 200000, output: 32000 },
          status: 'active',
          variants: {},
        },
      },
    },
  ],
  default: { opencode: 'deepseek-v4.1-flash-free' },
};

function logRequest(entry) {
  if (!process.env.STUB_LOG) return;
  try { appendFileSync(process.env.STUB_LOG, JSON.stringify(entry) + '\\n'); } catch {}
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : null) } catch { resolve(raw) }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + host);
  const path = url.pathname;
  const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : null;
  logRequest({ method: req.method, path, body });

  if (path === '/config/providers') {
    if (flags.failProviders) {
      send(res, 500, { name: 'UnknownError', data: { message: 'providers exploded', ref: 'err_x' } });
      return;
    }
    send(res, 200, PROVIDERS);
    return;
  }

  // 测试用后门：让测试在 start() 之后再打开故障开关
  if (path === '/__flags' && req.method === 'POST') {
    Object.assign(flags, body || {});
    send(res, 200, { ok: true, flags });
    return;
  }

  if (path === '/agent') {
    send(res, 200, [{ name: 'build', description: '默认', mode: 'primary', native: true }]);
    return;
  }

  if (path === '/permission' && req.method === 'GET') {
    send(res, 200, [...permissions.values()].filter((p) => !p.replied));
    return;
  }

  // SSE 事件流：连上先回放积压事件，然后保持连接等新事件
  if (path === '/event' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    for (const e of eventBacklog) res.write('data:' + JSON.stringify(e) + '\\n\\n');
    eventClients.add(res);
    req.on('close', () => { eventClients.delete(res); });
    return;
  }

  // 让在途回合收尾（转交命中后客户端会调它）
  const abortMatch = /^\\/session\\/([^/]+)\\/abort$/.exec(path);
  if (abortMatch && req.method === 'POST') {
    abortedSessions.add(decodeURIComponent(abortMatch[1]));
    send(res, 200, {});
    return;
  }

  // 会话消息列表（转交回合的 token 从这里捞最后一条助手消息）
  const listMatch = /^\\/session\\/([^/]+)\\/message$/.exec(path);
  if (listMatch && req.method === 'GET') {
    send(res, 200, messageLog.get(decodeURIComponent(listMatch[1])) ?? []);
    return;
  }

  const permReply = /^\\/permission\\/([^/]+)\\/reply$/.exec(path);
  if (permReply && req.method === 'POST') {
    const p = permissions.get(decodeURIComponent(permReply[1]));
    if (!p) {
      send(res, 404, { name: 'NotFoundError', data: { message: 'no such permission' } });
      return;
    }
    p.replied = true;
    p.replyBody = body;
    send(res, 200, {});
    return;
  }

  if (path === '/session' && req.method === 'POST') {
    seq += 1;
    const id = 'ses_stub_' + seq;
    sessions.set(id, { id, title: body && body.title });
    send(res, 200, { id, title: (body && body.title) || 'stub', time: { created: Date.now() } });
    return;
  }

  const delMatch = /^\\/session\\/([^/]+)$/.exec(path);
  if (delMatch && req.method === 'DELETE') {
    const id = decodeURIComponent(delMatch[1]);
    if (!sessions.has(id)) {
      send(res, 404, { name: 'NotFoundError', data: { message: 'Session not found: ' + id } });
      return;
    }
    sessions.delete(id);
    send(res, 200, {});
    return;
  }

  const msgMatch = /^\\/session\\/([^/]+)\\/message$/.exec(path);
  if (msgMatch && req.method === 'POST') {
    const id = decodeURIComponent(msgMatch[1]);
    if (!sessions.has(id)) {
      send(res, 404, { name: 'NotFoundError', data: { message: 'Session not found: ' + id } });
      return;
    }

    const modelID = body && body.model && body.model.modelID;
    const text = String((body && body.parts && body.parts[0] && body.parts[0].text) || '');

    if (modelID === 'missing-model') {
      send(res, 500, { name: 'UnknownError', data: { message: 'Unexpected server error. Check server logs for details.', ref: 'err_stub' } });
      return;
    }

    if (modelID === 'info-error') {
      send(res, 200, {
        info: { id: 'msg_bad', role: 'assistant', error: { name: 'ProviderError', data: { message: '上游额度用完了' } } },
        parts: [],
      });
      return;
    }

    if (modelID === 'no-parts') {
      send(res, 200, { info: { id: 'msg_empty', role: 'assistant' }, parts: [{ type: 'step-start' }] });
      return;
    }

    if (modelID === 'permission-model') {
      permSeq += 1;
      const permId = 'per_stub_' + permSeq;
      permissions.set(permId, { id: permId, sessionID: id, permission: 'read', patterns: ['/tmp/x'], metadata: {} });
      // 审批没人答就一直挂着不回——和真实 OpenCode 等批准一样；被拒后按信封格式作答
      const deadline = Date.now() + 15000;
      while (!permissions.get(permId).replied && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!permissions.get(permId).replied) {
        send(res, 500, { name: 'TestError', data: { message: '审批没被拒掉，回合挂住了' } });
        return;
      }
      send(res, 200, {
        info: { id: 'msg_perm', role: 'assistant', providerID: 'opencode', modelID },
        parts: [
          { type: 'text', text: '{"content":"无法调用工具，改为文字回答","calls":[]}' },
          { type: 'step-finish', reason: 'stop', tokens: { total: 3, input: 1, output: 2 } },
        ],
      });
      return;
    }

    // 转交彩排：工具 part 事件先到（callID 带参数），审批后到（载荷带 tool.callID）。
    // handoff-metadata-model 的 part 参数故意留空，参数要从审批 metadata 兜底。
    if (modelID === 'handoff-model' || modelID === 'handoff-metadata-model') {
      permSeq += 1;
      const callID = 'call_h_' + permSeq;
      const permId = 'per_stub_h_' + permSeq;
      const fromMetadata = modelID === 'handoff-metadata-model';
      emitEvent({
        type: 'message.part.updated',
        properties: {
          sessionID: id,
          part: {
            type: 'tool',
            callID,
            tool: 'read',
            state: { status: 'pending', input: fromMetadata ? {} : { filePath: '/tmp/target.txt' } },
          },
        },
      });
      permissions.set(permId, {
        id: permId,
        sessionID: id,
        permission: 'read',
        metadata: fromMetadata ? { filepath: '/tmp/from-metadata.txt' } : {},
        tool: { callID },
      });
      const deadline = Date.now() + 15000;
      while (!permissions.get(permId).replied && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!permissions.get(permId).replied) {
        send(res, 500, { name: 'TestError', data: { message: '审批没被拒掉，回合挂住了' } });
        return;
      }
      // 转交式拒批 → 客户端会来 abort，等它到了再收尾（回合被掐断，没有正文）；
      // 纠正性拒批 → 模型「回到信封」继续作答。
      if (String(permissions.get(permId).replyBody?.message || '').includes('转交')) {
        const abortDeadline = Date.now() + 10000;
        while (!abortedSessions.has(id) && Date.now() < abortDeadline) {
          await new Promise((r) => setTimeout(r, 50));
        }
        const payload = {
          info: { id: 'msg_handoff', role: 'assistant', providerID: 'opencode', modelID, tokens: { total: 7, input: 3, output: 4 } },
          parts: [],
        };
        recordMessage(id, payload);
        send(res, 200, payload);
        return;
      }
      const payload = {
        info: { id: 'msg_perm', role: 'assistant', providerID: 'opencode', modelID },
        parts: [
          { type: 'text', text: '{"content":"无法调用工具，改为文字回答","calls":[]}' },
          { type: 'step-finish', reason: 'stop', tokens: { total: 3, input: 1, output: 2 } },
        ],
      };
      recordMessage(id, payload);
      send(res, 200, payload);
      return;
    }

    if (text.includes('__SLOW__')) {
      // 故意不回，用来测超时；客户端断开时不写响应
      return;
    }

    // 正常回复：两个 step、三个 text part，中间夹一个非 text part
    // token 必须取**最后一个** step-finish
    send(res, 200, {
      info: { id: 'msg_ok', role: 'assistant', providerID: 'opencode', modelID: modelID },
      parts: [
        { type: 'step-start' },
        { type: 'text', text: '第一段' },
        { type: 'tool-call', tool: 'x' },
        { type: 'text', text: '，第二段' },
        { type: 'step-finish', reason: 'continue', tokens: { input: 10, output: 20, cache: { read: 1, write: 2 } } },
        { type: 'step-start' },
        { type: 'text', text: '。第三段' },
        { type: 'step-finish', reason: 'stop', tokens: { total: 42, input: 100, output: 200, reasoning: 5, cache: { read: 3, write: 4 } } },
      ],
    });
    return;
  }

  send(res, 404, { name: 'NotFoundError', data: { message: 'no route: ' + path } });
});

server.listen(requestedPort, host, () => {
  const actual = server.address().port;
  console.log('Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.');
  console.log('opencode server listening on http://' + host + ':' + actual);
});

if (process.env.STUB_IGNORE_SIGTERM === '1') {
  process.on('SIGTERM', () => { console.log('stub ignoring SIGTERM'); });
} else {
  process.on('SIGTERM', () => { server.close(); process.exit(0); });
}
`;

/** 每个测试文件只建一次假 opencode 目录 */
const stubDir = mkdtempSync(join(tmpdir(), 'oc-stub-'));
const STUB_PATH = join(stubDir, 'opencode');
writeFileSync(STUB_PATH, STUB_SOURCE, 'utf8');
chmodSync(STUB_PATH, 0o755);

/** 造一个数据目录 + 一个配好假 opencode 的客户端 */
let dataSeq = 0;
function makeClient({ env = {}, ...rest } = {}) {
  dataSeq += 1;
  const dataDir = mkdtempSync(join(tmpdir(), `oc-data-${dataSeq}-`));
  const logPath = join(dataDir, 'requests.jsonl');
  const client = new OcClient({
    dataDir,
    opencodePath: STUB_PATH,
    ...rest,
    // env 放在最后：假服务器总得拿到 STUB_LOG，测试补的开关也不能被吞掉
    env: { STUB_LOG: logPath, ...env },
  });
  return { client, dataDir, logPath };
}

/** 拨动假服务器上的运行时开关（start() 之后再调） */
async function setFlags(client, flags) {
  const res = await fetch(`${client.baseUrl}/__flags`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(flags),
  });
  assert.equal(res.status, 200);
}

/** 读假服务器记下的请求（JSONL） */
function readRequests(logPath) {
  try {
    return readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

test('setModelContextWindows：只发隔离配置 PATCH 和 dispose，并保留 input 缺省', async () => {
  const client = new OcClient({ dataDir: join(tmpdir(), 'oc-fake-context-client') });
  client.port = 43210;
  const requests = [];
  client._request = async (url, options = {}) => {
    requests.push({ path: new URL(url).pathname, options });
    return { ok: true, status: 200, json: {} };
  };

  await client.setModelContextWindows([
    { modelID: 'demo', limit: { context: 1_000_000, output: 32_000 } },
    { modelID: 'zero-input', limit: { context: 1_000_000, input: 0, output: 32_000 } },
  ]);

  assert.deepEqual(requests.map(({ path, options }) => [path, options.method]), [
    ['/global/config', 'PATCH'],
    ['/global/dispose', 'POST'],
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0].options.body)), {
    provider: {
      opencode: {
        models: {
          demo: { limit: { context: 1_000_000, output: 32_000 } },
          'zero-input': { limit: { context: 1_000_000, input: 0, output: 32_000 } },
        },
      },
    },
  });
});

test('setModelContextWindows：PATCH 被拒绝时不执行 dispose，也不报成功', async () => {
  const client = new OcClient({ dataDir: join(tmpdir(), 'oc-fake-context-reject') });
  client.port = 43211;
  const paths = [];
  client._request = async (url) => {
    paths.push(new URL(url).pathname);
    return { ok: false, status: 400, json: { message: 'bad limit' }, text: '' };
  };

  await assert.rejects(
    () => client.setModelContextWindows([
      { modelID: 'demo', limit: { context: 1_000_000, output: 32_000 } },
    ]),
    (error) => error.code === 'upstream_config_error',
  );
  assert.deepEqual(paths, ['/global/config']);
});

/** 进程是否还活着 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 等到条件成立或超时 */
async function waitFor(predicate, { timeoutMs = 5_000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/** 断言错误是预期的 BridgeError */
function assertBridgeError(error, { status, code }) {
  assert.ok(error instanceof BridgeError, `应该是 BridgeError，实际是 ${error?.name}: ${error?.message}`);
  if (status !== undefined) assert.equal(error.status, status, `status 应为 ${status}，实际 ${error.status}（${error.message}）`);
  if (code !== undefined) assert.equal(error.code, code, `code 应为 ${code}，实际 ${error.code}（${error.message}）`);
}

/* ------------------------------------------------------------------ */
/* 未启动时的状态                                                       */
/* ------------------------------------------------------------------ */

test('未 start 时：ready 为 false，baseUrl 抛 upstream_not_ready', () => {
  const { client } = makeClient();
  assert.equal(client.ready, false);
  assert.throws(() => client.baseUrl, (error) => {
    assertBridgeError(error, { status: 503, code: 'upstream_not_ready' });
    return true;
  });
});

test('构造时不给 dataDir 直接抛错', () => {
  assert.throws(() => new OcClient({}), (error) => {
    assertBridgeError(error, { status: 400, code: 'invalid_request' });
    return true;
  });
});

/* ------------------------------------------------------------------ */
/* start / 基本只读接口                                                 */
/* ------------------------------------------------------------------ */

test('start：起假 opencode，ready 变 true，providers/agents 能拿到东西', async (t) => {
  const { client } = makeClient();
  t.after(() => client.stop());

  assert.equal(client.ready, false);
  await client.start();
  assert.equal(client.ready, true);
  assert.match(client.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);

  const providers = await client.providers();
  assert.ok(Array.isArray(providers.providers));
  assert.equal(providers.providers[0].id, 'opencode');

  const agents = await client.agents();
  assert.ok(Array.isArray(agents));
  assert.equal(agents[0].name, 'build');
});

test('start：重复调用是幂等的，不会多起进程', async (t) => {
  const { client } = makeClient();
  t.after(() => client.stop());

  await client.start();
  const firstPid = client.child.pid;
  const baseUrl = client.baseUrl;

  await client.start();
  assert.equal(client.child.pid, firstPid, '不该另起一个进程');
  assert.equal(client.baseUrl, baseUrl, '端口不该变');
});

test('start：并发调用只起一次', async (t) => {
  const { client } = makeClient();
  t.after(() => client.stop());

  await Promise.all([client.start(), client.start(), client.start()]);
  assert.equal(client.ready, true);
  assert.equal(isAlive(client.child.pid), true);
});

test('providers：上游报错时抛 upstream_error', async (t) => {
  const { client } = makeClient();
  t.after(() => client.stop());
  await client.start(); // 先正常起来
  await setFlags(client, { failProviders: true }); // 再让它坏掉

  await assert.rejects(() => client.providers(), (error) => {
    assertBridgeError(error, { status: 502, code: 'upstream_error' });
    assert.match(error.message, /providers exploded/);
    return true;
  });
});

test('start：子进程立刻退出时报 upstream_not_ready，且不留孤儿', async () => {
  const { client } = makeClient({ env: { STUB_EXIT_IMMEDIATELY: '1' } });

  await assert.rejects(() => client.start(), (error) => {
    assertBridgeError(error, { status: 500, code: 'upstream_not_ready' });
    return true;
  });

  assert.equal(client.ready, false);
  assert.equal(client.child, null, '启动失败必须把子进程收干净');
});

/* ------------------------------------------------------------------ */
/* prompt                                                              */
/* ------------------------------------------------------------------ */

test('prompt：多个 text part 按顺序全部拼接，token 取最后一个 step-finish', async (t) => {
  const { client, logPath } = makeClient();
  t.after(() => client.stop());
  await client.start();

  const sessionID = await client.createSession({ title: '拼接测试' });
  const result = await client.prompt({
    sessionID,
    providerID: 'opencode',
    modelID: 'deepseek-v4.1-flash-free',
    system: '你是测试助手。',
    text: '数三下',
  });

  assert.equal(result.text, '第一段，第二段。第三段', '三个 text part 都要按顺序拼上');
  assert.deepEqual(result.tokens, {
    total: 42,
    input: 100,
    output: 200,
    reasoning: 5,
    cache: { read: 3, write: 4 },
  }, 'token 要取最后一个 step-finish');

  // 请求体形状必须和契约一致
  const sent = readRequests(logPath).filter((r) => r.path.endsWith('/message'));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body, {
    model: { providerID: 'opencode', modelID: 'deepseek-v4.1-flash-free' },
    system: '你是测试助手。',
    parts: [{ type: 'text', text: '数三下' }],
    // tools:{} 仍要带上（契约形状；它并不真关工具，真拦截靠 ask + 自动拒批）
    tools: {},
  });
});

test('prompt：模型真调工具挂了审批时，客户端自动拒批，回合不挂死', async (t) => {
  const { client, logPath } = makeClient();
  t.after(() => client.stop());
  await client.start();

  const sessionID = await client.createSession({ title: '拒批测试' });
  const result = await client.prompt({
    sessionID,
    providerID: 'opencode',
    modelID: 'permission-model',
    text: '读一下文件',
    timeoutMs: 20_000,
  });

  // 桩服务器只在审批被拒后才作答：能拿到结果就是拒批生效的证据
  assert.equal(result.text, '{"content":"无法调用工具，改为文字回答","calls":[]}', '被拒后模型退回文字作答，回合正常结束');
  assert.equal(result.nativeBlocked, 1, '拦下的本机调用要计数——体检据此识别"会调工具"的模型');
  const replies = readRequests(logPath).filter((r) => r.path.includes('/permission/') && r.path.endsWith('/reply'));
  assert.equal(replies.length, 1, '审批要被拒掉一次');
  assert.equal(replies[0].body.reply, 'reject');
});

test('prompt 转交：模型真调工具 → 拦下翻译成客户端调用直接当答案', async (t) => {
  const { client, logPath } = makeClient();
  t.after(() => client.stop());
  await client.start();

  const sessionID = await client.createSession({ title: '转交测试' });
  const result = await client.prompt({
    sessionID,
    providerID: 'opencode',
    modelID: 'handoff-model',
    text: '读一下文件',
    timeoutMs: 20_000,
    handoff: ({ native, input }) =>
      native === 'read' ? { name: 'Read', arguments: { file_path: input.filePath } } : null,
  });

  // 被拦的 read 直接变成客户端的 Read 调用，不再等模型复述
  assert.deepEqual(result.handoff, { name: 'Read', arguments: { file_path: '/tmp/target.txt' } });
  assert.equal(result.text, '');
  // token 从会话里最后一条助手消息尽力捞回来
  assert.deepEqual(result.tokens, { total: 7, input: 3, output: 4 });

  const requests = readRequests(logPath);
  const replies = requests.filter((r) => r.path.includes('/permission/') && r.path.endsWith('/reply'));
  assert.equal(replies.length, 1, '审批要被拒掉一次（转交式拒批）');
  assert.equal(replies[0].body.reply, 'reject');
  assert.match(replies[0].body.message, /转交/);
  // 回合在服务端被 abort 收尾
  const aborts = requests.filter((r) => r.method === 'POST' && r.path.endsWith('/abort'));
  assert.equal(aborts.length, 1, '转交命中后要让回合收尾');
});

test('prompt 转交：工具 part 的参数为空时，从审批 metadata 兜底', async (t) => {
  const { client } = makeClient();
  t.after(() => client.stop());
  await client.start();

  const sessionID = await client.createSession({ title: 'metadata 兜底' });
  const result = await client.prompt({
    sessionID,
    providerID: 'opencode',
    modelID: 'handoff-metadata-model',
    text: '读一下文件',
    timeoutMs: 20_000,
    handoff: ({ input }) =>
      input.filePath === '/tmp/from-metadata.txt'
        ? { name: 'Read', arguments: { file_path: input.filePath } }
        : null,
  });

  assert.deepEqual(result.handoff, { name: 'Read', arguments: { file_path: '/tmp/from-metadata.txt' } });
});

test('prompt 转交：翻译不出时退回纠正性拒批，模型继续按信封作答', async (t) => {
  const { client, logPath } = makeClient();
  t.after(() => client.stop());
  await client.start();

  const sessionID = await client.createSession({ title: '翻译失败' });
  const result = await client.prompt({
    sessionID,
    providerID: 'opencode',
    modelID: 'handoff-model',
    text: '读一下文件',
    timeoutMs: 20_000,
    handoff: () => null, // 客户端没申报能对上的工具
  });

  assert.equal(result.handoff, null, '翻不了就不转交');
  assert.equal(result.text, '{"content":"无法调用工具，改为文字回答","calls":[]}', '模型退回信封作答');

  const requests = readRequests(logPath);
  const replies = requests.filter((r) => r.path.includes('/permission/') && r.path.endsWith('/reply'));
  assert.equal(replies.length, 1);
  assert.doesNotMatch(replies[0].body.message, /转交/);
  // 纠正性拒批要点名工具：含糊的拒绝会逼模型反复瞎试本地执行
  assert.match(replies[0].body.message, /read/);
  assert.match(replies[0].body.message, /calls/);
  // 没转交就不该 abort：模型还要继续把回合说完
  const aborts = requests.filter((r) => r.method === 'POST' && r.path.endsWith('/abort'));
  assert.equal(aborts.length, 0);
});

test('prompt 转交：不带回调时纯拒批，行为与从前一致', async (t) => {
  const { client, logPath } = makeClient();
  t.after(() => client.stop());
  await client.start();

  const sessionID = await client.createSession({ title: '无回调' });
  const result = await client.prompt({
    sessionID,
    providerID: 'opencode',
    modelID: 'handoff-model',
    text: '读一下文件',
    timeoutMs: 20_000,
  });

  assert.equal(result.handoff, null);
  assert.equal(result.text, '{"content":"无法调用工具，改为文字回答","calls":[]}');
  const replies = readRequests(logPath).filter((r) => r.path.includes('/permission/') && r.path.endsWith('/reply'));
  assert.equal(replies.length, 1);
  assert.match(replies[0].body.message, /此环境不执行任何本机动作/);
});

test('prompt：没有 system 时不塞空 system 字段', async (t) => {
  const { client, logPath } = makeClient();
  t.after(() => client.stop());
  await client.start();

  const sessionID = await client.createSession();
  await client.prompt({
    sessionID,
    providerID: 'opencode',
    modelID: 'deepseek-v4.1-flash-free',
    text: 'hi',
  });

  const sent = readRequests(logPath).filter((r) => r.path.endsWith('/message'));
  assert.equal('system' in sent[0].body, false);
  assert.deepEqual(sent[0].body.tools, {});
});

test('prompt：info.error 非空时抛 upstream_error 并带上可读信息', async (t) => {
  const { client } = makeClient();
  t.after(() => client.stop());
  await client.start();

  const sessionID = await client.createSession();
  await assert.rejects(
    () => client.prompt({ sessionID, providerID: 'opencode', modelID: 'info-error', text: 'hi' }),
    (error) => {
      assertBridgeError(error, { status: 502, code: 'upstream_error' });
      assert.match(error.message, /上游额度用完了/);
      return true;
    },
  );
});

test('prompt：上游 HTTP 500 时抛 upstream_error（不能静默返回空文本）', async (t) => {
  const { client } = makeClient();
  t.after(() => client.stop());
  await client.start();

  const sessionID = await client.createSession();
  await assert.rejects(
    () => client.prompt({ sessionID, providerID: 'opencode', modelID: 'missing-model', text: 'hi' }),
    (error) => {
      assertBridgeError(error, { status: 502, code: 'upstream_error' });
      // 实测形状：{name:'UnknownError',data:{message,ref}} —— 两样都要带出来
      assert.match(error.message, /UnknownError/);
      assert.match(error.message, /Unexpected server error/);
      assert.match(error.message, /err_stub/);
      return true;
    },
  );
});

test('prompt：会话不存在（404）抛 session_not_found', async (t) => {
  const { client } = makeClient();
  t.after(() => client.stop());
  await client.start();

  await assert.rejects(
    () =>
      client.prompt({
        sessionID: 'ses_从来没有过',
        providerID: 'opencode',
        modelID: 'deepseek-v4.1-flash-free',
        text: 'hi',
      }),
    (error) => {
      assertBridgeError(error, { status: 502, code: 'session_not_found' });
      assert.match(error.message, /Session not found/);
      return true;
    },
  );
});

test('prompt：超时抛 504 upstream_timeout', async (t) => {
  const { client } = makeClient();
  t.after(() => client.stop());
  await client.start();

  const sessionID = await client.createSession();
  const started = Date.now();
  await assert.rejects(
    () =>
      client.prompt({
        sessionID,
        providerID: 'opencode',
        modelID: 'deepseek-v4.1-flash-free',
        text: '__SLOW__ 别回我',
        timeoutMs: 300,
      }),
    (error) => {
      assertBridgeError(error, { status: 504, code: 'upstream_timeout' });
      assert.match(error.message, /超时|秒/);
      return true;
    },
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 250 && elapsed < 3_000, `该在 300ms 左右超时，实际 ${elapsed}ms`);
});

test('prompt：调用方自己取消时，不当成上游超时', async (t) => {
  const { client } = makeClient();
  t.after(() => client.stop());
  await client.start();

  const sessionID = await client.createSession();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);

  await assert.rejects(
    () =>
      client.prompt({
        sessionID,
        providerID: 'opencode',
        modelID: 'deepseek-v4.1-flash-free',
        text: '__SLOW__ 别回我',
        timeoutMs: 10_000,
        signal: controller.signal,
      }),
    (error) => {
      assertBridgeError(error, { status: 499, code: 'client_closed_request' });
      return true;
    },
  );
});

test('prompt：没有 text part / 没有 step-finish 时给空串和 null', async (t) => {
  const { client } = makeClient();
  t.after(() => client.stop());
  await client.start();

  const sessionID = await client.createSession();
  const result = await client.prompt({
    sessionID,
    providerID: 'opencode',
    modelID: 'no-parts',
    text: 'hi',
  });
  assert.equal(result.text, '');
  assert.equal(result.tokens, null);
});

test('prompt：连不上上游时抛 upstream_unreachable', async () => {
  // 让客户端以为服务在某个没人监听的端口上
  const { client } = makeClient();
  client.port = 1;
  client.started = true;

  await assert.rejects(
    () => client.prompt({ sessionID: 'ses_x', providerID: 'p', modelID: 'm', text: 'hi' }),
    (error) => {
      assertBridgeError(error, { status: 502, code: 'upstream_unreachable' });
      return true;
    },
  );
});

/* ------------------------------------------------------------------ */
/* 会话                                                                */
/* ------------------------------------------------------------------ */

test('createSession：拿到 ses_ 开头的 id；deleteSession 之后会话真的没了', async (t) => {
  const { client } = makeClient();
  t.after(() => client.stop());
  await client.start();

  const sessionID = await client.createSession({ title: '我的会话' });
  assert.match(sessionID, /^ses_/);

  await client.deleteSession(sessionID);

  // 删掉之后再发消息应该是 404 → session_not_found
  await assert.rejects(
    () => client.prompt({ sessionID, providerID: 'opencode', modelID: 'deepseek-v4.1-flash-free', text: 'hi' }),
    (error) => {
      assertBridgeError(error, { code: 'session_not_found' });
      return true;
    },
  );
});

test('deleteSession：失败只记日志，不抛异常', async (t) => {
  const { client } = makeClient();
  t.after(() => client.stop());
  await client.start();

  await client.deleteSession('ses_根本不存在'); // 不该抛
  await client.deleteSession('ses_再来一次'); // 幂等

  // 上游整个挂了也不该抛
  await client.stop();
  await client.deleteSession('ses_服务都没了');
});

/* ------------------------------------------------------------------ */
/* stop                                                                */
/* ------------------------------------------------------------------ */

test('stop：进程真的退出，且 repeated stop 幂等', async (t) => {
  const { client } = makeClient();
  await client.start();

  const pid = client.child.pid;
  assert.equal(isAlive(pid), true);

  await client.stop();
  assert.equal(isAlive(pid), false, 'stop 之后进程必须真的没了');
  assert.equal(client.ready, false);
  assert.equal(client.child, null);

  // 再停两次都不该抛
  await client.stop();
  await client.stop();
});

test('stop：没 start 过也能安全调用', async () => {
  const { client } = makeClient();
  await client.stop();
  await client.stop();
  assert.equal(client.ready, false);
});

test('stop：重复 stop 并发调用只收一次尸', async (t) => {
  const { client } = makeClient();
  await client.start();
  const pid = client.child.pid;

  await Promise.all([client.stop(), client.stop(), client.stop()]);
  assert.equal(isAlive(pid), false);
});

test('stop：进程已经死了也不该卡住', async (t) => {
  const { client } = makeClient();
  await client.start();
  const pid = client.child.pid;

  process.kill(pid, 'SIGKILL');
  // 等它真的死透
  await waitFor(() => !isAlive(pid), { timeoutMs: 3_000 });

  const started = Date.now();
  await client.stop();
  assert.ok(Date.now() - started < 2_000, '已经死了的进程不该让我们等满 3 秒');
  assert.equal(client.ready, false);
});

test('stop：进程不理 SIGTERM 时，SIGKILL 兜底把它干掉', async (t) => {
  const { client } = makeClient({ env: { STUB_IGNORE_SIGTERM: '1' } });
  await client.start();

  const pid = client.child.pid;
  assert.equal(isAlive(pid), true);

  const started = Date.now();
  await client.stop();
  const elapsed = Date.now() - started;

  assert.equal(isAlive(pid), false, 'SIGKILL 之后进程必须没了');
  assert.ok(elapsed >= 2_800, `该等满 3 秒宽限期，实际 ${elapsed}ms`);
  assert.ok(elapsed < 10_000, `不该无限等下去，实际 ${elapsed}ms`);
});

/* ------------------------------------------------------------------ */
/* 找不到 opencode                                                     */
/* ------------------------------------------------------------------ */

test('start：日志里的端口和我们传的不一致时，跟随日志里的真实端口', async (t) => {
  // 这个假 opencode 会把 --port 收到的值原样忽略掉、自己绑一个随机端口，
  // 只在日志里报出真实端口——客户端必须能跟上。
  const logOnlyPath = join(stubDir, 'opencode-logs-only');
  writeFileSync(logOnlyPath, STUB_SOURCE.replace(
    'server.listen(requestedPort, host, () => {',
    'server.listen(0, host, () => {',
  ), 'utf8');
  chmodSync(logOnlyPath, 0o755);

  const { client } = makeClient();
  client.opencodePath = logOnlyPath;

  const logs = [];
  client.onLog = (line) => logs.push(line);

  await client.start();
  t.after(() => client.stop());

  // 从日志里把真实端口抠出来，客户端必须跟到这个端口上
  const listening = logs.find((line) => line.includes('server listening on'));
  assert.ok(listening, `日志里应该有监听信息，实际日志：${JSON.stringify(logs)}`);
  const loggedPort = Number(/listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(listening)[1]);

  assert.equal(client.ready, true);
  assert.equal(Number(client.port), loggedPort, '必须跟随日志里的真实端口，而不是我们请求的那个');
});

test('start：自动选端口时启动失败会换端口重试一次', async (t) => {
  const attemptFile = join(stubDir, 'attempts.txt');
  writeFileSync(attemptFile, '0');

  const { client } = makeClient({
    env: { STUB_ATTEMPT_FILE: attemptFile, STUB_FAIL_FIRST: '1' },
  });
  // 不指定 port → 走自动选端口 + 失败重试的逻辑
  delete client.requestedPort;
  client.requestedPort = 0;

  const logs = [];
  client.onLog = (line) => logs.push(line);

  await client.start();
  t.after(() => client.stop());

  assert.equal(client.ready, true, '第一次失败后应该换端口重试成功');
  assert.equal(readFileSync(attemptFile, 'utf8'), '2', '应该正好起了两次');
  assert.ok(
    logs.some((line) => line.includes('换一个端口再试一次')),
    '日志里应该留下换端口重试的痕迹',
  );
});

test('start：没有 opencode 时抛 runtime_missing，并说清找过哪些路径', async (t) => {
  // 把家里和 PATH 都指到空目录，确保按契约的发现顺序一个都找不到
  const emptyHome = mkdtempSync(join(tmpdir(), 'oc-empty-home-'));
  const emptyBin = mkdtempSync(join(tmpdir(), 'oc-empty-bin-'));

  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  const savedOzPath = process.env.OCF_OPENCODE_PATH;

  process.env.HOME = emptyHome;
  process.env.PATH = emptyBin;
  delete process.env.OCF_OPENCODE_PATH;

  const { client } = makeClient();
  client.opencodePath = undefined;

  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    if (savedOzPath !== undefined) process.env.OCF_OPENCODE_PATH = savedOzPath;
  });

  await assert.rejects(() => client.start(), (error) => {
    assertBridgeError(error, { status: 500, code: 'runtime_missing' });
    // 消息里必须带上找过的地方，方便用户自己排查
    assert.match(error.message, /opencode/);
    assert.match(error.message, new RegExp(emptyBin));
    return true;
  });

  assert.equal(client.child, null);
  assert.equal(client.ready, false);
});

test('start：显式路径不存在时退到 OCF_OPENCODE_PATH', async (t) => {
  const saved = process.env.OCF_OPENCODE_PATH;
  process.env.OCF_OPENCODE_PATH = STUB_PATH;
  t.after(() => {
    if (saved === undefined) delete process.env.OCF_OPENCODE_PATH;
    else process.env.OCF_OPENCODE_PATH = saved;
  });

  const { client } = makeClient();
  // 显式给的路径不存在，应该按契约顺序退到环境变量
  client.opencodePath = join(stubDir, '这个文件不存在');

  await client.start();
  t.after(() => client.stop());
  assert.equal(client.ready, true);
  assert.match(client.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test('start：没有显式路径和环境变量时，去 ~/.opencode/bin/opencode 找', async (t) => {
  // 造一个假的家目录，里面放好 .opencode/bin/opencode
  const fakeHome = mkdtempSync(join(tmpdir(), 'oc-fake-home-'));
  const fakeBinDir = join(fakeHome, '.opencode', 'bin');
  mkdirSync(fakeBinDir, { recursive: true });
  const homedOpencode = join(fakeBinDir, 'opencode');
  writeFileSync(homedOpencode, STUB_SOURCE, 'utf8');
  chmodSync(homedOpencode, 0o755);

  const savedHome = process.env.HOME;
  const savedOzPath = process.env.OCF_OPENCODE_PATH;
  process.env.HOME = fakeHome; // os.homedir() 认这个
  delete process.env.OCF_OPENCODE_PATH;

  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedOzPath !== undefined) process.env.OCF_OPENCODE_PATH = savedOzPath;
  });

  const { client } = makeClient();
  client.opencodePath = undefined; // 不显式指定，走自动发现

  await client.start();
  t.after(() => client.stop());

  // 复用一个数据目录没问题，但要确认起的是家目录里那个假 opencode
  const providers = await client.providers();
  assert.ok(Array.isArray(providers.providers));
  assert.equal(client.ready, true);
});
