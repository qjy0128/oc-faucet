/**
 * 改密钥后的级联重写测试（桥级）。
 *
 * 挡的坑：密钥一换，转发口立刻只认新密钥，而各接入目标配置里写的还是旧密钥，
 * 于是所有已接入的工具一夜之间全部 401。这里验证：保存新密钥时，
 * 凡当前写着我们配置的目标都被自动重写一遍（换上新密钥），没写入的目标绝不去碰。
 *
 * 接缝同 main-restore.test.js：临时 OCF_DATA_DIR + 假目标注入，不起真实进程。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Bridge } from '../src/main.js';
import { BridgeError } from '../src/errors.js';

/** 假接入目标：状态是内存里演的，每次调用都记下来 */
function fakeTarget(id, { written, failOnInstall = false } = {}) {
  const calls = { install: [], uninstall: [] };
  return {
    id,
    label: `假目标${id}`,
    calls,
    detect: () => true,
    status: async () => ({ written, models: written ? ['opencode/a'] : [] }),
    install: async (models, { port, apiKey }) => {
      calls.install.push({ models: models.map((m) => m.id), port, apiKey });
      if (failOnInstall) throw new Error('配置文件被别的程序占着');
      return { added: models.length, changed: true };
    },
    uninstall: async () => {
      calls.uninstall.push({});
      return { removed: 0, changed: false };
    },
  };
}

/** 造一个「已在跑」的桥：临时数据目录 + 假目标 + 假 server，不起任何真实进程 */
async function makeBridge(t, targets) {
  const dir = await mkdtemp(join(tmpdir(), 'oc-key-'));
  process.env.OCF_DATA_DIR = dir;
  t.after(async () => {
    delete process.env.OCF_DATA_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  const bridge = new Bridge({ log: () => {}, targets });
  bridge.state.apiKey = 'oc-old-key';
  bridge.state.port = 41982;
  bridge.state.models = [{ id: 'opencode/a', providerID: 'opencode', modelID: 'a', name: 'a' }];
  bridge.state.verdicts.set('opencode/a', { verdict: 'tool', note: '', cached: false });
  const serverKeys = [];
  bridge.server = { setApiKey: (k) => serverKeys.push(k) };
  return { bridge, dir, serverKeys };
}

test('setApiKey：落盘 0600、转发口立即换用、已写入目标全部级联重写', async (t) => {
  const writtenA = fakeTarget('fake-a', { written: true });
  const writtenB = fakeTarget('fake-b', { written: true });
  const notWritten = fakeTarget('fake-c', { written: false });
  const { bridge, dir, serverKeys } = await makeBridge(t, [writtenA, writtenB, notWritten]);

  // 顺手验证首尾空格会被去掉
  await bridge.setApiKey('  oc-new-key  ');

  // 1) 落盘：内容是新密钥，权限 0600
  assert.equal((await readFile(join(dir, 'api-key'), 'utf8')).trim(), 'oc-new-key');
  assert.equal((await stat(join(dir, 'api-key'))).mode & 0o777, 0o600, '密钥文件权限必须是 0600');
  assert.equal(bridge.state.apiKey, 'oc-new-key', '桥手上的密钥要同步换掉');

  // 2) 转发口立即换用（不重启进程）
  assert.deepEqual(serverKeys, ['oc-new-key']);

  // 3) 级联重写：已写入的两个目标都被重写，带的是新密钥和现有模型清单
  for (const target of [writtenA, writtenB]) {
    assert.equal(target.calls.install.length, 1, `${target.id} 应当被重写一次`);
    assert.equal(target.calls.install[0].apiKey, 'oc-new-key');
    assert.equal(target.calls.install[0].port, 41982);
    assert.deepEqual(target.calls.install[0].models, ['opencode/a']);
  }
  // 4) 没写入的目标绝不去碰
  assert.equal(notWritten.calls.install.length, 0);
  assert.equal(notWritten.calls.uninstall.length, 0);

  // 5) 快照依旧不携带密钥
  const snap = bridge.snapshot();
  assert.equal(snap.apiKey, null);
  assert.equal(snap.hasApiKey, true);
});

test('setApiKey：空密钥被拒，什么都不动', async (t) => {
  const target = fakeTarget('fake-a', { written: true });
  const { bridge, dir, serverKeys } = await makeBridge(t, [target]);

  for (const bad of ['', '   ', 123, null, undefined]) {
    await assert.rejects(
      () => bridge.setApiKey(bad),
      (err) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.status, 400);
        assert.match(err.message, /空/);
        return true;
      },
      `输入 ${JSON.stringify(bad)} 应当被拒`,
    );
  }

  // 文件没写、转发口没换、目标没碰、桥手上的还是旧密钥
  await assert.rejects(readFile(join(dir, 'api-key'), 'utf8'), /ENOENT/);
  assert.deepEqual(serverKeys, []);
  assert.equal(target.calls.install.length, 0);
  assert.equal(bridge.state.apiKey, 'oc-old-key');
});

test('setApiKey：某个目标重写失败时密钥照样生效，错误说清是谁没写上', async (t) => {
  const ok = fakeTarget('fake-ok', { written: true });
  const bad = fakeTarget('fake-bad', { written: true, failOnInstall: true });
  const { bridge, dir, serverKeys } = await makeBridge(t, [ok, bad]);

  await assert.rejects(
    () => bridge.setApiKey('oc-new-key'),
    (err) => {
      assert.match(err.message, /fake-bad/);
      assert.match(err.message, /保存/);
      return true;
    },
  );

  // 密钥已落盘、转发口已换、好目标已重写——失败的可以重试，不是整个回滚
  assert.equal((await readFile(join(dir, 'api-key'), 'utf8')).trim(), 'oc-new-key');
  assert.deepEqual(serverKeys, ['oc-new-key']);
  assert.equal(ok.calls.install.length, 1);
  assert.equal(bad.calls.install.length, 1, '坏目标也尝试过重写');
});

test('getApiKey：桥没起时读数据目录里的现有密钥，不重置它', async (t) => {
  const { bridge, dir } = await makeBridge(t, []);
  bridge.state.apiKey = null; // 模拟还没 start()
  await writeFile(join(dir, 'api-key'), 'oc-existing-key\n', { mode: 0o600 });

  assert.equal(await bridge.getApiKey(), 'oc-existing-key', '已有数据目录的密钥必须原样沿用');

  // 桥在跑时直接给内存里那份
  bridge.state.apiKey = 'oc-running-key';
  assert.equal(await bridge.getApiKey(), 'oc-running-key');
});
