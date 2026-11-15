/**
 * OpenCode 本机安装与运行状态检测。
 *
 * 用于打开软件或轮询状态时向界面提供清晰提示：
 *   1. OpenCode（CLI 或桌面端）是否已安装；
 *   2. 独立 OpenCode 应用或进程当前是否已在运行（排除 OC Faucet 自己拉起的托管子进程）。
 */
import { execFile as execFileCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { findOpencodeExecutable } from './oc-client.js';

const execFileAsync = promisify(execFileCallback);

export const OPENCODE_INSTALL_URL = 'https://opencode.ai';

function defaultDesktopPaths(platform, home, env) {
  if (platform === 'darwin') {
    return ['/Applications/OpenCode.app', join(home, 'Applications', 'OpenCode.app')];
  }
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
    return [
      join(localAppData, 'Programs', 'OpenCode', 'OpenCode.exe'),
      join(localAppData, 'OpenCode', 'OpenCode.exe'),
      join(programFiles, 'OpenCode', 'OpenCode.exe'),
    ];
  }
  return [
    join(home, '.local', 'share', 'applications', 'opencode.desktop'),
    '/usr/share/applications/opencode.desktop',
  ];
}

function isIgnoredHelper(args) {
  return /(?:ShipIt|Crashpad|OpenCode Helper|oc-faucet|OC Faucet)/i.test(args);
}

function isExternalOpencodeCommand(args) {
  if (!args || isIgnoredHelper(args)) return false;
  if (/(?:^|\/|\s)OpenCode\.app\/Contents\/MacOS\/OpenCode(?:\s|$)/.test(args)) return true;
  if (/(?:^|\/|\s)cli\/[^/\s]+\/opencode-cli(?:\s|$)/i.test(args)) return true;
  const firstToken = args.trim().split(/\s+/)[0] ?? '';
  return /(?:^|\/)opencode(?:-cli)?(?:\.exe)?$/i.test(firstToken) || /\.app\/Contents\/MacOS\/OpenCode$/i.test(firstToken);
}

/**
 * 解析 Unix `ps -ax -o pid=,ppid=,args=` 输出并过滤掉 OC Faucet 自己的子进程。
 */
export function parseUnixOpencodeProcesses(stdout, ownPids = []) {
  const excluded = new Set([process.pid, ...ownPids].filter((pid) => Number.isInteger(pid) && pid > 0));
  const pids = [];
  for (const rawLine of String(stdout ?? '').split(/\r?\n/)) {
    const match = rawLine.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const args = match[3];
    if (excluded.has(pid) || excluded.has(ppid)) continue;
    if (isExternalOpencodeCommand(args)) pids.push(pid);
  }
  return pids;
}

/**
 * 解析 Windows PowerShell 进程 JSON 并过滤掉 OC Faucet 自己的子进程。
 */
export function parseWindowsOpencodeProcesses(stdout, ownPids = []) {
  const trimmed = String(stdout ?? '').trim();
  if (!trimmed) return [];
  const excluded = new Set([process.pid, ...ownPids].filter((pid) => Number.isInteger(pid) && pid > 0));
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const pids = [];
  for (const item of items) {
    const pid = Number(item?.ProcessId);
    const ppid = Number(item?.ParentProcessId);
    if (!Number.isInteger(pid) || pid <= 0 || excluded.has(pid) || excluded.has(ppid)) continue;
    const cmd = String(item?.CommandLine ?? item?.Name ?? '');
    if (isIgnoredHelper(cmd)) continue;
    if (/^(?:opencode|opencode-cli|OpenCode)(?:\.exe)?$/i.test(String(item?.Name ?? ''))) {
      pids.push(pid);
    }
  }
  return pids;
}

async function detectExternalProcesses({ platform, ownPids, execFileImpl }) {
  try {
    if (platform === 'win32') {
      const { stdout } = await execFileImpl(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(opencode|opencode-cli|OpenCode)(\\.exe)?$' } | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress",
        ],
        { timeout: 2500, windowsHide: true },
      );
      return parseWindowsOpencodeProcesses(stdout, ownPids);
    }
    const { stdout } = await execFileImpl('ps', ['-ax', '-o', 'pid=,ppid=,args='], { timeout: 2500 });
    return parseUnixOpencodeProcesses(stdout, ownPids);
  } catch {
    return [];
  }
}

/**
 * 检查本机 OpenCode 的安装情况与独立运行状态。
 */
export async function inspectOpencodeEnv({
  explicitPath,
  ownPids = [],
  platform = process.platform,
  home = homedir(),
  env = process.env,
  pathExists = existsSync,
  discoverImpl = findOpencodeExecutable,
  execFileImpl = execFileAsync,
  now = Date.now,
} = {}) {
  const cli = discoverImpl(explicitPath, env.PATH ?? '', home);
  const cliPath = cli?.found ?? null;
  const appPath = defaultDesktopPaths(platform, home, env).find((candidate) => {
    try {
      return Boolean(candidate && pathExists(candidate));
    } catch {
      return false;
    }
  }) ?? null;

  const installed = Boolean(cliPath || appPath);
  const externalPids = installed
    ? await detectExternalProcesses({ platform, ownPids, execFileImpl })
    : [];

  return {
    installed,
    cliInstalled: Boolean(cliPath),
    appInstalled: Boolean(appPath),
    path: cliPath ?? appPath ?? null,
    cliPath,
    appPath,
    externalRunning: externalPids.length > 0,
    externalPids,
    installUrl: OPENCODE_INSTALL_URL,
    checkedAt: now(),
  };
}
