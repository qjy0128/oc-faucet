import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

const source = await readFile(new URL('../src/oc-client.js', import.meta.url), 'utf8');
const transformed = source
  .replace(/import \{ spawn \} from ["']node:child_process["'];/, 'const spawn = (...args) => globalThis.__windowsSpawn(...args);')
  .replace(/process\.platform/g, 'globalThis.__windowsPlatform')
  .replace(/from (["'])(\.\/[^"']+)\1/g, (_match, _quote, path) =>
    `from "${pathToFileURL(`${process.cwd()}/src/${path.slice(2)}`).href}"`,
  );
const { OcClient, discoverOpencode } = await import(
  `data:text/javascript;base64,${Buffer.from(`${transformed}\nexport { discoverOpencode };`).toString('base64')}`,
);

globalThis.__windowsPlatform = 'win32';

async function captureLaunch(executable) {
  let captured = null;
  globalThis.__windowsSpawn = (file, args, options) => {
    captured = { file, args, options };
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    const batchWithoutShell = /\.(?:cmd|bat)$/i.test(executable) && options.shell !== true;
    queueMicrotask(() => child.emit('error', Object.assign(
      new Error(batchWithoutShell ? 'spawn EINVAL' : 'EXPECTED_TEST_STOP'),
      { code: batchWithoutShell ? 'EINVAL' : 'EXPECTED_TEST_STOP' },
    )));
    return child;
  };

  const client = new OcClient({ dataDir: '/tmp/ocf-windows', workdir: '/tmp/ocf-windows', isolate: false });
  client.apiMajor = 2;
  let error = null;
  try {
    await client._spawnAndWait(executable, 41982);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, '要结束在受控的测试出口，而不是真的启动服务');
  assert.doesNotMatch(error.message, /spawn EINVAL/);
  assert.match(error.message, /EXPECTED_TEST_STOP/);
  return captured;
}

test('Windows .cmd/.bat 经命令解释器启动，带空格路径保持完整', async () => {
  for (const extension of ['cmd', 'bat']) {
    const executable = `C:\\Users\\Test User\\AppData\\Roaming\\npm\\opencode.${extension}`;
    const launch = await captureLaunch(executable);
    assert.equal(launch.options.shell, true);
    assert.equal(launch.file, `"${executable}"`);
    assert.deepEqual(launch.args.slice(0, 3), ['serve', '--port', '41982']);
  }
});

test('Windows 普通 exe 仍直接启动，不多加 shell', async () => {
  const executable = 'C:\\Tools\\OpenCode\\opencode.exe';
  const launch = await captureLaunch(executable);
  assert.notEqual(launch.options.shell, true);
  assert.equal(launch.file, executable);
});

test('Windows npm 安装优先发现包内真实 exe，而不是外层 cmd shim', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ocf-win-discover-'));
  const npm = join(dir, 'npm');
  const executable = join(npm, 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe');
  mkdirSync(join(npm, 'node_modules', '@opencode', 'cli', 'bin'), { recursive: true });
  writeFileSync(executable, 'exe');
  chmodSync(executable, 0o755);
  writeFileSync(join(npm, 'opencode.cmd'), 'cmd');
  chmodSync(join(npm, 'opencode.cmd'), 0o755);
  const saved = process.env.OCF_OPENCODE_PATH;
  delete process.env.OCF_OPENCODE_PATH;
  t.after(() => {
    if (saved === undefined) delete process.env.OCF_OPENCODE_PATH;
    else process.env.OCF_OPENCODE_PATH = saved;
  });

  const result = discoverOpencode(undefined, npm, join(dir, 'home'));
  assert.equal(result.found, executable);
});

test('Windows 不把无扩展名 bash shim 当成可执行程序', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ocf-win-shim-'));
  const shim = join(dir, 'opencode');
  writeFileSync(shim, 'bash shim');
  chmodSync(shim, 0o755);
  const saved = process.env.OCF_OPENCODE_PATH;
  delete process.env.OCF_OPENCODE_PATH;
  t.after(() => {
    if (saved === undefined) delete process.env.OCF_OPENCODE_PATH;
    else process.env.OCF_OPENCODE_PATH = saved;
  });

  const result = discoverOpencode(undefined, dir, join(dir, 'home'));
  assert.equal(result.found, null);
});

test('Windows 停止服务用 taskkill 清理整棵进程树', async () => {
  const calls = [];
  globalThis.__windowsSpawn = (file, args, options) => {
    calls.push({ file, args, options });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0));
    return child;
  };

  const parent = new EventEmitter();
  parent.pid = 321;
  parent.exitCode = null;
  parent.signalCode = null;
  parent.kill = () => queueMicrotask(() => parent.emit('exit', 0));
  const client = new OcClient({ dataDir: '/tmp/ocf-windows-kill', isolate: false });
  client.child = parent;
  await client._killChild();

  const taskkill = calls.find((call) => call.file === 'taskkill');
  assert.ok(taskkill, '必须调用 taskkill，不能只杀外层 cmd.exe');
  assert.deepEqual(taskkill.args, ['/PID', '321', '/T', '/F']);
});
