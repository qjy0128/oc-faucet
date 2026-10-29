import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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
