/**
 * 停服自动摘除测试（桥级）。
 *
 * 挡的坑：服务一停，各接入工具（ZCode / DSH / qoder……）里还写着指向转发口的配置，
 * 转发口没了它们就全指向一个死端口。所以所有正常停止路径（面板「关闭服务」、
 * npm stop、npm restart 的停止阶段）在关停前必须把「当前已写入」的目标逐个摘掉。
 *
 * 接缝同 key-cascade.test.js：临时 OCF_DATA_DIR + 假目标注入，不起真实进程、不联网。
 * OCF_ZCODE_CONFIG 也指到临时目录：旧实现的 stop 会直调 zcode.uninstall()，
 * 绝不能让它碰到真实的 ZCode 配置。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Bridge } from '../src/main.js';

/**
 * 假接入目标：写入状态是内存里演的真状态（摘除后 status 就报未写入），
 * 每次调用都记下来；给了 events 就把摘除时刻记进去，用来验证调用顺序。
 */
function fakeTarget(id, { written = false, failOnUninstall = false, events } = {}) {
  const calls = { install: [], uninstall: [] };
  const target = {
    id,
    label: `假目标${id}`,
    calls,
    written,
    detect: () => true,
    status: async () => ({ written: target.written, models: target.written ? ['opencode/a'] : [] }),
    install: async () => {
      calls.install.push({});
      target.written = true;
      return { added: 1, changed: true };
    },
    uninstall: async () => {
      calls.uninstall.push({});
      events?.push(`uninstall:${id}`);
      if (failOnUninstall) throw new Error('配置文件被别的程序占着');
      target.written = false;
      return { removed: 1, changed: true };
    },
  };
  return target;
}

/** 造一个「已在跑」的桥：临时数据目录 + 假目标 + 假 server/client，不起任何真实进程 */
async function makeBridge(t, targets, { events = [] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'oc-stop-'));
  process.env.OCF_DATA_DIR = dir;
  // 旧实现的 stop 直调 zcode.uninstall()；指到不存在的临时文件上是安全空操作
  process.env.OCF_ZCODE_CONFIG = join(dir, 'zcode', 'provider_config.json');
  t.after(async () => {
    delete process.env.OCF_DATA_DIR;
    delete process.env.OCF_ZCODE_CONFIG;
    await rm(dir, { recursive: true, force: true });
  });

  const logs = [];
  const bridge = new Bridge({ log: (m) => logs.push(m), targets });
  bridge.state.port = 41982;
  bridge.server = {
    close(cb) {
      events.push('server-close');
      queueMicrotask(cb);
    },
    closeIdleConnections() {},
  };
  bridge.client = { stop: async () => events.push('client-stop') };
  return { bridge, dir, events, logs };
}

test('停服：已写入的目标逐个摘除，未写入的不碰，摘除发生在关停之前', async (t) => {
  const events = [];
  const a = fakeTarget('fake-a', { written: true, events });
  const b = fakeTarget('fake-b', { written: true, events });
  const c = fakeTarget('fake-c', { written: false, events });
  const { bridge } = await makeBridge(t, [a, b, c], { events });

  await bridge.stop();

  assert.equal(a.calls.uninstall.length, 1, '已写入的 fake-a 应当被摘除一次');
  assert.equal(b.calls.uninstall.length, 1, '已写入的 fake-b 应当被摘除一次');
  assert.equal(c.calls.uninstall.length, 0, '未写入的目标一个摘除动作都不能有');
  assert.equal(c.calls.install.length, 0, '未写入的目标也不能被顺手写入');

  // 顺序是承诺：先逐个摘除，再关转发口，最后关 OpenCode
  assert.deepEqual(events, ['uninstall:fake-a', 'uninstall:fake-b', 'server-close', 'client-stop']);

  // 摘除后的实读缓存要跟上：界面快照不能再显示「已写入」
  const states = Object.fromEntries(bridge.state.targets.map((s) => [s.id, s.written]));
  assert.deepEqual(states, { 'fake-a': false, 'fake-b': false, 'fake-c': false });
  assert.equal(bridge.state.phase, 'idle');
});

test('停服：某个目标摘除失败不阻塞——其余的照摘，服务照停，失败记进日志', async (t) => {
  const events = [];
  const bad = fakeTarget('fake-bad', { written: true, failOnUninstall: true, events });
  const good = fakeTarget('fake-good', { written: true, events });
  const { bridge, logs } = await makeBridge(t, [bad, good], { events });

  // 摘除失败不该让 stop 抛出来——服务必须停得掉
  await bridge.stop();

  assert.equal(bad.calls.uninstall.length, 1, '坏目标也尝试过摘除');
  assert.equal(good.calls.uninstall.length, 1, '一个失败不该挡住其余的');
  assert.deepEqual(events, ['uninstall:fake-bad', 'uninstall:fake-good', 'server-close', 'client-stop']);
  assert.equal(bridge.state.phase, 'idle', '服务照停');
  assert.ok(
    logs.some((m) => m.includes('假目标fake-bad')),
    '失败原因要记进日志，不能无声吞掉',
  );
});

test('停服：uninstall:false 时一个目标都不碰（面板「重启服务」与启动失败收摊走这条路）', async (t) => {
  const events = [];
  const a = fakeTarget('fake-a', { written: true, events });
  const { bridge } = await makeBridge(t, [a], { events });

  await bridge.stop({ uninstall: false });

  assert.equal(a.calls.uninstall.length, 0, '明确不摘时，已写入的目标也不能碰');
  assert.deepEqual(events, ['server-close', 'client-stop'], '直接关停，不做任何读状态之外的动作');
});
