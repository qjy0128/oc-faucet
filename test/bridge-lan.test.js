/**
 * 路由器广播（局域网访问）的接线测试：开关联动监听地址、热重绑保端口、
 * lanInfo 给齐地址/密钥/模型 id。真起转发口（临时目录 + 随机端口），不触上游。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

import { Bridge } from '../src/main.js';
import { createServer } from '../src/server.js';
import * as settings from '../src/settings.js';

const MODEL = {
  id: 'opencode/demo',
  providerID: 'opencode',
  modelID: 'demo',
  name: '演示模型',
  free: true,
  images: false,
  contextWindow: 1000,
};

function bridgeForTest() {
  const bridge = new Bridge({ log: () => {}, targets: [] });
  bridge.state.models = [MODEL];
  bridge.state.verdicts.set(MODEL.id, { verdict: 'tool', note: '' });
  return bridge;
}

/** 起一个真转发口（回环或全网卡），返回 {port, host} */
function listen(bridge, { lanAccess, port = 0 }) {
  const server = createServer({
    bridge,
    apiKey: bridge.state.apiKey ?? 'test-key',
    lanAccess,
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, lanAccess ? '0.0.0.0' : '127.0.0.1', () => {
      resolve({ server, port: server.address().port, host: server.address().address });
    });
  });
}

test('settings：lanAccess 默认关、只认布尔', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-lan-settings-'));
  const previous = process.env.OCF_DATA_DIR;
  process.env.OCF_DATA_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.OCF_DATA_DIR;
    else process.env.OCF_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });

  assert.equal((await settings.readSettings()).lanAccess, false, '默认只听本机');
  assert.equal((await settings.writeSettings({ lanAccess: true })).lanAccess, true);
  assert.equal((await settings.writeSettings({ lanAccess: 'yes' })).lanAccess, false, '非布尔回落默认');
});

test('setLanAccess：非布尔 400；服务没在跑时只落盘', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-lan-offline-'));
  const previous = process.env.OCF_DATA_DIR;
  process.env.OCF_DATA_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.OCF_DATA_DIR;
    else process.env.OCF_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  const bridge = bridgeForTest();

  await assert.rejects(() => bridge.setLanAccess('yes'), (error) => error.code === 'invalid_lan_access');
  assert.equal((await settings.readSettings()).lanAccess, false);

  const result = await bridge.setLanAccess(true);
  assert.deepEqual(result, { ok: true, lanAccess: true, changed: true });
  assert.equal((await settings.readSettings()).lanAccess, true);
  assert.equal(bridge.snapshot().lanAccess, true, '快照要带开关状态');
  // 幂等：同值再设不动盘
  const again = await bridge.setLanAccess(true);
  assert.equal(again.changed, false);
});

test('setLanAccess：热重绑——端口不变、监听地址切换、局域网真的能连进来', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-lan-rebind-'));
  const previous = process.env.OCF_DATA_DIR;
  process.env.OCF_DATA_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.OCF_DATA_DIR;
    else process.env.OCF_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });

  const bridge = bridgeForTest();
  bridge.state.apiKey = 'oc-lan-test-key';
  const { server, port } = await listen(bridge, { lanAccess: false });
  bridge.server = server;
  bridge.state.port = port;
  t.after(() => bridge.server?.closeAllConnections?.());

  // 开：端口不变，地址变 0.0.0.0
  const result = await bridge.setLanAccess(true);
  assert.equal(result.changed, true);
  assert.equal(bridge.server.address().address, '0.0.0.0', '开了要绑全网卡');
  assert.equal(bridge.state.port, port, '端口必须保持不变（换端口会害已写入工具集体 404）');

  // 局域网视角真的能连：不带 Origin、带对密钥 → 200
  const lan = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { 'x-api-key': 'oc-lan-test-key' } });
  assert.equal(lan.status, 200);
  // 浏览器围栏照旧：带 Origin 的一律 403（哪怕来自本机）
  const browser = await fetch(`http://127.0.0.1:${port}/v1/models`, {
    headers: { 'x-api-key': 'oc-lan-test-key', origin: 'http://evil.example' },
  });
  assert.equal(browser.status, 403);

  // 关：回到回环
  const off = await bridge.setLanAccess(false);
  assert.equal(off.changed, true);
  assert.equal(bridge.server.address().address, '127.0.0.1');
  assert.equal((await settings.readSettings()).lanAccess, false, '开关要落盘');
  // 先强拆连接再关：fetch 的 keep-alive 连接不主动断，close 会一直等
  await new Promise((resolve) => {
    bridge.server.closeAllConnections?.();
    bridge.server.close(resolve);
  });
});

test('setLanAccess：有请求在跑时 409 忙拒', async (t) => {
  const bridge = bridgeForTest();
  bridge.activePromptCount = 1;
  await assert.rejects(() => bridge.setLanAccess(true), (error) => error.code === 'lan_access_busy');
});

test('lanInfo：地址清单带 URL、密钥只走这条通道、模型 id 齐全', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-lan-info-'));
  const previous = process.env.OCF_DATA_DIR;
  process.env.OCF_DATA_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.OCF_DATA_DIR;
    else process.env.OCF_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });

  const bridge = bridgeForTest();
  bridge.state.apiKey = 'oc-info-key';
  const { server, port } = await listen(bridge, { lanAccess: true });
  bridge.server = server;
  bridge.state.port = port;
  bridge.state.lanAccess = true;
  t.after(() => bridge.server.close());

  const info = await bridge.lanInfo();
  assert.equal(info.apiKey, 'oc-info-key');
  assert.equal(info.port, port);
  assert.equal(info.lanAccess, true);
  assert.ok(info.modelIds.includes('opencode/demo'));
  assert.ok(Array.isArray(info.addresses));
  for (const entry of info.addresses) {
    assert.equal(entry.url, `http://${entry.address}:${port}`);
    assert.doesNotMatch(entry.address, /^127\.|0\.0\.0\.0/, '回环与通配地址不该出现在局域网清单里');
  }
  // 快照永远不带真密钥（apiKey 键存在但恒为 null）
  assert.equal(bridge.snapshot().apiKey, null);
  await new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  });
});
