/** findOpencodeExecutable 的平台分支测试：重点锁 Windows「应用执行别名」跳过（spawn UNKNOWN 的坑）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findOpencodeExecutable } from '../src/oc-client.js';

async function withTree(t) {
  const root = await mkdtemp(join(tmpdir(), 'oc-discover-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const make = async (relative, executable = true) => {
    const file = join(root, relative);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, '');
    if (executable) await chmod(file, 0o755);
    return file;
  };
  return { root, make };
}

test('Windows：跳过 Microsoft\\WindowsApps 的执行别名，取 PATH 里后面的真身', async (t) => {
  const { root, make } = await withTree(t);
  // 模拟 winget/商店 CLI 的布局：WindowsApps 下是 0 字节 reparse point（测试里用普通文件占位，
  // 判定只看路径段），真身在 PATH 更后面的 npm 目录
  const alias = await make(join('Microsoft', 'WindowsApps', 'opencode.exe'));
  const real = await make(join('npm', 'opencode.exe'));
  const pathEnv = [join(root, 'Microsoft', 'WindowsApps'), join(root, 'npm')].join(';');

  const { found, searched } = findOpencodeExecutable(undefined, pathEnv, root, 'win32');
  assert.equal(found, real, '选 PATH 里跳过别名后的真身');
  assert.ok(searched.includes(alias), '别名也记入 searched，找不到时可给用户线索');
});

test('Windows：只有执行别名时宁缺毋滥，报未找到而不是选一个 spawn 不了的', async (t) => {
  const { root, make } = await withTree(t);
  await make(join('Microsoft', 'WindowsApps', 'opencode.exe'));
  const pathEnv = join(root, 'Microsoft', 'WindowsApps');

  const { found } = findOpencodeExecutable(undefined, pathEnv, root, 'win32');
  assert.equal(found, null);
});

test('Windows：家目录下的 ~/.opencode/bin/opencode.exe 仍按契约优先命中', async (t) => {
  const { root, make } = await withTree(t);
  const real = await make(join('.opencode', 'bin', 'opencode.exe'));
  await make(join('later', 'opencode.exe'));
  const pathEnv = join(root, 'later');

  const { found } = findOpencodeExecutable(undefined, pathEnv, root, 'win32');
  assert.equal(found, real);
});

test('Windows：显式指定的路径不经过别名过滤（用户指哪是哪）', async (t) => {
  const { root, make } = await withTree(t);
  const alias = await make(join('Microsoft', 'WindowsApps', 'opencode.exe'));
  const { found } = findOpencodeExecutable(alias, '', root, 'win32');
  assert.equal(found, alias);
});

test('macOS：Microsoft/WindowsApps 判据不误伤普通 PATH 查找', async (t) => {
  const { root, make } = await withTree(t);
  const real = await make(join('some-bin', 'opencode'));
  const { found } = findOpencodeExecutable(undefined, join(root, 'some-bin'), root, 'darwin');
  assert.equal(found, real);
});
