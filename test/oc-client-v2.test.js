import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OcClient } from '../src/oc-client.js';
import { collectModels } from '../src/models.js';

const STUB_SOURCE = `#!${process.execPath}
import http from 'node:http';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
if (process.env.STUB_START_LOG) appendFileSync(process.env.STUB_START_LOG, JSON.stringify({ argv, home: process.env.HOME, configContent: process.env.OPENCODE_CONFIG_CONTENT ?? null }) + '\\n');
if (argv.includes('--version')) {
  console.log('opencode v2.2.0');
  process.exit(0);
}
if (argv.includes('--pure')) {
  console.error('Unrecognized flag: --pure');
  process.exit(1);
}
const port = Number(argv[argv.indexOf('--port') + 1]);
const sessions = new Map();
const permissions = new Map();
const eventClients = new Set();
const requests = [];
let sessionSeq = 0;
let permissionSeq = 0;
let reloads = 0;

function log(entry) {
  if (!process.env.STUB_LOG) return;
  appendFileSync(process.env.STUB_LOG, JSON.stringify(entry) + '\\n');
}
function send(res, status, body) {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}
function emit(event) {
  for (const res of eventClients) res.write('data: ' + JSON.stringify(event) + '\\n\\n');
}
function assistant(session, text = '第一段，第二段') {
  session.assistant = {
    id: 'msg_assistant_' + session.id,
    type: 'assistant',
    agent: 'oc-faucet',
    model: session.model,
    content: [{ type: 'text', text: text.slice(0, 3) }, { type: 'text', text: text.slice(3) }],
    tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now() },
  };
}
function permission(session) {
  const id = 'per_' + (++permissionSeq);
  const callID = 'call_' + permissionSeq;
  emit({ type: 'session.tool.input.started', sessionID: session.id, assistantMessageID: 'msg_a', id: callID, name: 'read' });
  emit({ type: 'session.tool.called', sessionID: session.id, assistantMessageID: 'msg_a', id: callID, input: { filePath: '/tmp/v2.txt' }, executed: false });
  permissions.set(id, { id, sessionID: session.id, action: 'read', resources: ['/tmp/v2.txt'], metadata: { callID }, replied: false });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch {}
    log({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
    const path = url.pathname;

    if (path === '/api/event' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      eventClients.add(res);
      res.on('close', () => eventClients.delete(res));
      return;
    }
    if (path === '/api/provider') return send(res, 200, { location: {}, data: [{ id: 'opencode', name: 'OpenCode' }] });
    const model = {
      id: 'demo-free', modelID: 'demo-free', providerID: 'opencode', name: 'Demo Free',
      capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
      variants: [{ id: 'low', settings: { reasoningEffort: 'low' } }, { id: 'high', settings: { reasoningEffort: 'high' } }],
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }], status: 'active', enabled: true,
      limit: { context: 200000, output: 32000 },
    };
    if (path === '/api/model') return send(res, 200, { location: {}, data: [model] });
    if (path === '/api/model/default') return send(res, 200, { location: {}, data: model });
    if (path === '/api/agent') return send(res, 200, { location: {}, data: [{ id: 'oc-faucet', name: 'OC Faucet' }] });
    if (path === '/api/session' && req.method === 'POST') {
      const id = 'ses_v2_' + (++sessionSeq);
      const session = { id, title: body?.title, agent: body?.agent, model: body?.model ?? null, assistant: null, interrupted: false };
      sessions.set(id, session);
      return send(res, 200, { data: session });
    }
    if (path === '/api/permission/request') {
      return send(res, 200, { location: {}, data: [...permissions.values()].filter((item) => !item.replied).map(({ replied, ...item }) => item) });
    }
    if (path === '/api/location/reload' && req.method === 'POST') {
      reloads += 1;
      return send(res, 204);
    }
    if (path === '/__reloads') return send(res, 200, { reloads });

    let match = new RegExp('^/api/session/([^/]+)$').exec(path);
    if (match && req.method === 'DELETE') {
      sessions.delete(decodeURIComponent(match[1]));
      return send(res, 204);
    }
    match = new RegExp('^/api/session/([^/]+)/model$').exec(path);
    if (match && req.method === 'POST') {
      const session = sessions.get(decodeURIComponent(match[1]));
      if (!session) return send(res, 404, { message: 'no session' });
      session.model = body.model;
      return send(res, 204);
    }
    match = new RegExp('^/api/session/([^/]+)/prompt$').exec(path);
    if (match && req.method === 'POST') {
      const session = sessions.get(decodeURIComponent(match[1]));
      if (!session) return send(res, 404, { message: 'no session' });
      session.prompt = body;
      if (body.text.includes('handoff')) {
        setTimeout(() => permission(session), 30);
      } else {
        setTimeout(() => assistant(session), 40);
      }
      return send(res, 200, { data: { id: 'msg_user', sessionID: session.id, type: 'user', payload: { text: body.text } } });
    }
    match = new RegExp('^/api/experimental/session/([^/]+)/wait$').exec(path);
    if (match && req.method === 'POST') {
      const session = sessions.get(decodeURIComponent(match[1]));
      if (!session) return send(res, 404, { message: 'no session' });
      const check = () => {
        if (session.assistant || session.interrupted) return send(res, 204);
        setTimeout(check, 10);
      };
      check();
      return;
    }
    match = new RegExp('^/api/session/([^/]+)/message$').exec(path);
    if (match && req.method === 'GET') {
      const session = sessions.get(decodeURIComponent(match[1]));
      if (!session) return send(res, 404, { message: 'no session' });
      const messages = session.assistant ? [session.assistant] : [];
      return send(res, 200, { data: messages, cursor: { previous: null, next: null } });
    }
    match = new RegExp('^/api/session/([^/]+)/permission/([^/]+)/reply$').exec(path);
    if (match && req.method === 'POST') {
      const permission = permissions.get(decodeURIComponent(match[2]));
      if (!permission) return send(res, 404, { message: 'no permission' });
      permission.replied = true;
      permission.reply = body;
      const session = sessions.get(permission.sessionID);
      if (body.decision === 'reject') setTimeout(() => { session.interrupted = true; }, 20);
      return send(res, 204);
    }
    match = new RegExp('^/api/session/([^/]+)/interrupt$').exec(path);
    if (match && req.method === 'POST') {
      const session = sessions.get(decodeURIComponent(match[1]));
      if (session) session.interrupted = true;
      return send(res, 200, { interrupted: true });
    }
    send(res, 404, { message: 'no route: ' + path });
  });
});
server.listen(port, '127.0.0.1', () => console.log('server listening on http://127.0.0.1:' + server.address().port));
process.on('SIGTERM', () => { server.close(); process.exit(0); });
`;

const stubDir = mkdtempSync(join(tmpdir(), 'oc-v2-stub-'));
const stubPath = join(stubDir, 'opencode');
writeFileSync(stubPath, STUB_SOURCE, 'utf8');
chmodSync(stubPath, 0o755);

function makeClient() {
  const dataDir = mkdtempSync(join(tmpdir(), 'oc-v2-data-'));
  const logPath = join(dataDir, 'requests.jsonl');
  const startLog = join(dataDir, 'starts.jsonl');
  const client = new OcClient({
    dataDir,
    opencodePath: stubPath,
    env: { STUB_LOG: logPath, STUB_START_LOG: startLog },
  });
  return { client, dataDir, logPath, startLog };
}

function requests(logPath) {
  try {
    return readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

test('v2 启动不带 --pure，模型与 agent 使用新 API 并保留隔离', async (t) => {
  const { client, dataDir, startLog } = makeClient();
  t.after(() => client.stop());
  await client.start();
  assert.equal(client.ready, true);

  const starts = readFileSync(startLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(client.apiMajor, 2);
  const serve = starts.find((entry) => entry.argv.includes('serve'));
  assert.equal(serve.argv.includes('--pure'), false);
  assert.equal(serve.home, join(dataDir, 'opencode', 'home'));
  assert.equal(serve.configContent, null);

  const payload = await client.providers();
  assert.equal(payload.providers[0].id, 'opencode');
  const models = collectModels(payload);
  assert.equal(models[0].id, 'opencode/demo-free');
  assert.equal(models[0].free, true);
  assert.equal(models[0].images, true);
  assert.equal(models[0].variants.low.reasoningEffort, 'low');
  assert.equal((await client.agents())[0].id, 'oc-faucet');
});

test('v2 提问走选模型、提交、等待和读取消息，并拼接正文与 token', async (t) => {
  const { client, logPath } = makeClient();
  t.after(() => client.stop());
  await client.start();
  const sessionID = await client.createSession({ title: 'v2 提问' });
  const result = await client.prompt({
    sessionID,
    providerID: 'opencode',
    modelID: 'demo-free',
    system: '系统指令',
    text: '请回答',
    variant: 'high',
  });
  assert.equal(result.text, '第一段，第二段');
  assert.equal(result.tokens.output, 20);

  const calls = requests(logPath);
  assert.equal(calls.find((entry) => entry.path === '/api/session').body.agent, 'oc-faucet');
  assert.deepEqual(calls.find((entry) => entry.path.endsWith('/model')).body, {
    model: { providerID: 'opencode', id: 'demo-free', variant: 'high' },
  });
  // v2 隔离模式下通过 bridge.js 的 context hook 注入 system，/prompt 只发纯净的用户输入
  assert.equal(calls.find((entry) => entry.path.endsWith('/prompt')).body.text, '请回答');
  assert.equal(readFileSync(join(client.runtimeRoot, 'session-systems', `${sessionID}.txt`), 'utf8'), '系统指令');
  const pluginSrc = readFileSync(join(client.runtimeRoot, 'config', 'opencode', 'plugins', 'bridge.js'), 'utf8');
  assert.match(pluginSrc, /session\.hook\('context'/);
  assert.match(pluginSrc, /execute\.before/);
  assert.ok(calls.some((entry) => entry.path.endsWith('/wait')));
  assert.ok(calls.some((entry) => entry.path.endsWith('/message') && entry.query.type === 'assistant'));
});

test('v2 工具事件、权限拒批与中断可以完成 handoff', async (t) => {
  const { client, logPath } = makeClient();
  t.after(() => client.stop());
  await client.start();
  const sessionID = await client.createSession();
  const result = await client.prompt({
    sessionID,
    providerID: 'opencode',
    modelID: 'demo-free',
    text: 'handoff',
    handoff: (action) => action.native === 'read'
      ? { name: 'Read', arguments: { file_path: action.input.filePath } }
      : null,
  });
  assert.deepEqual(result.handoff, { name: 'Read', arguments: { file_path: '/tmp/v2.txt' } });
  const calls = requests(logPath);
  const reply = calls.find((entry) => /\/permission\/[^/]+\/reply$/.test(entry.path));
  assert.equal(reply.body.decision, 'reject');
  assert.ok(calls.some((entry) => entry.path.endsWith('/interrupt')));
});

test('v2 上下文设置只写隔离配置并重载 location', async (t) => {
  const { client, dataDir } = makeClient();
  t.after(() => client.stop());
  await client.start();
  await client.setModelContextWindows([
    { modelID: 'demo-free', limit: { context: 128000, input: 100000, output: 32000 } },
  ]);
  const config = JSON.parse(readFileSync(join(dataDir, 'opencode', 'config', 'opencode', 'opencode.json'), 'utf8'));
  assert.deepEqual(config.provider.opencode.models['demo-free'].limit, {
    context: 128000, input: 100000, output: 32000,
  });
  const response = await fetch(`${client.baseUrl}/__reloads`);
  assert.equal((await response.json()).reloads, 1);
});

test('v2.2.7 SSE 嵌套 event.data 与 permission.asked(source.id) 兜底：/api/permission/request 返回空仍能转交拒批', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'oc-v2-sse-perm-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  const replies = [];
  const client = new OcClient({ dataDir });
  client.port = 43211;
  client.started = true;
  client.exited = false;
  client.apiMajor = 2;
  client._request = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path === '/api/permission/request') {
      // 模拟 macOS /var -> /private/var 目录不匹配时 HTTP 列表返回空数组
      return { ok: true, status: 200, json: { location: {}, data: [] } };
    }
    if (/\/permission\/[^/]+\/reply$/.test(path)) {
      replies.push({ path, body: options.body });
      return { ok: true, status: 200, json: {} };
    }
    throw new Error(`unexpected path: ${path}`);
  };

  let handedOff = null;
  const stop = client._handlePermissions('ses_real', {
    handoff: (action) => action.native === 'shell'
      ? { name: 'Bash', arguments: { command: action.input.command } }
      : null,
    onHandoff: (call) => { handedOff = call; },
    stats: { nativeBlocked: 0 },
  });

  // 真实 OpenCode v2.2.7 SSE 事件把载荷放在 event.data 里，工具 callID 在 source.id
  client._handleEvent({
    id: 'evt_1',
    type: 'session.tool.input.started',
    data: { sessionID: 'ses_real', assistantMessageID: 'msg_1', id: 'call_real_1', name: 'shell' },
  });
  client._handleEvent({
    id: 'evt_2',
    type: 'session.tool.called',
    data: { sessionID: 'ses_real', assistantMessageID: 'msg_1', id: 'call_real_1', input: { command: 'pwd' }, executed: false },
  });
  client._handleEvent({
    id: 'evt_3',
    type: 'permission.asked',
    data: {
      id: 'per_real_1',
      sessionID: 'ses_real',
      action: 'shell',
      resources: ['pwd'],
      source: { type: 'tool', messageID: 'msg_1', id: 'call_real_1' },
    },
  });

  for (let i = 0; i < 20 && !handedOff; i += 1) {
    await new Promise((r) => setTimeout(r, 50));
  }
  await stop();

  assert.deepEqual(handedOff, { name: 'Bash', arguments: { command: 'pwd' } });
  assert.equal(replies.length, 1);
  assert.equal(replies[0].body.decision, 'reject');
});
