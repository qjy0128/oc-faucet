#!/usr/bin/env node
/**
 * 命令行服务控制：npm stop / npm restart。
 *
 * 这两个命令要解决的事：服务是前台跑的（npm start / npm run web），
 * 想停它、重启它，不必再回到那个终端窗口按 Ctrl+C。
 *
 *   npm stop      让正在跑的实例自己收摊（关 OpenCode、关端口、删登记）
 *   npm restart   停掉旧的，再按原来的方式（命令行 / 控制面板）重新拉起来
 *
 * 它只认「数据目录里的 service.json」——桌面版（npm run desktop）不在这份记录里，
 * 那个请用托盘菜单退出。
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readServiceInfo, stopRunning } from '../src/service-control.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAIN = join(ROOT, 'src', 'main.js');
const ACTION = process.argv[2];
/** 等服务自己退出的上限：正常收摊（关面板、关 OpenCode）几秒内就完 */
const STOP_TIMEOUT_MS = 15_000;

/** 描述一下这次停掉的是谁，给人看 */
function describe(result) {
  const bits = [`PID ${result.pid}`];
  if (result.port) bits.push(`转发口 ${result.port}`);
  if (result.webPort) bits.push(`控制面板 ${result.webPort}`);
  return bits.join('，');
}

async function stop() {
  const result = await stopRunning({
    timeoutMs: STOP_TIMEOUT_MS,
    log: (message) => console.log(`  ${message}`),
  });

  if (!result.wasRunning && !result.stale) {
    console.log('没有正在运行的 OC Faucet（没找到服务记录）。');
    return;
  }
  if (result.stale) {
    console.log(`之前的记录已经过期了（PID ${result.pid} 早就不在了），已清掉，不需要再停。`);
    return;
  }
  if (result.stopped) {
    console.log(`OC Faucet 已停止（${describe(result)}）。`);
    return;
  }

  console.error(`\n停下来失败了：PID ${result.pid} 在 ${Math.round(STOP_TIMEOUT_MS / 1000)} 秒内没有退出。`);
  console.error('它可能卡住了。可以再执行一次 npm stop；还不行的话看下请求日志：lsof -nP -iTCP:41982');
  process.exitCode = 1;
}

async function restart() {
  // 先记下旧实例是怎么启动的：命令行还是带控制面板，重启后保持原样。
  const before = await readServiceInfo();
  const mode = before?.mode ?? 'start';

  const result = await stopRunning({ log: (message) => console.log(`  ${message}`) });
  if (result.wasRunning && result.stopped) {
    console.log(`旧实例已停止（${describe(result)}）。`);
  } else if (result.wasRunning) {
    console.error(
      `旧实例（PID ${result.pid}）没能在 ${Math.round(STOP_TIMEOUT_MS / 1000)} 秒内退出，先不启动新的，免得抢同一个端口。`,
    );
    process.exitCode = 1;
    return;
  } else if (result.stale) {
    console.log(`之前的记录已经过期了（PID ${result.pid} 早就不在了），已清掉。`);
  } else {
    console.log('没有正在运行的旧实例，直接启动。');
  }

  const args = [MAIN];
  if (mode === 'web') args.push('--web');

  // 端口沿用旧实例的：已写入的工具配置里记着那个端口，换了端口它们就连不上了。
  // 如果这次命令行自己指定了 OCF_PORT / OCF_WEB_PORT，以命令行为准。
  const env = { ...process.env };
  if (env.OCF_PORT === undefined && Number.isInteger(before?.port) && before.port > 0) {
    env.OCF_PORT = String(before.port);
  }
  if (env.OCF_WEB_PORT === undefined && Number.isInteger(before?.webPort) && before.webPort > 0) {
    env.OCF_WEB_PORT = String(before.webPort);
  }

  console.log(`\n正在启动${mode === 'web' ? '（带控制面板）' : ''}……\n`);

  const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: 'inherit' });
  child.on('error', (error) => {
    console.error(`启动失败：${error?.message ?? error}`);
    process.exit(1);
  });

  // 终端里的 Ctrl+C 会同时发给父进程和子进程。父进程要装作没听见，
  // 让子进程自己走完收摊流程，不然父进程先死、子进程就成了没终端管的孤儿。
  const ignore = () => {};
  process.on('SIGINT', ignore);
  process.on('SIGTERM', ignore);

  child.on('exit', (code, signal) => {
    process.exit(code ?? (signal === 'SIGINT' ? 0 : 1));
  });
}

switch (ACTION) {
  case 'stop':
    await stop();
    break;
  case 'restart':
    await restart();
    break;
  default:
    console.error('用法：node scripts/service.mjs <stop|restart>');
    process.exitCode = 1;
}
