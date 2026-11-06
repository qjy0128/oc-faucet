import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BunTransport } from '../src/zen-bun-transport.js';
import { BridgeError } from '../src/errors.js';

async function localServer() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        method: req.method,
        authorization: req.headers.authorization,
        body,
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('Bun 侧车转发请求并原样返回状态与正文', async (t) => {
  const server = await localServer();
  const transport = new BunTransport({ baseOrigin: server.origin });
  t.after(async () => {
    await transport.stop();
    await server.close();
  });

  await transport.start();
  const response = await transport.fetch(`${server.origin}/echo`, {
    method: 'POST',
    headers: { authorization: 'Bearer public', 'content-type': 'application/json' },
    body: '{"hello":"world"}',
  });
  assert.equal(response.status, 201);
  assert.deepEqual(JSON.parse(await response.text()), {
    method: 'POST',
    authorization: 'Bearer public',
    body: '{"hello":"world"}',
  });
});

test('Bun 侧车拒绝访问未授权 origin', async (t) => {
  const transport = new BunTransport({ baseOrigin: 'https://opencode.ai' });
  t.after(() => transport.stop());
  await transport.start();
  await assert.rejects(
    () => transport.fetch('http://127.0.0.1:1/fetch'),
    (error) => error instanceof BridgeError && error.code === 'bun_origin_rejected',
  );
});

test('Bun 侧车已就绪后意外退出会通知调用方', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-bun-exit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sidecar = join(dir, 'exit.js');
  await writeFile(sidecar, "console.log(JSON.stringify({ ready: true, url: 'http://127.0.0.1:43210' })); setTimeout(() => process.exit(23), 20);\n");
  const exits = [];
  let resolveExit;
  const exit = new Promise((resolve) => { resolveExit = resolve; });
  const transport = new BunTransport({
    baseOrigin: 'https://opencode.ai',
    bunPath: process.execPath,
    sidecarPath: sidecar,
    onExit: (detail) => { exits.push(detail); resolveExit(detail); },
  });
  t.after(() => transport.stop());

  await transport.start();
  const detail = await Promise.race([
    exit,
    new Promise((_, reject) => setTimeout(() => reject(new Error('侧车退出通知超时')), 2_000)),
  ]);

  assert.equal(detail.code, 23);
  assert.equal(transport.endpoint, null);
  assert.deepEqual(exits, [{ code: 23, signal: null }]);
});

test('主动停止 Bun 侧车不会触发意外退出通知', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-bun-stop-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sidecar = join(dir, 'stay.js');
  await writeFile(sidecar, "console.log(JSON.stringify({ ready: true, url: 'http://127.0.0.1:43211' })); setInterval(() => {}, 1000);\n");
  const exits = [];
  const transport = new BunTransport({
    baseOrigin: 'https://opencode.ai',
    bunPath: process.execPath,
    sidecarPath: sidecar,
    onExit: (detail) => exits.push(detail),
  });
  await transport.start();
  await transport.stop();

  assert.deepEqual(exits, []);
});
