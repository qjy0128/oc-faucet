/**
 * service-control.js 的测试：让 npm stop / npm restart 找得到、叫得动正在跑的实例。
 *
 * 这里用真的子进程（`node -e` 起一个什么都不干的小进程）来验「请它退出」，
 * 不碰 OpenCode、不碰端口，测的是登记与停止这套机制本身。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  clearServiceInfo,
  isAlive,
  readServiceInfo,
  serviceFile,
  stopRunning,
  writeServiceInfo,
} from '../src/service-control.js';

/** 每个用例一个临时数据目录，互不打扰 */
function useDataDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'oc-svc-'));
  const previous = process.env.OCF_DATA_DIR;
  process.env.OCF_DATA_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.OCF_DATA_DIR;
    else process.env.OCF_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

/** 起一个会一直活着的小进程；ready 要等它把信号处理器装好才算数 */
function spawnIdle({ ignoreSigterm = false } = {}) {
  const code = ignoreSigterm
    ? "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);"
    : "console.log('ready'); setInterval(() => {}, 1000);";
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'] });
  const gone = new Promise((resolve) => child.once('exit', resolve));
  const ready = new Promise((resolve) => {
    let seen = '';
    child.stdout.on('data', (chunk) => {
      seen += chunk;
      if (seen.includes('ready')) resolve(child.pid);
    });
  });
  return { child, gone, ready };
}

test('登记写进去能原样读出来，文件跟着 OCF_DATA_DIR 走', async (t) => {
  const dir = useDataDir(t);
  await writeServiceInfo({ pid: 12345, port: 41982, webPort: 41983, mode: 'web', startedAt: 1790000000000 });

  assert.equal(serviceFile(), join(dir, 'service.json'));
  assert.deepEqual(await readServiceInfo(), {
    pid: 12345,
    port: 41982,
    webPort: 41983,
    mode: 'web',
    startedAt: 1790000000000,
  });
});

test('文件不存在或写坏了，都按「没有在运行」处理', async (t) => {
  const dir = useDataDir(t);
  assert.equal(await readServiceInfo(), null);

  await writeFile(join(dir, 'service.json'), '{ 这不是 JSON', 'utf8');
  assert.equal(await readServiceInfo(), null);
});

test('清理登记只删自己的：pid 对不上不动别人的记录', async (t) => {
  useDataDir(t);
  await writeServiceInfo({ pid: 111, port: 41982 });

  assert.equal(await clearServiceInfo(222), false);
  assert.ok(await readServiceInfo(), '别人的记录不能被删');
  assert.equal(await clearServiceInfo(111), true);
  assert.equal(await readServiceInfo(), null);
});

test('stopRunning：请进程退出，并顺手清掉登记', async (t) => {
  useDataDir(t);
  const { child, gone, ready } = spawnIdle();
  const pid = await ready;
  await writeServiceInfo({ pid, port: 43210, mode: 'start' });

  assert.equal(isAlive(pid), true);
  const result = await stopRunning({ timeoutMs: 5_000 });

  assert.equal(result.wasRunning, true);
  assert.equal(result.stopped, true);
  assert.equal(result.pid, pid);
  assert.equal(result.port, 43210);
  await gone;
  assert.equal(isAlive(pid), false);
  assert.equal(await readServiceInfo(), null, '实例停了，登记也该清掉');
});

test('stopRunning：进程早就没了 → 当过期记录清掉，不算失败', async (t) => {
  useDataDir(t);
  const { child, gone, ready } = spawnIdle();
  const pid = await ready;
  child.kill('SIGKILL');
  await gone;

  await writeServiceInfo({ pid, port: 43211 });
  const result = await stopRunning({ timeoutMs: 1_000 });

  assert.equal(result.wasRunning, false);
  assert.equal(result.stale, true);
  assert.equal(await readServiceInfo(), null);
});

test('stopRunning：进程赖着不退时报 stopped:false，而不是假装成功', async (t) => {
  useDataDir(t);
  const { child, gone, ready } = spawnIdle({ ignoreSigterm: true });
  const pid = await ready;
  await writeServiceInfo({ pid, port: 43212 });

  const result = await stopRunning({ timeoutMs: 400 });

  assert.equal(result.wasRunning, true);
  assert.equal(result.stopped, false, '没退就是没退，不许谎报');
  assert.equal(isAlive(pid), true);

  // 收尾：这个测试自己起的进程，杀掉
  child.kill('SIGKILL');
  await gone;
});

test('stopRunning：没有登记时什么都不做', async (t) => {
  useDataDir(t);
  const result = await stopRunning();
  assert.deepEqual(result, { wasRunning: false, stopped: false, stale: false });
});
