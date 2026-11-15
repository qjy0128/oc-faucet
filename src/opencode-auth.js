/**
 * OpenCode 本机账号登录态（仅限 opencode 条目）的受控同步。
 *
 * 默认严格隔离：隔离 OpenCode 子进程拿不到用户本机的任何 auth.json 或第三方 API Key。
 * 当用户显式开启「复用本机 OpenCode 登录态」时，只提取并同步 auth.json 里的
 * `opencode` 条目到隔离 runtimeRoot 内部，**绝不读取或复制** openai / anthropic /
 * alibaba / deepseek 等任何第三方付费供应商凭据，也不把其它供应商暴露进模型清单。
 */
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const MARKER_FILENAME = '.oc-faucet-shared-auth';

/** 枚举本机 OpenCode 可能保存 auth.json 的标准位置（只读）。 */
export function nativeAuthCandidates({
  platform = process.platform,
  env = process.env,
  home = homedir(),
} = {}) {
  const explicit = env.OCF_NATIVE_OPENCODE_AUTH;
  if (typeof explicit === 'string' && explicit.trim()) {
    return [explicit.trim()];
  }
  const out = [];
  if (typeof env.XDG_DATA_HOME === 'string' && env.XDG_DATA_HOME.trim()) {
    out.push(join(env.XDG_DATA_HOME.trim(), 'opencode', 'auth.json'));
  }
  if (platform === 'win32' && typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA.trim()) {
    out.push(join(env.LOCALAPPDATA.trim(), 'opencode', 'auth.json'));
  }
  if (home) {
    out.push(join(home, '.local', 'share', 'opencode', 'auth.json'));
  }
  return [...new Set(out)];
}

/**
 * 从本机 OpenCode auth.json 中**仅提取 `opencode` 这一家**的认证条目。
 * 绝不返回其它供应商的凭据字段；文件不存在或解析失败返回 null。
 */
export async function readNativeOpencodeAuth(options = {}) {
  for (const file of nativeAuthCandidates(options)) {
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      const entry = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.opencode : null;
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        return structuredClone(entry);
      }
    } catch {
      /* 忽略坏掉的本机文件 */
    }
  }
  return null;
}

/** 提取适合直接放在 HTTP Authorization 头里的匿名替代 key（仅 api 类型且显式开启时用）。 */
export function extractOpencodeBearerKey(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.key === 'string' && entry.key.trim()) return entry.key.trim();
  if (typeof entry.access === 'string' && entry.access.trim()) return entry.access.trim();
  return null;
}

/**
 * 把受控的 `{ opencode }` 登录态写入（或清出）隔离 runtimeRoot 的 data/opencode/auth.json。
 *
 * @param {object} o
 * @param {string} o.runtimeRoot
 * @param {boolean} o.enabled
 * @param {object} [o.nativeOptions]
 * @returns {Promise<{ synced: boolean, hasAuth: boolean }>}
 */
export async function syncIsolatedOpencodeAuth({ runtimeRoot, enabled, nativeOptions } = {}) {
  if (!runtimeRoot) return { synced: false, hasAuth: false };
  const targetDir = join(runtimeRoot, 'data', 'opencode');
  const authFile = join(targetDir, 'auth.json');
  const markerFile = join(targetDir, MARKER_FILENAME);

  if (!enabled) {
    if (existsSync(markerFile)) {
      await rm(authFile, { force: true }).catch(() => {});
      await rm(markerFile, { force: true }).catch(() => {});
    }
    return { synced: false, hasAuth: false };
  }

  const entry = await readNativeOpencodeAuth(nativeOptions);
  if (!entry) {
    if (existsSync(markerFile)) {
      await rm(authFile, { force: true }).catch(() => {});
      await rm(markerFile, { force: true }).catch(() => {});
    }
    return { synced: true, hasAuth: false };
  }

  await mkdir(dirname(authFile), { recursive: true, mode: 0o700 });
  await writeFile(authFile, `${JSON.stringify({ opencode: entry }, null, 2)}\n`, { mode: 0o600 });
  await chmod(authFile, 0o600).catch(() => {});
  await writeFile(markerFile, '1\n', { mode: 0o600 });
  return { synced: true, hasAuth: true };
}
