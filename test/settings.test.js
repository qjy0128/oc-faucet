/**
 * 本机设置的读写测试。所有文件都放进临时目录，不读取用户真实配置。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as settings from '../src/settings.js';

test('设置：上下文覆盖默认为空，且只保留合法模型 id 和正安全整数', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-settings-'));
  const previousDataDir = process.env.OCF_DATA_DIR;
  process.env.OCF_DATA_DIR = dir;
  t.after(async () => {
    if (previousDataDir === undefined) delete process.env.OCF_DATA_DIR;
    else process.env.OCF_DATA_DIR = previousDataDir;
    await rm(dir, { recursive: true, force: true });
  });

  assert.deepEqual((await settings.readSettings()).modelContextWindows, {});

  const saved = await settings.writeSettings({
    modelContextWindows: {
      'opencode/demo': 1_000_000,
      'provider/model/with-slash': Number.MAX_SAFE_INTEGER,
      'bad-id': 9000,
      'opencode/zero': 0,
      'opencode/negative': -1,
      'opencode/fraction': 1.5,
      'opencode/unsafe': Number.MAX_SAFE_INTEGER + 1,
    },
  });

  assert.deepEqual(saved.modelContextWindows, {
    'opencode/demo': 1_000_000,
    'provider/model/with-slash': Number.MAX_SAFE_INTEGER,
  });
  assert.deepEqual((await settings.readSettings()).modelContextWindows, saved.modelContextWindows);

  const onDisk = JSON.parse(await readFile(settings.settingsFile(), 'utf8'));
  assert.deepEqual(onDisk.modelContextWindows, saved.modelContextWindows);
});

test('设置：待同步上下文保留恢复标记 null，丢弃非法内容', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-settings-context-pending-'));
  const previousDataDir = process.env.OCF_DATA_DIR;
  process.env.OCF_DATA_DIR = dir;
  t.after(async () => {
    if (previousDataDir === undefined) delete process.env.OCF_DATA_DIR;
    else process.env.OCF_DATA_DIR = previousDataDir;
    await rm(dir, { recursive: true, force: true });
  });

  const saved = await settings.writeSettings({
    modelContextWindowPending: {
      'opencode/restore': null,
      'opencode/set': 1_000_000,
      'bad-id': null,
      'opencode/zero': 0,
      'opencode/fraction': 2.5,
    },
  });

  assert.deepEqual(saved.modelContextWindowPending, {
    'opencode/restore': null,
    'opencode/set': 1_000_000,
  });
  assert.deepEqual((await settings.readSettings()).modelContextWindowPending, saved.modelContextWindowPending);
});

test('设置：按目标记住勾选的模型，非法内容丢掉、默认是空', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-settings-targets-'));
  const previousDataDir = process.env.OCF_DATA_DIR;
  process.env.OCF_DATA_DIR = dir;
  t.after(async () => {
    if (previousDataDir === undefined) delete process.env.OCF_DATA_DIR;
    else process.env.OCF_DATA_DIR = previousDataDir;
    await rm(dir, { recursive: true, force: true });
  });

  assert.deepEqual((await settings.readSettings()).targetModels, {});

  const saved = await settings.writeSettings({
    targetModels: {
      codex: ['opencode/a', 'opencode/b', 'opencode/a', '没有斜杠', 42, ''],
      claude: '不是数组',
      '': ['opencode/x'],
    },
  });

  assert.deepEqual(saved.targetModels, { codex: ['opencode/a', 'opencode/b'] });
  assert.deepEqual((await settings.readSettings()).targetModels, saved.targetModels);
});

test('设置：上游方案默认内嵌，只认 embedded/masquerade，非法值回落默认', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-settings-mode-'));
  const previousDataDir = process.env.OCF_DATA_DIR;
  process.env.OCF_DATA_DIR = dir;
  t.after(async () => {
    if (previousDataDir === undefined) delete process.env.OCF_DATA_DIR;
    else process.env.OCF_DATA_DIR = previousDataDir;
    await rm(dir, { recursive: true, force: true });
  });

  assert.equal((await settings.readSettings()).upstreamMode, 'embedded', '默认内嵌');

  const saved = await settings.writeSettings({ upstreamMode: 'masquerade' });
  assert.equal(saved.upstreamMode, 'masquerade');
  assert.equal((await settings.readSettings()).upstreamMode, 'masquerade');

  // 手改坏文件不许让服务起不来：非法值静默回落
  const bad = await settings.writeSettings({ upstreamMode: '随机方案' });
  assert.equal(bad.upstreamMode, 'embedded');
});
