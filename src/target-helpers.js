/**
 * 接入目标模块共用的写入纪律小件。
 *
 * dsh / qoder / workbuddy / codebuddy 四个目标模块原本各自重复同一套东西：
 * install 入口的参数校验（port / apiKey / models 三件套 + 逐模型 id）、
 * 「同一天只备一份」的写前备份、临时文件 + rename 的原子替换（0600）、
 * 「读旧 → 比对 → 备份 → 原子写」的写盘骨架。收在这里，各模块只留自己的
 * 特殊流程（DSH 的受管块与写前重读、WorkBuddy 的锁文件与投影比对等）。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { BridgeError } from './errors.js';

/**
 * install 入口的校验。label 是目标显示名，只用于报错文案。
 * 除了 port / apiKey / models 三件套，还逐模型校验 id：统一 id 约定是
 * `${providerID}/${modelID}`（见 docs/接口约定.md §2），缺 id 或没有斜杠的条目
 * 写进任何目标都是垃圾数据，必须在写盘前整批拦下。
 * @param {unknown} models
 * @param {{port?:unknown, apiKey?:unknown}} o
 * @param {string} label 形如 'DSH' / 'qoder' / 'WorkBuddy' / 'CodeBuddy'
 */
export function assertInstallArgs(models, { port, apiKey } = {}, label) {
  if (!Number.isInteger(port) || port <= 0) {
    throw new BridgeError(`转发口端口不合法，无法写入 ${label} 配置`, 500, 'bad_port');
  }
  if (typeof apiKey !== 'string' || !apiKey) {
    throw new BridgeError(`本机密钥缺失，无法写入 ${label} 配置`, 500, 'bad_key');
  }
  if (!Array.isArray(models)) {
    throw new BridgeError(`模型清单不合法，无法写入 ${label} 配置`, 500, 'bad_models');
  }
  for (const m of models) {
    if (!m || typeof m.id !== 'string' || !m.id || !m.id.includes('/')) {
      throw new BridgeError(`模型清单里有条目缺少合法的 id（形如 provider/model），无法写入 ${label} 配置`, 500, 'bad_models');
    }
  }
}

/**
 * 写前备份当前内容。同一天只备一份（文件名带日期，已存在就跳过），
 * 避免每次刷新都堆一堆文件。备份失败不算致命——写配置本身更重要。
 */
export async function backupOnceDaily(file, existing) {
  try {
    const stamp = new Date().toISOString().slice(0, 10);
    const target = join(dirname(file), `${basename(file)}.oc-faucet-backup-${stamp}`);
    if (existsSync(target)) return;
    await writeFile(target, existing, { mode: 0o600 });
  } catch {
    /* 备份是尽力而为 */
  }
}

/**
 * 原子替换：先写临时文件再 rename，崩溃也不会留下写了一半的配置。
 * 文件权限 0600——里面有明文密钥。调用方自己负责先建好父目录。
 */
export async function writeAtomic0600(file, payload) {
  const tmp = `${file}.oc-faucet.tmp`;
  await writeFile(tmp, payload, { mode: 0o600 });
  await rename(tmp, file);
}

/** 确保配置文件的父目录存在（0700：里面会有明文密钥） */
export async function ensureParentDir(file) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
}

/**
 * 写盘骨架：读旧 → 内容没变不写 → 备份旧文 → 原子替换（0600）。
 * dsh / qoder / codebuddy 三处的私有副本同构，收敛到这一个；
 * 备份默认走「同一天一份」的 backupOnceDaily，模块要留自己的备份命名时
 * 经 options.backup 换掉（保持各模块现有备份命名）。
 *
 * @param {string} file 目标文件绝对路径
 * @param {string} nextText 要写出的完整文本
 * @param {object} [options]
 * @param {(file:string, existing:string)=>Promise<void>} [options.backup]
 * @returns {Promise<{changed:boolean}>}
 */
export async function writeTextIfChanged(file, nextText, { backup = backupOnceDaily } = {}) {
  await ensureParentDir(file);
  let existing = null;
  try {
    existing = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (existing === nextText) return { changed: false };
  if (existing !== null) await backup(file, existing);
  await writeAtomic0600(file, nextText);
  return { changed: true };
}

/**
 * 「被我们覆盖的用户原值」快照：存在 OC Faucet 自己的数据目录里，
 * 这样摘除时能把目标配置文件还原成接入前的样子。读不到或读坏了都当空快照，
 * 大不了退化成「只删我们的键」，绝不会因此写坏目标配置。
 */
export async function readOwnerSnapshot(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function writeOwnerSnapshot(file, owner) {
  await ensureParentDir(file);
  await writeAtomic0600(file, `${JSON.stringify(owner, null, 2)}\n`);
}
