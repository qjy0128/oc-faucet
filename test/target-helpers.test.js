/**
 * src/target-helpers.js 的测试。
 *
 * 两块内容：
 *   1. assertInstallArgs 的逐模型 id 校验——四个目标模块共用这一道，坏的模型条目
 *      （缺 id、id 里没有斜杠）必须在写盘前就被拦下，一个文件都不许碰；
 *   2. writeTextIfChanged 写盘骨架——「读旧 → 比对 → 备份 → 原子写」，
 *      dsh / qoder / codebuddy 三个模块都从自己的私有副本收敛到这一个。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, stat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertInstallArgs, writeTextIfChanged } from '../src/target-helpers.js';

const ARGS = { port: 41982, apiKey: 'k' };
const GOOD = [{ id: 'opencode/a' }, { id: 'opencode/b' }];

test('assertInstallArgs：端口/密钥/清单三件套不合法要拒', () => {
  assert.throws(() => assertInstallArgs(GOOD, { port: 0, apiKey: 'k' }, 'X'), /端口/);
  assert.throws(() => assertInstallArgs(GOOD, { port: 41982, apiKey: '' }, 'X'), /密钥/);
  assert.throws(() => assertInstallArgs('nope', ARGS, 'X'), /模型/);
});

test('assertInstallArgs：逐模型校验 id——缺 id、空 id、非字符串、没有斜杠都要拒', () => {
  assert.throws(() => assertInstallArgs([{ name: '没 id' }], ARGS, 'X'), /模型/);
  assert.throws(() => assertInstallArgs([{ id: '' }], ARGS, 'X'), /模型/);
  assert.throws(() => assertInstallArgs([{ id: 42 }], ARGS, 'X'), /模型/);
  assert.throws(() => assertInstallArgs([null], ARGS, 'X'), /模型/);
  assert.throws(() => assertInstallArgs([{ id: 'no-slash' }], ARGS, 'X'), /模型/, 'ZCode 侧 id 必须是 provider/model 两段');
  // 混在好模型里的坏条目也要整批拒掉
  assert.throws(() => assertInstallArgs([...GOOD, { id: 'bad' }], ARGS, 'X'), /模型/);
  // 合法清单（含空清单：拦不拦空清单是各目标自己的事）不拦
  assertInstallArgs(GOOD, ARGS, 'X');
  assertInstallArgs([], ARGS, 'X');
});

/* ------------------------------------------------------------------ */
/* writeTextIfChanged                                                   */
/* ------------------------------------------------------------------ */

async function withTempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'oc-helpers-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('writeTextIfChanged：新建文件，权限 0600，返回 changed:true', async (t) => {
  const dir = await withTempDir(t);
  const file = join(dir, 'sub', 'conf.json'); // 父目录还不存在，骨架要自己建好
  const r = await writeTextIfChanged(file, '{"a":1}\n');
  assert.deepEqual(r, { changed: true });
  assert.equal(await readFile(file, 'utf8'), '{"a":1}\n');
  assert.equal((await stat(file)).mode & 0o777, 0o600, '里面有明文密钥，必须 0600');
});

test('writeTextIfChanged：内容没变不写盘，changed:false', async (t) => {
  const dir = await withTempDir(t);
  const file = join(dir, 'conf.json');
  await writeTextIfChanged(file, 'same\n');
  const mtime = (await stat(file)).mtimeMs;

  const r = await writeTextIfChanged(file, 'same\n');
  assert.deepEqual(r, { changed: false });
  assert.equal((await stat(file)).mtimeMs, mtime, '不许再写盘');
  assert.equal((await readdir(dir)).length, 1, '没变也不许堆备份');
});

test('writeTextIfChanged：内容变了先备份旧文再原子替换，一天一份', async (t) => {
  const dir = await withTempDir(t);
  const file = join(dir, 'conf.json');
  await writeFile(file, '旧内容\n');

  const r = await writeTextIfChanged(file, '新内容\n');
  assert.deepEqual(r, { changed: true });
  assert.equal(await readFile(file, 'utf8'), '新内容\n');

  const stamp = new Date().toISOString().slice(0, 10);
  const backup = join(dir, `conf.json.oc-faucet-backup-${stamp}`);
  assert.equal(await readFile(backup, 'utf8'), '旧内容\n', '备份的是写入前的原文');

  // 同一天再改一次：写盘照写，但不许盖掉已有的备份
  await writeTextIfChanged(file, '更新的内容\n');
  assert.equal(await readFile(backup, 'utf8'), '旧内容\n', '同一天不重复备份');
  assert.equal((await readdir(dir)).filter((n) => n.includes('backup')).length, 1);
});

test('writeTextIfChanged：备份回调可替换（保持各模块现有备份命名用的缝）', async (t) => {
  const dir = await withTempDir(t);
  const file = join(dir, 'conf.json');
  await writeFile(file, '旧\n');
  const seen = [];
  await writeTextIfChanged(file, '新\n', {
    backup: async (f, existing) => {
      seen.push([f, existing]);
    },
  });
  assert.deepEqual(seen, [[file, '旧\n']], '备份回调要拿到路径和写入前的原文');
  assert.equal(existsSync(join(dir, 'conf.json.oc-faucet-backup-' + new Date().toISOString().slice(0, 10))), false,
    '换了备份回调就不许再走默认的同日备份');
});
