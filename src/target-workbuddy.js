/**
 * WorkBuddy 接入目标。
 *
 * WorkBuddy（腾讯桌面 AI 应用）把用户自定义模型放在 ~/.workbuddy/models.json，
 * 文件有两种合法形态：裸数组 [{...}]，或 { "models": [...], "availableModels": [...] }。
 * 我们往里加「走本机转发口」的条目：OpenAI 兼容协议、url 是完整端点路径
 * （/v1/chat/completions 结尾）、明文 apiKey。每条都带 ocFaucetOwner 归属标记——
 * status / 合并 / 摘除全靠它认自己的条目；用户手写的条目（比如 MiniMax）一个字段都不许动。
 *
 * 写入纪律来自实测教训：WorkBuddy 常驻运行、可能并发改写这个文件：
 *   1. 锁文件 models.json.oc-faucet.lock 防并发；内容写时间戳，超过 5 分钟视为死锁可强占；
 *   2. 合并后不急着写——写前再读一次校验没被别人改过，被改过就基于新内容重新合并一次，
 *      仍冲突则整个放弃报错（一个字都不写，绝不破坏对方内容）；
 *   3. 幂等：内容没变不写盘。比对要容忍 WorkBuddy 的规范化（它会给条目补
 *      useCustomProtocol 等字段、调整键序）——只比对我们拥有的字段投影；
 *   4. 真写盘前备份 models.json.oc-faucet-<时间戳>.bak，只留最近 5 份；
 *   5. 临时文件 + rename 原子替换，文件权限 0600（里面有明文密钥）；
 *   6. 文件形态保持原样（裸数组写回裸数组，对象写回对象）；对象形态且本来就有
 *      availableModels 时把我们的 id 同步加进去/摘除时移除，没有就不新建。
 *
 * 路径注入：环境变量 OCF_WORKBUDDY_MODELS 覆盖 models.json 路径（测试用），
 * 锁文件与备份都跟着该路径走。
 */
import { readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { BridgeError } from './errors.js';
import { describeReasoning } from './efforts.js';
import { assertInstallArgs, ensureParentDir, writeAtomic0600 } from './target-helpers.js';

/** 归属标记的值。改这个值等于换一个身份，原有条目会被当成别人的 */
export const OWNER = 'oc-faucet-v1';

/** 锁文件超过 5 分钟没放掉就视为死锁（上一次写入崩了），允许强占 */
const LOCK_STALE_MS = 5 * 60 * 1000;

/** 备份最多留几份 */
const BACKUP_KEEP = 5;

/**
 * 我们条目里「拥有」的字段。幂等比对只看这些；
 * WorkBuddy 规范化补的字段（useCustomProtocol 之类）不参与比对，免得误判「内容变了」。
 */
const OWNED_ENTRY_KEYS = [
  'id',
  'name',
  'vendor',
  'url',
  'apiKey',
  'supportsToolCall',
  'supportsImages',
  'maxInputTokens',
  'ocFaucetOwner',
  'supportsReasoning',
  'onlyReasoning',
  'reasoning',
];
const OWNED_REASONING_KEYS = ['supportedEfforts', 'defaultEffort', 'canDisableThinking'];

/** models.json 不存在返回 null；坏 JSON 标记 corrupt（绝不静默覆盖用户的文件） */
async function readDoc(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { text, parsed: null, corrupt: true };
  }
  // 合法形态只有两种：裸数组、或对象。其它（纯字符串/数字…）一律按坏文件处理。
  if (!Array.isArray(parsed) && (!parsed || typeof parsed !== 'object')) {
    return { text, parsed: null, corrupt: true };
  }
  return { text, parsed, corrupt: false };
}

/** 稳定序列化：对象键排序、数组保序。比对「内容变没变」用，不受键序影响 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** 我们条目的字段投影：只留我们拥有的字段（reasoning 里同样只留我们拥有的子字段） */
function projectEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
  if (entry.ocFaucetOwner !== OWNER) return entry; // 用户条目原样比对，我们反正不动它
  const out = {};
  for (const key of OWNED_ENTRY_KEYS) {
    if (!(key in entry)) continue;
    const value = entry[key];
    if (key === 'reasoning' && value && typeof value === 'object' && !Array.isArray(value)) {
      const reasoning = {};
      for (const sub of OWNED_REASONING_KEYS) {
        if (sub in value) reasoning[sub] = value[sub];
      }
      out.reasoning = reasoning;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** 整个文件的投影：数组逐条投影；对象只投影 models，其它顶层字段原样参与比对 */
function projectDoc(parsed) {
  if (parsed === null || parsed === undefined) return null;
  if (Array.isArray(parsed)) return parsed.map(projectEntry);
  const out = { ...parsed };
  if (Array.isArray(out.models)) out.models = out.models.map(projectEntry);
  return out;
}

/** 幂等比对：合并结果与现有文件在我们拥有的字段投影上完全一致 → 不用写盘 */
function sameProjection(mergedDoc, parsed) {
  return canonical(projectDoc(mergedDoc)) === canonical(projectDoc(parsed));
}

/**
 * 把一个模型摊成 WorkBuddy 认识的条目。
 *
 * 推理声明三分支（照实测语义）：
 *   1. 非推理模型 → supportsReasoning:false，不写 reasoning / onlyReasoning；
 *   2. 推理模型但一个可用档位都没有 → supportsReasoning:true + onlyReasoning:true
 *      + reasoning 空档位（告诉 WorkBuddy：思考关不掉）；
 *   3. 有档位 → supportsReasoning:true + reasoning:{ supportedEfforts（不含 none）、
 *      defaultEffort（medium 优先，其次第一个非 none 档）、
 *      canDisableThinking（原始档位列表含 none 才 true）}。
 */
function buildEntry(model, { port, apiKey }) {
  const entry = {
    id: model.id,
    name: `OC · ${typeof model.name === 'string' && model.name ? model.name : model.id}`,
    vendor: 'Custom',
    // WorkBuddy 要的是完整端点路径，不是 base URL
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    apiKey,
    // 写入的都是体检通过能用工具的模型
    supportsToolCall: true,
    supportsImages: model.images === true,
  };
  if (Number.isFinite(model.contextWindow) && model.contextWindow > 0) {
    entry.maxInputTokens = model.contextWindow;
  }
  entry.ocFaucetOwner = OWNER;

  const effort = describeReasoning(model);
  if (!effort.enabled) {
    entry.supportsReasoning = false;
  } else if (!effort.hasVariants) {
    entry.supportsReasoning = true;
    entry.onlyReasoning = true;
    entry.reasoning = { supportedEfforts: [], defaultEffort: null, canDisableThinking: false };
  } else {
    entry.supportsReasoning = true;
    entry.reasoning = {
      supportedEfforts: effort.supportedEfforts.filter((e) => e !== 'none'),
      defaultEffort: effort.defaultEffort,
      canDisableThinking: effort.canDisableThinking,
    };
  }
  return entry;
}

function isMarked(entry) {
  return entry && typeof entry === 'object' && !Array.isArray(entry) && entry.ocFaucetOwner === OWNER;
}

/**
 * 合并：摘掉我们上次写的条目，把这次要写的加在最后。
 * id 撞了用户手写条目时**让位**（跳过该模型，记进 skipped），绝不覆盖别人写的。
 * 对象形态且本来就有 availableModels 时同步我们的 id；没有就不新建。
 *
 * @param {object|Array|null} parsed 现有文件内容（null = 文件不存在，按裸数组新建）
 * @param {Array<object>} desired 这次要写的条目（uninstall 时传 []）
 */
function mergeDoc(parsed, desired) {
  const shape = Array.isArray(parsed) || parsed === null ? 'array' : 'object';
  const list = shape === 'array' ? (parsed ?? []) : Array.isArray(parsed.models) ? parsed.models : [];

  const oldOwnedIds = new Set(list.filter(isMarked).map((e) => e.id).filter((x) => typeof x === 'string'));
  const kept = list.filter((e) => !isMarked(e));
  const otherIds = new Set(
    kept.map((e) => (e && typeof e === 'object' && !Array.isArray(e) ? e.id : null)).filter((x) => typeof x === 'string'),
  );

  const addedIds = new Set();
  const added = [];
  let skipped = 0;
  for (const entry of desired) {
    if (otherIds.has(entry.id) || addedIds.has(entry.id)) {
      skipped++;
      continue;
    }
    addedIds.add(entry.id);
    added.push(entry);
  }

  if (shape === 'array') {
    return { doc: [...kept, ...added], added: added.length, skipped, removed: list.length - kept.length };
  }

  const doc = { ...parsed, models: [...kept, ...added] };
  if (Array.isArray(parsed.availableModels)) {
    // 只有「真正离开文件」的我们的 id 才从 availableModels 摘除；
    // id 已被用户条目认领的留在里面——那是用户的模型了。
    const leaving = new Set([...oldOwnedIds].filter((id) => !otherIds.has(id) && !addedIds.has(id)));
    const available = parsed.availableModels.filter((id) => !leaving.has(id));
    for (const id of addedIds) {
      if (!available.includes(id)) available.push(id);
    }
    doc.availableModels = available;
  }
  return { doc, added: added.length, skipped, removed: list.length - kept.length };
}

/**
 * 取锁：wx 原子创建锁文件，内容写当前时间戳。
 * 已有锁时看时间戳：新鲜锁说明有别人正在写，直接报错；超过 5 分钟按死锁强占。
 */
async function acquireLock(file) {
  const lock = `${file}.oc-faucet.lock`;
  try {
    await writeFile(lock, String(Date.now()), { flag: 'wx', mode: 0o600 });
    return lock;
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  }
  let heldAt = NaN;
  try {
    heldAt = Number((await readFile(lock, 'utf8')).trim());
  } catch {
    /* 读不出内容按死锁处理 */
  }
  if (Number.isFinite(heldAt) && Date.now() - heldAt < LOCK_STALE_MS) {
    throw new BridgeError(
      'WorkBuddy 的模型配置正被另一个写入占用，这次没有动它。请稍后再试；如果确定没有别的写入在跑，删掉 models.json.oc-faucet.lock 再试。',
      409,
      'workbuddy_locked',
    );
  }
  await writeFile(lock, String(Date.now()), { mode: 0o600 });
  return lock;
}

async function releaseLock(lock) {
  await rm(lock, { force: true }).catch(() => {});
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 真写盘前把当前内容备份成 models.json.oc-faucet-<时间戳>.bak，只留最近 5 份。
 * 备份失败不算致命——写配置本身更重要。
 */
async function backupOnce(file, text) {
  try {
    const dir = dirname(file);
    const base = basename(file);
    // 同一毫秒内多次写盘时往后错 1ms，免得备份名撞车互相盖掉
    let stamp = Date.now();
    let target = join(dir, `${base}.oc-faucet-${stamp}.bak`);
    while (existsSync(target)) {
      stamp += 1;
      target = join(dir, `${base}.oc-faucet-${stamp}.bak`);
    }
    await writeFile(target, text, { mode: 0o600 });

    const pattern = new RegExp(`^${escapeRegExp(base)}\\.oc-faucet-\\d+\\.bak$`);
    const all = (await readdir(dir)).filter((name) => pattern.test(name)).sort();
    for (const old of all.slice(0, Math.max(0, all.length - BACKUP_KEEP))) {
      await rm(join(dir, old), { force: true });
    }
  } catch {
    /* 备份是尽力而为 */
  }
}

function corruptError(file) {
  return new BridgeError(
    `WorkBuddy 的模型配置（${basename(file)}）不是合法的 JSON，我们没有动它。请先自己备份这份文件，修复或删除后再重试。`,
    500,
    'workbuddy_models_corrupt',
  );
}

/**
 * 写入纪律的主流程：取锁 → 读旧 → 合并 → 没变不写 → 写前再读校验 → 备份 → 原子替换 → 放锁。
 *
 * @param {string} file models.json 路径
 * @param {Array<object>} desired 这次要写的条目（uninstall 传 []）
 * @param {object} o
 * @param {boolean} o.createIfMissing 文件不存在时要不要新建（install 要，uninstall 不要）
 * @param {object} [o.hooks] 测试缝：_beforeReread 在写前重读之前触发（模拟并发写）
 * @returns {Promise<{merged:{doc:object, added:number, skipped:number, removed:number}, changed:boolean}>}
 */
async function applyWithGuard(file, desired, { createIfMissing, hooks = {} }) {
  await ensureParentDir(file);
  const lock = await acquireLock(file);
  try {
    const first = await readDoc(file);
    if (first?.corrupt) throw corruptError(file);
    if (!first && !createIfMissing) return { merged: mergeDoc(null, desired), changed: false };

    let base = first;
    let merged = mergeDoc(first?.parsed ?? null, desired);
    // 幂等：内容没变就不写盘（投影比对，容忍 WorkBuddy 规范化补的字段）
    if (first && sameProjection(merged.doc, first.parsed)) return { merged, changed: false };

    // 写前再读一次校验没被别人改过；被改过就基于新内容重新合并一次，仍冲突则放弃。
    for (let attempt = 0; ; attempt++) {
      await hooks._beforeReread?.(attempt);
      const fresh = await readDoc(file);
      if (fresh?.corrupt) throw corruptError(file);
      if (canonical(fresh?.parsed ?? null) === canonical(base?.parsed ?? null)) break;
      if (attempt >= 1) {
        throw new BridgeError(
          'WorkBuddy 的模型配置在写入时一直被改动，这次先放弃、一个字都没写。请稍后再试一次。',
          409,
          'workbuddy_write_conflict',
        );
      }
      base = fresh;
      merged = mergeDoc(fresh?.parsed ?? null, desired);
    }

    // 外部改动可能恰好让文件已经是目标状态（极小概率），落盘前再查一次幂等
    if (base && sameProjection(merged.doc, base.parsed)) return { merged, changed: false };

    if (base) await backupOnce(file, base.text);
    await writeAtomic0600(file, `${JSON.stringify(merged.doc, null, 2)}\n`);
    return { merged, changed: true };
  } finally {
    await releaseLock(lock);
  }
}

async function installModels(file, models, { port, apiKey } = {}, hooks) {
  // 逐模型 id 校验已并进 assertInstallArgs（缺 id、id 里没有斜杠都在这一步拦下）
  assertInstallArgs(models, { port, apiKey }, 'WorkBuddy');

  const entries = models.map((m) => buildEntry(m, { port, apiKey }));
  const { merged, changed } = await applyWithGuard(file, entries, { createIfMissing: true, hooks });
  return { added: merged.added, skipped: merged.skipped, changed };
}

async function uninstallModels(file, hooks) {
  const { merged, changed } = await applyWithGuard(file, [], { createIfMissing: false, hooks });
  return { removed: changed ? merged.removed : 0, changed };
}

/** 当前装没装、装的哪些：实读文件，收集带归属标记的条目 id。坏文件/读失败都按没装报，不炸。 */
async function statusOf(file) {
  let doc;
  try {
    doc = await readDoc(file);
  } catch {
    return { written: false, models: [] };
  }
  if (!doc || doc.corrupt) return { written: false, models: [] };
  const list = Array.isArray(doc.parsed) ? doc.parsed : Array.isArray(doc.parsed.models) ? doc.parsed.models : [];
  const models = list.filter((e) => isMarked(e) && typeof e.id === 'string').map((e) => e.id);
  return { written: models.length > 0, models };
}

/**
 * 建 WorkBuddy 接入目标，形状严格按接口约定 §14。
 *
 * @param {object} [overrides] 测试用的缝：
 *   - file: 直接指定 models.json 路径（优先于环境变量 OCF_WORKBUDDY_MODELS）
 *   - _beforeReread: 写前重读校验前的钩子（模拟并发写；生产代码不会传）
 */
export function createWorkbuddyTarget(overrides = {}) {
  // 路径调用时现读：环境变量 OCF_WORKBUDDY_MODELS 可覆盖（测试把它指到临时目录）
  const fileOf = () =>
    overrides.file ?? process.env.OCF_WORKBUDDY_MODELS ?? join(homedir(), '.workbuddy', 'models.json');
  return {
    id: 'workbuddy',
    label: 'WorkBuddy',

    /** WorkBuddy 装没装：按配置目录（~/.workbuddy）的存在性判断 */
    detect() {
      return existsSync(dirname(fileOf()));
    },

    /** 我们写入的模型清单。每次调用都实读配置文件，不用内存缓存糊弄。 */
    status() {
      return statusOf(fileOf());
    },

    /** 把模型写进 WorkBuddy。返回 { added, skipped, changed }（skipped = 撞用户条目让位的个数） */
    install(models, { port, apiKey } = {}) {
      return installModels(fileOf(), models, { port, apiKey }, overrides);
    },

    /** 只摘掉带归属标记的条目，用户手写的一条不动。返回 { removed, changed } */
    uninstall() {
      return uninstallModels(fileOf(), overrides);
    },
  };
}
