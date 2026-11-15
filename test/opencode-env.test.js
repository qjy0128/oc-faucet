/** OpenCode 安装情况与外部运行状态检测单元测试。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Bridge } from '../src/main.js';
import {
  OPENCODE_INSTALL_URL,
  inspectOpencodeEnv,
  parseUnixOpencodeProcesses,
  parseWindowsOpencodeProcesses,
} from '../src/opencode-env.js';

test('parseUnixOpencodeProcesses：识别独立 OpenCode 并排除自身托管子进程与无关辅助进程', () => {
  const sample = [
    '  101     1 /Applications/OpenCode.app/Contents/MacOS/OpenCode',
    '  102   101 /Users/demo/Library/Application Support/ai.opencode.desktop/cli/2.2.7-arm64/opencode-cli serve --service',
    '  103   101 /Applications/OpenCode.app/Contents/Frameworks/OpenCode Helper.app/Contents/MacOS/OpenCode Helper',
    '  104   101 /Applications/OpenCode.app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt',
    '  201 90001 /Users/demo/.opencode/bin/opencode serve --port 41990',
    '  202   201 /Users/demo/.opencode/bin/opencode-helper',
    '  301     1 /Users/demo/.opencode/bin/opencode --version',
    '  401     1 node /Users/demo/Coding/oc-faucet/src/main.js',
    '  501     1 vim /tmp/opencode-notes.md',
  ].join('\n');

  const detected = parseUnixOpencodeProcesses(sample, [90001, 201]);
  assert.deepEqual(detected, [101, 102, 301]);
});

test('parseWindowsOpencodeProcesses：解析进程 JSON 并过滤自身父子进程', () => {
  const sample = JSON.stringify([
    { ProcessId: 11, ParentProcessId: 1, Name: 'OpenCode.exe', CommandLine: 'C:\\Program Files\\OpenCode\\OpenCode.exe' },
    { ProcessId: 22, ParentProcessId: 888, Name: 'opencode.exe', CommandLine: 'C:\\tools\\opencode.exe serve --port 4096' },
    { ProcessId: 33, ParentProcessId: 22, Name: 'opencode-cli.exe', CommandLine: 'C:\\tools\\opencode-cli.exe serve' },
    { ProcessId: 44, ParentProcessId: 1, Name: 'opencode.exe', CommandLine: 'C:\\tools\\oc-faucet\\opencode.exe' },
  ]);

  assert.deepEqual(parseWindowsOpencodeProcesses(sample, [888, 22]), [11]);

  const single = JSON.stringify({
    ProcessId: 55,
    ParentProcessId: 1,
    Name: 'opencode-cli.exe',
    CommandLine: 'opencode-cli.exe serve',
  });
  assert.deepEqual(parseWindowsOpencodeProcesses(single, [999]), [55]);
});

test('inspectOpencodeEnv：区分未安装、已安装未打开、已打开三种状态', async () => {
  let psCalls = 0;

  const missing = await inspectOpencodeEnv({
    platform: 'darwin',
    home: '/Users/demo',
    env: { PATH: '/usr/bin' },
    pathExists: () => false,
    discoverImpl: () => ({ found: null, searched: ['/usr/bin/opencode'] }),
    execFileImpl: async () => {
      psCalls += 1;
      return { stdout: '' };
    },
    now: () => 1000,
  });
  assert.equal(missing.installed, false);
  assert.equal(missing.externalRunning, false);
  assert.equal(missing.installUrl, OPENCODE_INSTALL_URL);
  assert.equal(psCalls, 0, '未安装时不需要扫描系统进程');

  const closed = await inspectOpencodeEnv({
    platform: 'darwin',
    home: '/Users/demo',
    env: { PATH: '/usr/bin' },
    pathExists: (p) => p === '/Applications/OpenCode.app',
    discoverImpl: () => ({ found: null, searched: [] }),
    execFileImpl: async () => ({
      stdout: ' 300 100 /Users/demo/.opencode/bin/opencode serve --port 41234\n',
    }),
    ownPids: [100],
    now: () => 2000,
  });
  assert.equal(closed.installed, true);
  assert.equal(closed.appInstalled, true);
  assert.equal(closed.cliInstalled, false);
  assert.equal(closed.externalRunning, false);

  const running = await inspectOpencodeEnv({
    platform: 'darwin',
    home: '/Users/demo',
    env: { PATH: '/usr/bin' },
    pathExists: () => false,
    discoverImpl: () => ({ found: '/Users/demo/.opencode/bin/opencode', searched: [] }),
    execFileImpl: async () => ({
      stdout: [
        ' 300 100 /Users/demo/.opencode/bin/opencode serve --port 41234',
        ' 450 1 /Applications/OpenCode.app/Contents/MacOS/OpenCode',
      ].join('\n'),
    }),
    ownPids: [100],
    now: () => 3000,
  });
  assert.equal(running.installed, true);
  assert.equal(running.cliInstalled, true);
  assert.equal(running.externalRunning, true);
  assert.deepEqual(running.externalPids, [450]);
});

test('Bridge.checkOpencodeEnv：2 秒内节流缓存，force 时立即重查并写入快照', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-opencode-env-'));
  const saved = process.env.OCF_DATA_DIR;
  process.env.OCF_DATA_DIR = dir;

  let calls = 0;
  let nextResult = {
    installed: true,
    cliInstalled: true,
    appInstalled: false,
    path: '/usr/local/bin/opencode',
    cliPath: '/usr/local/bin/opencode',
    appPath: null,
    externalRunning: false,
    externalPids: [],
    installUrl: OPENCODE_INSTALL_URL,
    checkedAt: 100,
  };

  const bridge = new Bridge({
    log: () => {},
    targets: [],
    inspectOpencode: async ({ ownPids }) => {
      calls += 1;
      assert.ok(ownPids.includes(process.pid));
      return { ...nextResult, ownPidsCount: ownPids.length };
    },
  });
  t.after(async () => {
    await bridge.stop({ uninstall: false }).catch(() => {});
    if (saved === undefined) delete process.env.OCF_DATA_DIR;
    else process.env.OCF_DATA_DIR = saved;
    await rm(dir, { recursive: true, force: true });
  });

  const first = await bridge.checkOpencodeEnv();
  const second = await bridge.checkOpencodeEnv();
  assert.equal(calls, 1);
  assert.equal(second.installed, first.installed);
  assert.equal(bridge.snapshot().opencode.externalRunning, false);

  nextResult = { ...nextResult, externalRunning: true, externalPids: [777], checkedAt: 200 };
  const forced = await bridge.checkOpencodeEnv({ force: true });
  assert.equal(calls, 2);
  assert.equal(forced.externalRunning, true);
  assert.equal(bridge.snapshot().opencode.externalRunning, true);
});
