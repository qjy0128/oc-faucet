import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;

/** 服务退出时会逐个实读/摘除所有默认目标；每个子进程都把目标路径封到临时目录。 */
function isolatedTargetEnv(dir) {
  const targets = join(dir, 'targets');
  return {
    OCF_ZCODE_CONFIG: join(targets, 'zcode', 'provider_config.json'),
    OCF_ZCODE_BUILTIN: join(targets, 'zcode', 'builtin.json'),
    OCF_ZCODE_RUNTIME: join(targets, 'zcode', 'runtime'),
    OCF_DSH_PATCH: join(targets, 'dsh', 'cordis.patch.yml'),
    OCF_QODER_SETTINGS: join(targets, 'qoder', 'settings.json'),
    OCF_WORKBUDDY_MODELS: join(targets, 'workbuddy', 'models.json'),
    OCF_CODEBUDDY_MODELS: join(targets, 'codebuddy', 'models.json'),
    PI_CODING_AGENT_DIR: join(targets, 'pi', 'agent'),
    OCF_KIMI_CONFIG: join(targets, 'kimi', 'config.toml'),
    OCF_CLAUDE_SETTINGS: join(targets, 'claude', 'settings.json'),
    OCF_CLAUDE_OWNER: join(targets, 'claude', 'owner.json'),
    OCF_CODEX_CONFIG: join(targets, 'codex', 'config.toml'),
    OCF_CODEX_CATALOG: join(targets, 'codex', 'models.json'),
    OCF_CODEX_OWNER: join(targets, 'codex', 'owner.json'),
  };
}

/**
 * 假 opencode：一个能冒充 `opencode serve` 的小脚本。
 *
 * 这里故意不复用 oc-client.test.js 里的那个桩，因为那条测试要的是「启动失败时
 * 收没收摊」，需要的只有：能监听端口、能回健康检查、退出时能被杀掉、会留下 PID。
 * 用真的 OpenCode 会把用户的真实数据目录和进程卷进来，测出来的结果也不干净。
 *
 * @param {string} pidFile 这个文件用来把子进程 PID 交给测试，判断有没有孤儿进程
 */
function fakeOpencodeSource(pidFile) {
  return `#!${process.execPath}
import http from 'node:http';
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  console.log('opencode v1.19.3');
  process.exit(0);
}
const i = argv.indexOf('--port');
const port = i >= 0 ? Number(argv[i + 1]) : 0;
// 先把自己的 PID 写下来：父进程退出后测试靠它判断有没有漏掉后台进程
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));

const body = JSON.stringify({ providers: [], default: {} });
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
});
server.listen(port, '127.0.0.1', () => console.log('fake opencode listening on http://127.0.0.1:' + port));
`;
}

/** 等进程真的消失（最多 3 秒），返回是否已经没了 */
async function waitGone(pid, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** 等某个条件成立；超时就报清楚在等什么 */
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等待超时：${label}`);
}

/**
 * 这一组测的是「命令行入口」这个容易越界的东西：
 * main.js 既要能当程序跑（npm start），又要能被人 import（桌面端、测试）。
 * 搞错了会很难受——import 一下就把对方拖进一个永不退出的进程。
 */

test('被 import 时不会自己启动：立刻返回，不占端口', async () => {
  const script = `
    const t0 = Date.now();
    const m = await import(${JSON.stringify(join(root, 'src/main.js'))});
    if (typeof m.Bridge !== 'function') throw new Error('Bridge 没导出来');
    console.log('imported:' + (Date.now() - t0));
    process.exit(0);
  `;
  // 真起一个子进程：在同一个进程里 import 是测不出「引导代码误触发」的。
  const { stdout } = await run(NODE, ['--input-type=module', '-e', script], { timeout: 30_000 });
  assert.match(stdout, /^imported:\d+$/m, '应当干干净净地返回，而不是卡在监听上');
});

test('端口被占用时给人话、退出码非 0，并且不留下孤儿 OpenCode 进程', async () => {
  const { createServer } = await import('node:net');
  // 先自己占一个口，再让程序去抢，复现用户最常见的那种失败。
  const squatter = createServer();
  await new Promise((resolve) => squatter.listen(0, '127.0.0.1', resolve));
  const port = squatter.address().port;

  // 假 OpenCode + 临时数据目录：这条测的是「失败后收没收摊」，
  // 不该碰真实 OpenCode，更不该动用户自己的数据目录。
  const dir = mkdtempSync(join(tmpdir(), 'oc-cli-'));
  const pidFile = join(dir, 'opencode.pid');
  const fakeOpencode = join(dir, 'opencode');
  writeFileSync(fakeOpencode, fakeOpencodeSource(pidFile));
  chmodSync(fakeOpencode, 0o755);

  try {
    await run(NODE, [join(root, 'src/main.js')], {
      timeout: 60_000,
      env: {
        ...process.env,
        OCF_PORT: String(port),
        OCF_DATA_DIR: join(dir, 'data'),
        OCF_OPENCODE_PATH: fakeOpencode,
        ...isolatedTargetEnv(dir),
      },
    });
    assert.fail('端口被占时不应该正常退出');
  } catch (err) {
    assert.equal(err.code, 1, '退出码应当是 1');
    const text = `${err.stdout}\n${err.stderr}`;
    assert.match(text, /已经被别的程序占着/, '要说人话，不能丢 listen EADDRINUSE');
    assert.match(text, /lsof/, '要告诉用户怎么查是谁占的');
    assert.match(text, /OCF_PORT=/, '要告诉用户怎么换端口');
    assert.doesNotMatch(text, /EADDRINUSE/, '别把原始报错直接丢给小白用户');

    // 失败退出前要把已经拉起来的 OpenCode 收掉，否则每失败一次就多一个后台进程。
    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(Number.isInteger(pid) && pid > 0, '假 OpenCode 应当真被拉起来过');
    assert.ok(await waitGone(pid), `启动失败后不该留下孤儿 OpenCode 进程（PID ${pid} 还活着）`);
  } finally {
    squatter.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('桌面面板没装依赖时说清楚，并且退出码非 0', async (t) => {
  // 这条挡的是两个真实的坑凑在一起：electron 没装时 npm 会打印
  // `command not found`，但**退出码仍然是 0**，用户只看到一个没反应的黑框。
  //
  // 注意：这个分支只有在「没装依赖」时才能测。装过 npm install 的机器上
  // electron 是存在的，这里就去启动真窗口了，所以那种情况直接跳过。
  const { createRequire } = await import('node:module');
  const require = createRequire(join(root, 'package.json'));
  let installed = false;
  try {
    installed = Boolean(require.resolve('electron'));
  } catch {
    installed = false;
  }
  if (installed) {
    t.skip('本机已装 electron，这条分支测不到（跑 npm install 之前才会走到）');
    return;
  }

  try {
    await run(NODE, [join(root, 'scripts/desktop.mjs')], { timeout: 30_000 });
    assert.fail('没装 electron 时不应该正常退出');
  } catch (err) {
    assert.equal(err.code, 1, '退出码应当是 1，不能骗人');
    const text = `${err.stdout}\n${err.stderr}`;
    assert.match(text, /npm install/, '要告诉用户跑哪条命令');
    assert.match(text, /npm run desktop/, '要告诉用户装完再怎么启动');
    assert.match(text, /npm start/, '顺带告诉只想用命令行的人可以跳过它');
  }
});

test('启动后登记服务（npm stop 靠它找人），收到 SIGTERM 时把登记清掉', async () => {
  // 这条测的是「另一个进程能不能管到这个实例」：启动时写 service.json，
  // 正常收摊时删掉。没有它，npm stop / npm restart 就无从下手。
  const dir = mkdtempSync(join(tmpdir(), 'oc-cli-svc-'));
  const dataDir = join(dir, 'data');
  const fakeOpencode = join(dir, 'opencode');
  writeFileSync(fakeOpencode, fakeOpencodeSource(join(dir, 'opencode.pid')));
  chmodSync(fakeOpencode, 0o755);

  const child = spawn(NODE, [join(root, 'src/main.js')], {
    env: {
      ...process.env,
      OCF_PORT: '0', // 让系统分配，测试不抢固定端口
      OCF_DATA_DIR: dataDir,
      OCF_OPENCODE_PATH: fakeOpencode,
      // 收摊时会实读并摘除所有目标；路径全部指向临时目录，绝不碰真实用户配置。
      ...isolatedTargetEnv(dir),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));

  try {
    const servicePath = join(dataDir, 'service.json');
    await waitFor(() => existsSync(servicePath), 20_000, '等服务登记写出来');
    const info = JSON.parse(readFileSync(servicePath, 'utf8'));
    assert.equal(info.pid, child.pid, '登记的应该是这个进程自己');
    assert.ok(Number.isInteger(info.port) && info.port > 0, '要登记真实的转发口端口');
    assert.equal(info.mode, 'start');

    child.kill('SIGTERM');
    const code = await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(code, 0, '正常收摊应当退出码 0');
    assert.equal(existsSync(servicePath), false, '退出前要把登记清掉，否则 npm stop 会看到过期记录');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});
