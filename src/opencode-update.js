/**
 * OpenCode CLI 自动更新（仅内嵌方案用）。
 *
 * 版本源用 npm registry 的 @opencode/cli/latest：无需鉴权、返回小 JSON，和官方
 * 安装脚本是同一个发布通道（项目零依赖，用 Node 内置 fetch）。升级动作用官方
 * `opencode upgrade` 子命令：非交互、幂等——已是最新时输出 skipped 并正常退出，
 * 下载与替换（含回滚旧版）都由它自己处理。
 *
 * 安全边界（每一条都有讲究）：
 *   - 巡检只对照版本、只报告；升级一律经用户在面板上确认后手动触发；
 *   - 显式指定过 OpenCode 路径（OCF_OPENCODE_PATH / opencodePath）的不碰：
 *     那是用户自己挑的版本，动它之前应该先问用户；
 *   - 升级成功后由调用方重启服务让新版生效（运行中的隔离进程用的是旧映像，
 *     Unix 下替换文件不影响它，不会中途坏掉）；
 *   - 任何一步失败都不影响正在运行的服务：记状态、下一轮（24 小时后）再试。
 */
import { spawn } from 'node:child_process';

/** npm registry 上 @opencode/cli 的 latest 元数据。 */
export const NPM_LATEST_URL = 'https://registry.npmjs.org/@opencode/cli/latest';

/** 两轮检查之间的间隔：跟着「检查更新每 24 小时一次」的应用内惯例走。 */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** 读本地版本的超时：`--version` 是瞬时的，卡住说明二进制有问题。 */
const VERSION_TIMEOUT_MS = 5_000;
/** 拉最新版本号的超时：这只是一个小 JSON，10 秒足够。 */
const FETCH_TIMEOUT_MS = 10_000;
/** 官方 upgrade 下载整个二进制，慢网络也要给足。 */
const UPGRADE_TIMEOUT_MS = 5 * 60 * 1000;

/** Windows 的 .cmd/.bat 不是可执行映像，必须经 shell；给路径加引号保住其中的空格。 */
function spawnBin(bin, args, options = {}) {
  const shell = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(bin);
  return spawn(shell ? `"${bin}"` : bin, args, { ...options, shell });
}

/**
 * 读本机 OpenCode 的完整版本号（如 '2.3.0'）。
 * 读不出（超时 / 输出里没有版本串 / 非零退出）返回 null，绝不抛——
 * 自动更新是锦上添花，不该让坏二进制把服务拖住。
 */
export function readOpencodeVersion(binPath) {
  return new Promise((resolve) => {
    let output = '';
    let child;
    try {
      child = spawnBin(binPath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve(null);
      return;
    }
    const finish = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(null);
    }, VERSION_TIMEOUT_MS);
    child.stdout?.on('data', (chunk) => { output = `${output}${chunk}`.slice(-4_000); });
    child.stderr?.on('data', (chunk) => { output = `${output}${chunk}`.slice(-4_000); });
    child.once('error', () => finish(null));
    child.once('exit', (code) => {
      const match = /\bv?(\d+\.\d+(?:\.\d+)?)/.exec(output);
      finish(code === 0 && match ? match[1] : null);
    });
  });
}

/**
 * 问 npm registry 要最新版本号。网络失败、超时、返回的 version 不是 x.y.z 形状，
 * 一律返回 null（下一轮再试），不抛。
 */
export async function fetchLatestOpencodeVersion({ fetchImpl = fetch, url = NPM_LATEST_URL, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) return null;
    const version = (await response.json())?.version;
    return typeof version === 'string' && /^\d+\.\d+(\.\d+)?$/.test(version) ? version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 逐段数字比较：latest 是否严格新于 current。任何一边读不出都算不新。 */
export function isNewerVersion(latest, current) {
  if (!latest || !current) return false;
  const parts = (value) => value.split('.').map((piece) => Number(piece));
  const left = parts(latest);
  const right = parts(current);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

/**
 * 跑官方 `opencode upgrade`。退出码 0 视为成功（包括「已是最新」的 skipped），
 * 其余一律 { ok:false }，输出截尾带回给日志。
 */
export function upgradeOpencode(binPath, { timeoutMs = UPGRADE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let output = '';
    let child;
    try {
      child = spawnBin(binPath, ['upgrade'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, output: String(error?.message ?? error) });
      return;
    }
    const finish = (result) => {
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ ok: false, output: `${output}\n（超时被中止）`.trim() });
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { output = `${output}${chunk}`.slice(-4_000); });
    child.stderr?.on('data', (chunk) => { output = `${output}${chunk}`.slice(-4_000); });
    child.once('error', (error) => finish({ ok: false, output: String(error?.message ?? error) }));
    child.once('exit', (code, signal) => {
      if (code === 0) finish({ ok: true, output: output.trim() });
      else finish({ ok: false, output: `${output}\n（退出码 ${code ?? signal}）`.trim() });
    });
  });
}

/**
 * 造一个巡检器。main.js 只负责接线：locate 找二进制、isEnabled 读设置。
 * 所有依赖都从这里注入，测试不触网不起真进程。
 *
 * 只检查、只报告：发现新版记 status='available'，升级动作统一由用户在面板上
 * 经「检测 OpenCode 更新」确认后触发（见 main.js 的 upgradeOpencodeNow）。
 *
 * state 直接挂在返回对象上（面板快照透出）：
 *   enabled      设置开关（只读镜像，以设置文件为准）
 *   version      本机版本 / latest 最新版（读不到为 null）
 *   checkedAt    上次检查时间
 *   status       idle | off | manual-path | not-found | checking | latest
 *                | available | upgrading | upgraded | error
 */
export function createAutoUpdater({
  locate,
  isEnabled = async () => true,
  readVersion = readOpencodeVersion,
  fetchLatest = fetchLatestOpencodeVersion,
  log = () => {},
  intervalMs = CHECK_INTERVAL_MS,
} = {}) {
  const state = { enabled: null, version: null, latest: null, checkedAt: null, status: 'idle' };
  let timer = null;
  let busy = false;
  // cancel 置位后不再自动排下一轮；schedule 重新置零（服务重启后恢复巡检）
  let stopped = false;

  const schedule = (delayMs = 0) => {
    stopped = false;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, delayMs);
    timer.unref?.();
  };

  async function run() {
    if (busy) return;
    busy = true;
    try {
      state.enabled = await isEnabled();
      if (state.enabled !== true) {
        state.status = 'off';
        return;
      }
      const located = locate?.();
      if (!located?.path) {
        state.status = 'not-found';
        return;
      }
      if (located.explicit === true) {
        state.status = 'manual-path';
        return;
      }
      state.status = 'checking';
      state.version = await readVersion(located.path);
      state.latest = await fetchLatest();
      state.checkedAt = new Date().toISOString();
      if (!state.version || !state.latest) {
        state.status = 'error';
        log(`OpenCode 版本这一轮没查成（本机 ${state.version ?? '？'}，最新 ${state.latest ?? '？'}），稍后再试。`);
        return;
      }
      // 只报告，不自动升：升级动作统一走面板「检测 OpenCode 更新」按钮的确认流程
      state.status = isNewerVersion(state.latest, state.version) ? 'available' : 'latest';
      if (state.status === 'available') {
        log(`OpenCode 有新版 ${state.latest}（本机 ${state.version}）。到「说明与设置」里点「检测 OpenCode 更新」确认升级。`);
      }
    } finally {
      busy = false;
      // 无论这一轮结果如何，下一轮照常排上（已 cancel 的除外；关掉开关的话 run 入口会直接停）
      if (!stopped) schedule(intervalMs);
    }
  }

  return {
    state,
    schedule,
    /** 只读本机版本填进状态（不触网），给面板常显当前版本用；找不到或读不出就保持原样 */
    async refreshVersion() {
      const located = locate?.();
      if (!located?.path) return;
      const version = await readVersion(located.path);
      if (version) state.version = version;
    },
    /** 停掉后续排期（服务停了就不该再有动作）；正在跑的检查让它自然结束 */
    cancel() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
