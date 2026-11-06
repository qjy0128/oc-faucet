/** Bridge 启动恢复与上游状态测试：只用假客户端和临时目录。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

import { Bridge } from '../src/main.js';

function fakeClient({ onExit, startError } = {}) {
  return {
    ready: false,
    isolate: false,
    baseUrl: 'http://fake-upstream',
    async start() {
      if (startError) throw startError;
      this.ready = true;
    },
    async stop() {
      this.ready = false;
    },
    async providers() {
      return { providers: [] };
    },
    exit(code = 1) {
      this.ready = false;
      onExit?.({ code, signal: null });
    },
  };
}

async function withBridge(t, makeClient, port = '0', opencodePath) {
  const dir = await mkdtemp(join(tmpdir(), 'oc-bridge-recovery-'));
  const keys = ['OCF_DATA_DIR', 'OCF_PORT', 'OCF_ZCODE_CONFIG', 'OCF_ZCODE_BUILTIN', 'OCF_ZCODE_RUNTIME', 'OCF_OPENCODE_PATH', 'OCF_ISOLATE'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.OCF_DATA_DIR = dir;
  process.env.OCF_PORT = port;
  process.env.OCF_ZCODE_CONFIG = join(dir, 'zcode', 'provider_config.json');
  process.env.OCF_ZCODE_BUILTIN = join(dir, 'zcode', 'no-builtin.json');
  process.env.OCF_ZCODE_RUNTIME = join(dir, 'zcode', 'no-runtime');
  process.env.OCF_OPENCODE_PATH = opencodePath ?? join(dir, 'no-opencode');
  process.env.OCF_ISOLATE = '1';
  const bridge = new Bridge({ log: () => {}, targets: [], makeClient });
  t.after(async () => {
    await bridge.stop({ uninstall: false }).catch(() => {});
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });
  return bridge;
}

test('重启成功后清除上次启动错误并清空错误代号', async (t) => {
  let attempts = 0;
  const bridge = await withBridge(t, (_mode, options) => {
    attempts += 1;
    const error = attempts === 1 ? Object.assign(new Error('找不到 OpenCode'), { code: 'runtime_missing' }) : null;
    return fakeClient({ ...options, startError: error });
  });

  await assert.rejects(() => bridge.start(), /找不到 OpenCode/);
  assert.equal(bridge.snapshot().errorCode, 'runtime_missing');

  const snapshot = await bridge.restart();
  assert.equal(snapshot.phase, 'ready');
  assert.equal(snapshot.error, null);
  assert.equal(snapshot.errorCode, null);
  assert.equal(snapshot.upstream.ready, true);
});

test('启动失败的快照带错误代号且不能把已启动上游误报为就绪', async (t) => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const occupiedPort = blocker.address().port;
  t.after(() => new Promise((resolve) => blocker.close(resolve)));

  const bridge = await withBridge(t, () => fakeClient(), String(occupiedPort));
  await assert.rejects(() => bridge.start(), { code: 'EADDRINUSE' });

  const snapshot = bridge.snapshot();
  assert.equal(snapshot.phase, 'error');
  assert.equal(snapshot.errorCode, 'EADDRINUSE');
  assert.equal(snapshot.upstream.ready, false);
});

test('运行中的上游意外退出后快照标记断开，主动停服仍是已停止', async (t) => {
  let client;
  const bridge = await withBridge(t, (_mode, options) => {
    client = fakeClient(options);
    return client;
  });

  await bridge.start();
  client.exit(7);
  const disconnected = bridge.snapshot();
  assert.equal(disconnected.phase, 'error');
  assert.equal(disconnected.errorCode, 'upstream_disconnected');
  assert.equal(disconnected.upstream.ready, false);

  await bridge.stop({ uninstall: false });
  const stopped = bridge.snapshot();
  assert.equal(stopped.phase, 'idle');
  assert.equal(stopped.errorCode, null);
  assert.equal(stopped.upstream.ready, false);
});

test('启动恢复时 providers 导致上游退出，start 必须报断开错误', async (t) => {
  const bridge = await withBridge(t, (_mode, options) => {
    const client = fakeClient(options);
    const providers = client.providers.bind(client);
    client.providers = async () => {
      const result = await providers();
      client.exit(8);
      return result;
    };
    return client;
  });

  await assert.rejects(() => bridge.start(), { code: 'upstream_disconnected' });

  assert.equal(bridge.snapshot().phase, 'error');
  assert.equal(bridge.snapshot().errorCode, 'upstream_disconnected');
  assert.equal(bridge.snapshot().upstream.ready, false);
});

test('启动恢复目录读取失败但上游仍在线时保留原容错', async (t) => {
  const bridge = await withBridge(t, (_mode, options) => {
    const client = fakeClient(options);
    client.providers = async () => { throw new Error('模型目录读取失败'); };
    return client;
  });

  await bridge.start();

  assert.equal(bridge.snapshot().phase, 'ready');
  assert.equal(bridge.snapshot().error, null);
  assert.equal(bridge.snapshot().errorCode, null);
  assert.equal(bridge.snapshot().upstream.ready, true);
});

test('启动恢复等待 providers 时主动 stop，完成后取消且保留 idle 状态', async (t) => {
  let signalProvidersStarted;
  const providersStarted = new Promise((resolve) => { signalProvidersStarted = resolve; });
  let resolveProviders;
  const bridge = await withBridge(t, (_mode, options) => {
    const client = fakeClient(options);
    client.providers = () => new Promise((resolve) => {
      resolveProviders = resolve;
      signalProvidersStarted();
    });
    return client;
  });

  const starting = bridge.start().then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await providersStarted;
  await bridge.stop({ uninstall: false });
  resolveProviders({ providers: [] });
  const outcome = await starting;

  assert.equal(outcome.error?.code, 'operation_cancelled');
  assert.equal(bridge.snapshot().phase, 'idle');
  assert.equal(bridge.snapshot().error, null);
  assert.equal(bridge.snapshot().errorCode, null);
  assert.equal(bridge.snapshot().upstream.ready, false);
});

test('未运行时切方案说明需启动，热切换完成时不需要另行启动', async (t) => {
  const bridge = await withBridge(t, (mode, options) => fakeClient(options));
  const savedOnly = await bridge.setUpstreamMode('masquerade');
  assert.equal(savedOnly.requiresStart, true);

  await bridge.start();
  const hotSwitched = await bridge.setUpstreamMode('embedded');
  assert.equal(hotSwitched.requiresStart, false);
});

test('默认客户端工厂把 OpenCode 意外退出传到 Bridge 快照', async (t) => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'oc-bridge-fake-runtime-'));
  const opencodePath = join(runtimeDir, 'opencode');
  await writeFile(opencodePath, `#!${process.execPath}
import http from 'node:http';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('opencode v1.2.3'); process.exit(0); }
const port = Number(args[args.indexOf('--port') + 1]);
const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"providers":[]}'); });
server.listen(port, '127.0.0.1', () => console.log('listening on http://127.0.0.1:' + server.address().port));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`);
  await chmod(opencodePath, 0o755);
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));

  const bridge = await withBridge(t, undefined, '0', opencodePath);
  await bridge.start();
  const child = bridge.client.child;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exited;

  assert.equal(bridge.snapshot().errorCode, 'upstream_disconnected');
  assert.equal(bridge.snapshot().upstream.ready, false);
  assert.match(bridge.snapshot().error, /意外退出/);
});
