/** OpenCode 自动更新测试：版本比较、registry 拉取、官方升级命令、编排状态机。全部离线（依赖注入），绝不真升级。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAutoUpdater,
  fetchLatestOpencodeVersion,
  isNewerVersion,
  readOpencodeVersion,
  upgradeOpencode,
} from '../src/opencode-update.js';
import { Bridge } from '../src/main.js';
import * as settings from '../src/settings.js';

/** 造一个假 opencode 可执行：--version 打版本串，upgrade 时打一行并落一个标记文件 */
async function fakeOpencode(t, { version = '2.3.0', upgradeOutput = 'upgraded', upgradeExit = 0 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'oc-upd-'));
  const bin = join(dir, 'opencode');
  await writeFile(bin, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo "opencode v' + version + '"; exit 0; fi',
    'if [ "$1" = "upgrade" ]; then echo "' + upgradeOutput + '"; echo marker >> "' + join(dir, 'upgraded-marker') + '"; exit ' + upgradeExit + '; fi',
    'exit 1',
    '',
  ].join('\n'));
  await chmod(bin, 0o755);
  t.after(() => import('node:fs').then(({ rmSync }) => rmSync(dir, { recursive: true, force: true })));
  return { bin, dir };
}

test('isNewerVersion：逐段数字比较，读不出一律不算新', () => {
  assert.equal(isNewerVersion('2.3.1', '2.3.0'), true);
  assert.equal(isNewerVersion('2.10.0', '2.9.9'), true, '字符串比较会错，必须按数字段');
  assert.equal(isNewerVersion('3.0', '2.99.99'), true);
  assert.equal(isNewerVersion('2.3.0', '2.3.0'), false);
  assert.equal(isNewerVersion('2.3.0', '2.3.1'), false);
  assert.equal(isNewerVersion(null, '2.3.0'), false);
  assert.equal(isNewerVersion('2.4.0', null), false);
});

test('fetchLatestOpencodeVersion：拿 version 字段；非 2xx / 坏 JSON / 缺字段都返回 null', async () => {
  const ok = await fetchLatestOpencodeVersion({
    fetchImpl: async () => ({ ok: true, json: async () => ({ version: '2.4.0' }) }),
  });
  assert.equal(ok, '2.4.0');

  assert.equal(await fetchLatestOpencodeVersion({
    fetchImpl: async () => ({ ok: false, status: 500 }),
  }), null);
  assert.equal(await fetchLatestOpencodeVersion({
    fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }),
  }), null);
  assert.equal(await fetchLatestOpencodeVersion({
    fetchImpl: async () => ({ ok: true, json: async () => ({ version: 'not-semver' }) }),
  }), null);
});

test('readOpencodeVersion：解析 --version 的完整版本串；失败返回 null', async (t) => {
  const { bin } = await fakeOpencode(t, { version: '2.3.7' });
  assert.equal(await readOpencodeVersion(bin), '2.3.7');
  assert.equal(await readOpencodeVersion(bin + '-nope'), null);
});

test('upgradeOpencode：官方命令退出 0 视为成功，非 0 带回输出', async (t) => {
  const good = await fakeOpencode(t, { upgradeOutput: 'OpenCode upgraded to 2.4.0' });
  const result = await upgradeOpencode(good.bin);
  assert.equal(result.ok, true);
  assert.match(result.output, /upgraded to 2\.4\.0/);

  const bad = await fakeOpencode(t, { upgradeExit: 3, upgradeOutput: 'boom' });
  const failed = await upgradeOpencode(bad.bin);
  assert.equal(failed.ok, false);
  assert.match(failed.output, /boom/);
  assert.match(failed.output, /退出码 3/);
});

test('createAutoUpdater：已是最新 → 不升级不重启', async () => {
  const events = [];
  const updater = createAutoUpdater({
    locate: () => ({ path: '/fake/opencode', explicit: false }),
    readVersion: async () => '2.3.0',
    fetchLatest: async () => '2.3.0',
    upgrade: async () => { events.push('upgrade'); return { ok: true, output: '' }; },
    onUpgraded: async () => { events.push('restart'); },
    log: (line) => events.push(line),
    intervalMs: 60_000,
  });
  updater.schedule(0);
  await new Promise((resolve) => setTimeout(resolve, 50));
  updater.cancel();
  assert.equal(updater.state.status, 'latest');
  assert.deepEqual(events, []);
});

test('createAutoUpdater：有新版 → 升级、复核版本、回调重启', async () => {
  const events = [];
  let current = '2.3.0';
  const updater = createAutoUpdater({
    locate: () => ({ path: '/fake/opencode', explicit: false }),
    readVersion: async () => current,
    fetchLatest: async () => '2.4.0',
    upgrade: async () => { current = '2.4.0'; return { ok: true, output: 'upgraded' }; },
    onUpgraded: async () => { events.push('restart'); },
    log: (line) => events.push(line),
    intervalMs: 60_000,
  });
  updater.schedule(0);
  await new Promise((resolve) => setTimeout(resolve, 50));
  updater.cancel();
  assert.equal(updater.state.status, 'upgraded');
  assert.equal(updater.state.version, '2.4.0');
  assert.ok(events.includes('restart'), '升级成功后要回调重启');
  assert.equal(events.filter((item) => item === 'restart').length, 1, '重启只回调一次');
  assert.ok(events.some((item) => String(item).includes('已自动升级到 2.4.0')), '日志说明升级结果');
});

test('createAutoUpdater：升级失败 → 记错误、不重启、下一轮照常排期', async () => {
  const events = [];
  const updater = createAutoUpdater({
    locate: () => ({ path: '/fake/opencode', explicit: false }),
    readVersion: async () => '2.3.0',
    fetchLatest: async () => '2.4.0',
    upgrade: async () => ({ ok: false, output: 'network down' }),
    onUpgraded: async () => { events.push('restart'); },
    log: () => {},
    intervalMs: 10,
  });
  updater.schedule(0);
  await new Promise((resolve) => setTimeout(resolve, 40));
  updater.cancel();
  assert.equal(updater.state.status, 'error');
  assert.deepEqual(events, []);
});

test('createAutoUpdater：开关关闭 / 显式路径 / 找不到二进制 → 各自的状态、零动作', async (t) => {
  const cases = [
    { name: 'off', deps: { isEnabled: async () => false }, expected: 'off' },
    { name: 'manual-path', deps: { locate: () => ({ path: '/x', explicit: true }) }, expected: 'manual-path' },
    { name: 'not-found', deps: { locate: () => null }, expected: 'not-found' },
  ];
  for (const { name, deps, expected } of cases) {
    await t.test(name, async () => {
      let upgraded = false;
      const updater = createAutoUpdater({
        locate: () => ({ path: '/fake/opencode', explicit: false }),
        readVersion: async () => { throw new Error('不该读版本'); },
        fetchLatest: async () => { throw new Error('不该拉 registry'); },
        upgrade: async () => { upgraded = true; return { ok: true, output: '' }; },
        log: () => {},
        intervalMs: 60_000,
        ...deps,
      });
      updater.schedule(0);
      await new Promise((resolve) => setTimeout(resolve, 30));
      updater.cancel();
      assert.equal(updater.state.status, expected);
      assert.equal(upgraded, false);
    });
  }
});

test('createAutoUpdater：cancel 停排期，schedule 重新激活', async () => {
  const updater = createAutoUpdater({
    locate: () => null,
    log: () => {},
    intervalMs: 5,
  });
  updater.schedule(0);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(updater.state.status, 'not-found');

  updater.cancel();
  await new Promise((resolve) => setTimeout(resolve, 25));
  // cancel 后 timer 已清：等过两个周期长度也不该抛错或复活

  updater.schedule(0); // 重新激活（对应服务重启后再排期）
  await new Promise((resolve) => setTimeout(resolve, 15));
  updater.cancel();
  assert.equal(updater.state.status, 'not-found');
});

test('Bridge：设置项落库与非法值拒绝；快照透出巡检状态', async (t) => {
  const prevData = process.env.OCF_DATA_DIR;
  const dir = await mkdtemp(join(tmpdir(), 'oc-upd-bridge-'));
  process.env.OCF_DATA_DIR = dir;
  t.after(() => {
    if (prevData === undefined) delete process.env.OCF_DATA_DIR;
    else process.env.OCF_DATA_DIR = prevData;
  });

  const bridge = new Bridge({ log: () => {} });
  assert.equal(bridge.state.opencodeUpdate.status, 'idle', '快照透出的巡检状态初始为 idle');

  assert.equal((await settings.readSettings()).opencodeAutoUpdate, true, '默认开启');
  const saved = await bridge.saveSettings({ opencodeAutoUpdate: false });
  assert.equal(saved.opencodeAutoUpdate, false);
  assert.equal((await settings.readSettings()).opencodeAutoUpdate, false);

  await assert.rejects(() => bridge.saveSettings({ opencodeAutoUpdate: 'yes' }), /只接受 true 或 false/);
});
