/**
 * 本机设置与密钥。
 *
 * 数据目录（macOS）：~/Library/Application Support/OC Faucet
 * 里面放：settings.json（用户可选设置）、api-key（本机转发口密钥）、
 *        probe-cache.json（模型判定缓存）、requests.jsonl（请求日志）、
 *        workspace/（OpenCode 会话的工作目录）
 */
import { readFile, writeFile, mkdir, chmod, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { BridgeError } from './errors.js';
import { normalizeBlockedModelId } from './models.js';

const APP_DIR_NAME = 'OC Faucet';

/** 数据目录绝对路径。OCF_DATA_DIR 可以覆盖（测试与排障用）。 */
export function dataDir() {
  return process.env.OCF_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', APP_DIR_NAME);
}

export function settingsFile() {
  return join(dataDir(), 'settings.json');
}

export function apiKeyFile() {
  return join(dataDir(), 'api-key');
}

export function probeCacheFile() {
  return join(dataDir(), 'probe-cache.json');
}

export function requestsLogFile() {
  return join(dataDir(), 'requests.jsonl');
}

export function workspaceDir() {
  return join(dataDir(), 'workspace');
}

/** 确保目录结构存在 */
export async function ensureLayout() {
  await mkdir(dataDir(), { recursive: true, mode: 0o700 });
  await mkdir(workspaceDir(), { recursive: true, mode: 0o700 });
}

/** 本机转发口密钥。没有就生成一个，权限 0600。 */
export async function apiKey() {
  const file = apiKeyFile();
  if (existsSync(file)) {
    const key = (await readFile(file, 'utf8')).trim();
    if (key) return key;
  }
  const key = `ocf-${randomBytes(24).toString('base64url')}`;
  await mkdir(dataDir(), { recursive: true, mode: 0o700 });
  await writeFile(file, `${key}\n`, { mode: 0o600 });
  try {
    await chmod(file, 0o600);
  } catch {
    /* 尽力而为 */
  }
  return key;
}

/**
 * 保存新的转发口密钥（原子写，权限 0600）。
 *
 * 去掉首尾空格后是空的就直接拒：空密钥等于把本机转发口对全机器敞开，
 * 这个口子不能开。返回实际保存的密钥（去过空格）。
 */
export async function saveApiKey(newKey) {
  const key = typeof newKey === 'string' ? newKey.trim() : '';
  if (!key) {
    throw new BridgeError(
      '新密钥没法保存：去掉首尾空格之后什么都不剩了。请填入至少一个字符的密钥；不想改的话直接取消就好，现在的密钥不受影响。',
      400,
      'invalid_api_key',
    );
  }
  await mkdir(dataDir(), { recursive: true, mode: 0o700 });
  const file = apiKeyFile();
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${key}\n`, { mode: 0o600 });
  await rename(tmp, file);
  try {
    await chmod(file, 0o600);
  } catch {
    /* 尽力而为 */
  }
  return key;
}

const DEFAULTS = {
  port: 41982,
  probeConcurrency: 3,
  probeTtlMinutes: 360,
  theme: 'system',
  // 上游方案：embedded = 内嵌隔离 OpenCode（默认）；masquerade = Bun 侧车直连 zen
  upstreamMode: 'embedded',
  // 路由器广播：转发口是否对局域网开放（默认只绑 127.0.0.1）
  lanAccess: false,
  modelContextWindows: {},
  modelContextWindowOriginals: {},
  modelContextWindowPending: {},
  // 按接入目标记住「这次要写入哪些模型」；没记的就是全部可用模型
  targetModels: {},
  // 按模型 ID 屏蔽的模型（支持完整 `provider/model` 或简写 `model`）
  blockedModels: [],
  // 同步给各接入工具（如 ZCode / Claude / Codex）的上下文上限，防止客户端长期不压缩上下文耗光免费额度；null 表示不限制
  targetContextCap: 128000,
  // 显式开启时才把本机 OpenCode auth.json 里的 `opencode` 条目同步进隔离环境；绝不带入其它供应商凭据
  shareOpencodeAuth: false,
  // 自动检测本机 OpenCode CLI 的新版并升级（官方 `opencode upgrade`；显式指定过路径的不动）
  opencodeAutoUpdate: true,
};

function cloneDefaults() {
  return {
    ...DEFAULTS,
    modelContextWindows: {},
    modelContextWindowOriginals: {},
    modelContextWindowPending: {},
    targetModels: {},
    blockedModels: [],
  };
}

export function sanitizeTargetContextCap(raw, fallback = DEFAULTS.targetContextCap) {
  if (raw === null || raw === 0 || raw === '0' || raw === false) return null;
  if (raw === undefined || raw === '') return fallback;
  const num = Number(raw);
  if (Number.isInteger(num) && num >= 1024 && num <= 10_000_000) return num;
  return fallback;
}

function sanitizeBlockedModels(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const result = [];
  for (const item of raw) {
    const id = normalizeBlockedModelId(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/** 读设置。坏文件回落到默认值，不抛异常——配置坏了不该让程序起不来。 */
export async function readSettings() {
  const file = settingsFile();
  if (!existsSync(file)) return cloneDefaults();
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return cloneDefaults();
    return sanitize({ ...cloneDefaults(), ...parsed });
  } catch {
    return cloneDefaults();
  }
}

/** 只接受合法范围内的值，越界的静默回落到默认——避免一个手改坏的数字让服务起不来。 */
function sanitize(s) {
  const port = Number(s.port);
  const concurrency = Number(s.probeConcurrency);
  const ttl = Number(s.probeTtlMinutes);
  const modelContextWindows = {};
  const modelContextWindowOriginals = {};
  const modelContextWindowPending = {};
  if (
    s.modelContextWindows &&
    typeof s.modelContextWindows === 'object' &&
    !Array.isArray(s.modelContextWindows)
  ) {
    for (const [id, value] of Object.entries(s.modelContextWindows)) {
      const separator = id.indexOf('/');
      if (separator > 0 && separator < id.length - 1 && Number.isSafeInteger(value) && value > 0) {
        modelContextWindows[id] = value;
      }
    }
  }
  if (
    s.modelContextWindowOriginals &&
    typeof s.modelContextWindowOriginals === 'object' &&
    !Array.isArray(s.modelContextWindowOriginals)
  ) {
    for (const [id, value] of Object.entries(s.modelContextWindowOriginals)) {
      const separator = id.indexOf('/');
      if (
        separator <= 0 ||
        separator === id.length - 1 ||
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value)
      ) {
        continue;
      }
      const context = value.context;
      const output = value.output;
      if (!Number.isSafeInteger(context) || context <= 0 || !Number.isSafeInteger(output) || output <= 0) {
        continue;
      }
      const original = { context, output };
      if (Number.isSafeInteger(value.input) && value.input >= 0) original.input = value.input;
      modelContextWindowOriginals[id] = original;
    }
  }
  if (
    s.modelContextWindowPending &&
    typeof s.modelContextWindowPending === 'object' &&
    !Array.isArray(s.modelContextWindowPending)
  ) {
    for (const [id, value] of Object.entries(s.modelContextWindowPending)) {
      const separator = id.indexOf('/');
      if (
        separator > 0 &&
        separator < id.length - 1 &&
        (value === null || (Number.isSafeInteger(value) && value > 0))
      ) {
        modelContextWindowPending[id] = value;
      }
    }
  }
  const targetModels = {};
  if (s.targetModels && typeof s.targetModels === 'object' && !Array.isArray(s.targetModels)) {
    for (const [id, value] of Object.entries(s.targetModels)) {
      if (!id || !Array.isArray(value)) continue;
      const ids = [...new Set(value.filter((item) => typeof item === 'string' && item.includes('/')))];
      if (ids.length) targetModels[id] = ids;
    }
  }
  return {
    port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULTS.port,
    probeConcurrency:
      Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 6 ? concurrency : DEFAULTS.probeConcurrency,
    probeTtlMinutes: Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULTS.probeTtlMinutes,
    theme: ['system', 'light', 'dark'].includes(s.theme) ? s.theme : DEFAULTS.theme,
    upstreamMode: ['embedded', 'masquerade'].includes(s.upstreamMode) ? s.upstreamMode : DEFAULTS.upstreamMode,
    lanAccess: s.lanAccess === true,
    modelContextWindows,
    modelContextWindowOriginals,
    modelContextWindowPending,
    targetModels,
    blockedModels: sanitizeBlockedModels(s.blockedModels),
    targetContextCap: sanitizeTargetContextCap(s.targetContextCap, DEFAULTS.targetContextCap),
    shareOpencodeAuth: typeof s.shareOpencodeAuth === 'boolean' ? s.shareOpencodeAuth : DEFAULTS.shareOpencodeAuth,
    opencodeAutoUpdate: typeof s.opencodeAutoUpdate === 'boolean' ? s.opencodeAutoUpdate : DEFAULTS.opencodeAutoUpdate,
  };
}

let settingsWriteQueue = Promise.resolve();

/** 写设置（串行原子替换，避免并发保存互相覆盖） */
export function writeSettings(patch) {
  const write = settingsWriteQueue.then(() => writeSettingsNow(patch));
  settingsWriteQueue = write.catch(() => {});
  return write;
}

async function writeSettingsNow(patch) {
  const current = await readSettings();
  const next = sanitize({ ...current, ...patch });
  await mkdir(dataDir(), { recursive: true, mode: 0o700 });
  const file = settingsFile();
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  const { rename } = await import('node:fs/promises');
  await rename(tmp, file);
  return next;
}

/** 最终生效的端口：环境变量 > 设置 > 默认 */
export async function resolvePort() {
  const envPort = Number(process.env.OCF_PORT);
  if (Number.isInteger(envPort) && envPort >= 0 && envPort <= 65535) return envPort;
  const { port } = await readSettings();
  return port;
}
