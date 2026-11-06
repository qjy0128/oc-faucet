/** 通用设置入口校验：只使用临时配置目录。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Bridge } from '../src/main.js';
import * as settings from '../src/settings.js';

async function withBridge(t) {
  const dir = await mkdtemp(join(tmpdir(), 'oc-bridge-settings-'));
  const saved = process.env.OCF_DATA_DIR;
  process.env.OCF_DATA_DIR = dir;
  const bridge = new Bridge({ log: () => {}, targets: [] });
  t.after(async () => {
    if (saved === undefined) delete process.env.OCF_DATA_DIR;
    else process.env.OCF_DATA_DIR = saved;
    await rm(dir, { recursive: true, force: true });
  });
  return bridge;
}

test('通用设置：并发范围外或非整数值拒绝且磁盘内容不变', async (t) => {
  const bridge = await withBridge(t);
  await settings.writeSettings({ probeConcurrency: 4, probeTtlMinutes: 45 });
  const before = await readFile(settings.settingsFile(), 'utf8');

  for (const value of [0, 7, 1.5, '3', Infinity]) {
    await assert.rejects(
      () => bridge.saveSettings({ probeConcurrency: value }),
      (error) => error.code === 'invalid_probe_concurrency',
    );
    assert.equal(await readFile(settings.settingsFile(), 'utf8'), before);
  }
});

test('通用设置：有效期必须为有限正数且非法值不落盘', async (t) => {
  const bridge = await withBridge(t);
  await settings.writeSettings({ probeConcurrency: 4, probeTtlMinutes: 45 });
  const before = await readFile(settings.settingsFile(), 'utf8');

  for (const value of [0, -1, Infinity, NaN, '60']) {
    await assert.rejects(
      () => bridge.saveSettings({ probeTtlMinutes: value }),
      (error) => error.code === 'invalid_probe_ttl',
    );
    assert.equal(await readFile(settings.settingsFile(), 'utf8'), before);
  }
});

test('通用设置：合法数字可保存，旧配置读取仍自动归一化', async (t) => {
  const bridge = await withBridge(t);
  const saved = await bridge.saveSettings({ probeConcurrency: 6, probeTtlMinutes: 0.5 });
  assert.equal(saved.probeConcurrency, 6);
  assert.equal(saved.probeTtlMinutes, 0.5);

  await writeFile(settings.settingsFile(), JSON.stringify({ probeConcurrency: 99, probeTtlMinutes: 0 }));
  const legacy = await settings.readSettings();
  assert.equal(legacy.probeConcurrency, 3);
  assert.equal(legacy.probeTtlMinutes, 360);
});
