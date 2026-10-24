/**
 * Codex（OpenAI Codex CLI）接入目标。
 *
 * Codex 只认 OpenAI Responses 协议（`wire_api = "chat"` 已被官方移除），所以本目标
 * 依赖 src/protocol.js 的 Responses 适配；只加个列表选项是接不通的。
 *
 * 写进 `~/.codex/config.toml`（`CODEX_HOME` 可换目录）的两段受管内容：
 *   ① 文件最前的顶层块：model / model_provider / model_catalog_json
 *      （TOML 规定顶层键必须出现在第一个表头之前，所以这段只能放在开头）
 *   ② 文件末尾的 [model_providers.oc-faucet]：base_url、wire_api="responses"、密钥
 * 以及一份写在我们数据目录里的模型目录 JSON。
 *
 * 为什么要目录 JSON：Codex 对认不出的模型只用兜底元数据，窗口上限被夹在 272k；
 * `model_catalog_json` 是申报自定义窗口的唯一官方途径，代价是它会顶掉 Codex 内置
 * 模型清单——所以摘除时必须把这三行连引用一起撤掉，并还原用户原本的同名配置。
 * 被我们盖掉的用户顶层取值先记进本机快照，移除时按快照还原。
 */
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { BridgeError } from './errors.js';
import { describeReasoning } from './efforts.js';
import { assertInstallArgs, writeTextIfChanged, writeOwnerSnapshot } from './target-helpers.js';
import { dataDir } from './settings.js';

const PROVIDER_ID = 'oc-faucet';
const BLOCK_BEGIN = '# >>> oc-faucet >>>';
const BLOCK_END = '# <<< oc-faucet <<<';
const TOP_KEYS = ['model', 'model_provider', 'model_catalog_json'];
const OWNER_META_KEY = '__ocFaucetCodex';
const OWNER_META_VERSION = 1;
const DEFAULT_CONTEXT_WINDOW = 272_000;
/** Codex 认得的推理档位名，其余不声明，免得客户端拿出我们代不了的档 */
const KNOWN_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
/**
 * 目录条目必须自带 base_instructions，缺了 Codex 会拒绝整份目录。
 * 只写最小骨架：工具清单与调用约定由转发口随请求带上，不在这儿重复一遍。
 */
const BASE_INSTRUCTIONS = [
  'You are a coding agent running in the Codex CLI, a terminal-based coding assistant.',
  'Follow the tool definitions attached to each request, and use them to get the work done.',
  'Be precise, safe, and helpful; keep answers concise.',
].join('\n');

function expandHome(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

function resolveConfigPath(overrides = {}) {
  if (typeof overrides.configPath === 'string') return overrides.configPath;
  if (process.env.OCF_CODEX_CONFIG) return process.env.OCF_CODEX_CONFIG;
  const home = process.env.CODEX_HOME;
  if (typeof home === 'string' && home.trim()) return join(expandHome(home.trim()), 'config.toml');
  return join(homedir(), '.codex', 'config.toml');
}

function resolveCatalogPath(overrides = {}) {
  if (typeof overrides.catalogPath === 'string') return overrides.catalogPath;
  if (process.env.OCF_CODEX_CATALOG) return process.env.OCF_CODEX_CATALOG;
  return join(dataDir(), 'codex-models.json');
}

function resolveOwnerFile(overrides = {}) {
  if (typeof overrides.ownerFile === 'string') return overrides.ownerFile;
  if (process.env.OCF_CODEX_OWNER) return process.env.OCF_CODEX_OWNER;
  return join(dataDir(), 'codex-owner-backup.json');
}

function configError(file, detail) {
  return new BridgeError(
    `Codex 的配置（${file}）${detail}。为了不写坏你的配置，这次没有改动它。请检查后重试。`,
    400,
    'codex_config_unsafe',
  );
}

/** 去掉行尾的 # 注释（引号内部不算） */
function stripTrailingComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index];
    if (quote) {
      if (ch === '\\') index += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#') return line.slice(0, index);
  }
  return line;
}

/**
 * 行分类：注释 / 表头 / `key =` 赋值 / 空行，并标出落在哪个受管块里。
 * 只做必要的字符串处理：读不懂的长字符串直接拒绝，不宣称完整实现 TOML。
 */
function scan(text, file) {
  if (text.includes('"""') || text.includes("'''")) {
    throw configError(file, '里有我们读不了的长字符串');
  }
  const lines = text.split('\n').map((raw) => {
    const trimmed = raw.trim();
    const commentOnly = trimmed.startsWith('#');
    const code = commentOnly ? '' : stripTrailingComment(raw);
    return {
      raw,
      commentOnly,
      isHeader: /^\[/.test(code.trim()),
      key: commentOnly || !code.trim() ? null : (/^\s*([A-Za-z0-9_.-]+)\s*=(?!=)/.exec(code)?.[1] ?? null),
    };
  });
  const starts = [];
  const ends = [];
  lines.forEach((line, index) => {
    const value = line.raw.trim();
    if (!line.commentOnly) return;
    if (value.startsWith('# >>> oc-faucet') && value !== BLOCK_BEGIN) throw configError(file, '的受管块开始标记格式不对');
    if (value.startsWith('# <<< oc-faucet') && value !== BLOCK_END) throw configError(file, '的受管块结束标记格式不对');
    if (value === BLOCK_BEGIN) starts.push(index);
    if (value === BLOCK_END) ends.push(index);
  });
  if (starts.length !== ends.length) throw configError(file, '的受管块标记不成对');
  for (const [position, start] of starts.entries()) {
    if (start > ends[position]) throw configError(file, '的受管块标记顺序不对');
  }
  const inBlock = (index) => starts.some((start, position) => index >= start && index <= ends[position]);
  return { lines, starts, ends, inBlock };
}

function tomlQuote(value) {
  let out = '"';
  for (const ch of String(value)) {
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else out += ch;
  }
  return `${out}"`;
}

function windowOf(model) {
  const value = model.contextWindow ?? model.upstreamContextWindow;
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_CONTEXT_WINDOW;
}

/** 一个模型 → Codex 目录条目（字段名对齐 Codex 的 ModelInfo） */
function catalogEntry(model, index) {
  const effort = describeReasoning(model);
  const supported = effort.supportedEfforts.filter((value) => KNOWN_EFFORTS.includes(value));
  const defaultEffort = supported.includes(effort.defaultEffort) ? effort.defaultEffort : (supported[0] ?? null);
  const window = windowOf(model);
  const modalities = ['text'];
  if (model.images === true) modalities.push('image');
  return {
    slug: model.id,
    display_name: model.name || model.id,
    description: 'OC Faucet 放出的 OpenCode 免费模型',
    base_instructions: BASE_INSTRUCTIONS,
    default_reasoning_level: defaultEffort,
    supported_reasoning_levels: supported.map((value) => ({ effort: value, description: value })),
    shell_type: 'unified_exec',
    visibility: 'list',
    supported_in_api: true,
    priority: index + 1,
    availability_nux: null,
    upgrade: null,
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    truncation_policy: { mode: 'tokens', limit: 10_000 },
    experimental_supported_tools: [],
    context_window: window,
    // Codex 会把顶层 model_context_window 夹到 max_context_window，所以这里必须给足
    max_context_window: window,
    auto_compact_token_limit: null,
    effective_context_window_percent: 95,
    input_modalities: modalities,
    supports_search_tool: false,
    service_tiers: [],
  };
}

function catalogPayload(models) {
  return `${JSON.stringify({ models: models.map(catalogEntry) }, null, 2)}\n`;
}

function topBlockLines(models, catalogFile) {
  return [
    BLOCK_BEGIN,
    `model = ${tomlQuote(models[0].id)}`,
    `model_provider = ${tomlQuote(PROVIDER_ID)}`,
    `model_catalog_json = ${tomlQuote(catalogFile)}`,
    BLOCK_END,
  ];
}

function providerBlockLines({ port, apiKey }) {
  return [
    BLOCK_BEGIN,
    `[model_providers.${PROVIDER_ID}]`,
    `name = ${tomlQuote('OC Faucet')}`,
    `base_url = ${tomlQuote(`http://127.0.0.1:${port}/v1`)}`,
    'wire_api = "responses"',
    `experimental_bearer_token = ${tomlQuote(apiKey)}`,
    BLOCK_END,
  ];
}

/** 读取顶层用户原值；重复键无法无损还原，因此安全拒绝。 */
function takeUserTopLines(found, file) {
  const originals = {};
  const drop = new Set();
  const firstHeader = found.lines.findIndex((line) => line.isHeader);
  const limit = firstHeader < 0 ? found.lines.length : firstHeader;
  found.lines.forEach((line, index) => {
    if (index >= limit || line.commentOnly || found.inBlock(index) || !line.key) return;
    if (!TOP_KEYS.includes(line.key)) return;
    if (line.key in originals) throw configError(file, `里的顶层键 ${line.key} 重复，无法安全留档`);
    originals[line.key] = line.raw;
    drop.add(index);
  });
  return { originals, drop };
}

function hashManagedBlocks(found) {
  return found.starts.map((start, position) => {
    const block = found.lines.slice(start, found.ends[position] + 1).map((line) => line.raw).join('\n');
    return createHash('sha256').update(block).digest('hex');
  });
}

function isHashList(value) {
  return Array.isArray(value) && value.length === 2
    && value.every((hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash));
}

function validateOwnerSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  for (const key of TOP_KEYS) {
    if (key in value && (typeof value[key] !== 'string' || !new RegExp(`^\\s*${key}\\s*=`).test(value[key]))) return null;
  }
  if (!(OWNER_META_KEY in value)) return { ...value };

  const meta = value[OWNER_META_KEY];
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)
    || meta.version !== OWNER_META_VERSION
    || !['prepared', 'installed'].includes(meta.state)) return null;
  const hasCurrent = isHashList(meta.managedBlocks);
  const hasPending = isHashList(meta.pendingManagedBlocks);
  if (!hasCurrent && !hasPending) return null;
  if (meta.managedBlocks !== undefined && !hasCurrent) return null;
  if (meta.pendingManagedBlocks !== undefined && !hasPending) return null;
  if (meta.state === 'prepared' && (hasCurrent || !hasPending)) return null;
  if (meta.state === 'installed' && !hasCurrent) return null;
  const allowedMetaKeys = new Set(['version', 'state', 'managedBlocks', 'pendingManagedBlocks']);
  if (Object.keys(meta).some((key) => !allowedMetaKeys.has(key))) return null;
  return { ...value };
}

async function readOwnerRecord(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { present: false, valid: true, owner: {} };
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { present: true, valid: false, owner: null };
  }
  const owner = validateOwnerSnapshot(parsed);
  return { present: true, valid: owner !== null, owner };
}

function hasManagedSnapshot(found, owner) {
  if (found.starts.length !== 2) return false;
  const meta = owner?.[OWNER_META_KEY];
  if (!meta) return false;
  const actual = hashManagedBlocks(found);
  return [meta.managedBlocks, meta.pendingManagedBlocks]
    .some((expected) => isHashList(expected) && expected.every((hash, index) => hash === actual[index]));
}

function assertManagedSnapshot(found, owner, file) {
  if (!hasManagedSnapshot(found, owner)) {
    throw configError(file, '里的受管内容已被改动，或安装前的原值快照缺失/损坏；为避免丢失配置，本次没有移除或覆盖它');
  }
}

function assertNoUnmanagedTopKeys(found, file) {
  const firstHeader = found.lines.findIndex((line) => line.isHeader);
  const limit = firstHeader < 0 ? found.lines.length : firstHeader;
  const conflict = found.lines.find((line, index) => index < limit && !found.inBlock(index)
    && !line.commentOnly && TOP_KEYS.includes(line.key));
  if (conflict) throw configError(file, `里的顶层键 ${conflict.key} 已在受管块外被改动`);
}

function savePendingManagedBlocks(owner, currentHashes, nextHashes) {
  owner[OWNER_META_KEY] = currentHashes
    ? {
      version: OWNER_META_VERSION,
      state: 'installed',
      managedBlocks: currentHashes,
      pendingManagedBlocks: nextHashes,
    }
    : {
      version: OWNER_META_VERSION,
      state: 'prepared',
      pendingManagedBlocks: nextHashes,
    };
}

function finalizeManagedBlocks(owner) {
  const meta = owner[OWNER_META_KEY];
  owner[OWNER_META_KEY] = {
    version: OWNER_META_VERSION,
    state: 'installed',
    managedBlocks: meta.pendingManagedBlocks,
  };
}

/** 去掉受管块（以及用户同名顶层行）之后，剩下的用户内容按「顶层区 / 表区」切开 */
function splitUserLines(found, drop) {
  const firstHeader = found.lines.findIndex((line) => line.isHeader);
  const head = [];
  const tail = [];
  found.lines.forEach((line, index) => {
    if (found.inBlock(index) || drop.has(index)) return;
    (firstHeader >= 0 && index >= firstHeader ? tail : head).push(line.raw);
  });
  return { head: trimBlankRuns(head), tail: trimBlankRuns(tail) };
}

/** 掐掉首尾空行，中间连续的 3+ 空行压成一行 */
function trimBlankRuns(lines) {
  const out = lines.filter((line, index) => line.trim() !== '' || (index > 0 && lines[index - 1].trim() !== ''));
  while (out.length && out[0].trim() === '') out.shift();
  while (out.length && out.at(-1).trim() === '') out.pop();
  return out;
}

function assertNoProviderConflict(found, file) {
  const header = `[model_providers.${PROVIDER_ID}]`;
  found.lines.forEach((line, index) => {
    if (!line.isHeader || line.commentOnly || found.inBlock(index)) return;
    if (line.raw.trim() !== header) return;
    throw new BridgeError(
      `Codex 配置（${file}）里已经有你自己的 ${header} 表。名字撞了，我们不敢替你合并：请把那个表改名，或者先删掉再接入。`,
      409,
      'codex_provider_conflict',
    );
  });
}

async function readFileOrNone(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return null;
  }
}

/**
 * 创建 Codex 接入目标。
 * @param {object} [overrides] 测试用的路径注入（configPath / catalogPath / ownerFile）
 */
export function createCodexTarget(overrides = {}) {
  const path = () => resolveConfigPath(overrides);
  const catalogPath = () => resolveCatalogPath(overrides);
  const ownerPath = () => resolveOwnerFile(overrides);

  return {
    id: 'codex',
    label: 'Codex',
    protocol: 'responses',
    selectsModels: true,

    detect() {
      return existsSync(dirname(path()));
    },

    async status() {
      const file = path();
      const text = await readFileOrNone(file);
      if (text === null) return { written: false, models: [] };
      let found;
      try {
        found = scan(text, file);
      } catch {
        return { written: false, models: [] };
      }
      if (found.starts.length !== 2) return { written: false, models: [] };
      const record = await readOwnerRecord(ownerPath());
      if (!record.valid || !hasManagedSnapshot(found, record.owner)) return { written: false, models: [] };
      try {
        assertNoUnmanagedTopKeys(found, file);
      } catch {
        return { written: false, models: [] };
      }
      const catalog = await readFileOrNone(catalogPath());
      let models = [];
      try {
        models = (JSON.parse(catalog ?? '{}').models ?? [])
          .map((entry) => entry?.slug)
          .filter((slug) => typeof slug === 'string');
      } catch {
        models = [];
      }
      return { written: true, models };
    },

    async install(models, { port, apiKey } = {}) {
      assertInstallArgs(models, { port, apiKey }, 'Codex');
      if (!models.length) {
        throw new BridgeError('模型清单是空的，没法写入 Codex。请至少勾选一个可用模型。', 400, 'bad_models');
      }
      const file = path();
      const found = scan((await readFileOrNone(file)) ?? '', file);
      const record = await readOwnerRecord(ownerPath());
      if (!record.valid) throw configError(file, '对应的安装前原值快照已损坏');
      const hasBlocks = found.starts.length > 0;
      let owner = {};
      let drop = new Set();
      let currentHashes = null;
      if (hasBlocks) {
        assertManagedSnapshot(found, record.owner, file);
        assertNoUnmanagedTopKeys(found, file);
        owner = record.owner;
        currentHashes = hashManagedBlocks(found);
      } else {
        const current = takeUserTopLines(found, file);
        const previous = record.owner;
        const previousMeta = previous[OWNER_META_KEY];
        const priorOriginals = Object.fromEntries(TOP_KEYS
          .filter((key) => typeof previous[key] === 'string')
          .map((key) => [key, previous[key]]));
        const hasPriorSnapshot = Object.keys(priorOriginals).length > 0;
        const hasInstalledSnapshot = record.present
          && (previousMeta?.state === 'installed' || (!previousMeta && hasPriorSnapshot));
        if (hasInstalledSnapshot) {
          const unchanged = TOP_KEYS.every((key) => current.originals[key] === priorOriginals[key]);
          if (!unchanged) {
            throw configError(file, '里的受管标记已丢失，且顶层值与快照不一致；为避免把受管值误当成你的原值，本次没有覆盖配置');
          }
        }
        owner = previousMeta?.state === 'prepared' ? {} : priorOriginals;
        Object.assign(owner, current.originals);
        drop = current.drop;
      }
      assertNoProviderConflict(found, file);
      const { head, tail } = splitUserLines(found, drop);
      const catalogFile = catalogPath();
      // 拼接顺序有讲究：顶层块必须在第一个表头之前，provider 表放在用户表区之前
      const next = [
        topBlockLines(models, catalogFile).join('\n'),
        head.join('\n'),
        providerBlockLines({ port, apiKey }).join('\n'),
        tail.join('\n'),
      ]
        .filter((section) => section.trim())
        .join('\n\n');
      const expected = scan(next, file);
      if (expected.starts.length !== 2) throw configError(file, '无法确认本次生成的受管块');
      savePendingManagedBlocks(owner, currentHashes, hashManagedBlocks(expected));
      await writeOwnerSnapshot(ownerPath(), owner);
      const catalogWrite = await writeTextIfChanged(catalogFile, catalogPayload(models));
      const write = await writeTextIfChanged(file, `${next}\n`);
      finalizeManagedBlocks(owner);
      await writeOwnerSnapshot(ownerPath(), owner);
      return { added: models.length, skipped: [], changed: write.changed || catalogWrite.changed };
    },

    async uninstall() {
      const file = path();
      const text = await readFileOrNone(file);
      if (text === null) return { removed: 0, changed: false };
      const found = scan(text, file);
      if (!found.starts.length) return { removed: 0, changed: false };
      const record = await readOwnerRecord(ownerPath());
      if (!record.valid) throw configError(file, '对应的安装前原值快照已损坏');
      assertManagedSnapshot(found, record.owner, file);
      assertNoUnmanagedTopKeys(found, file);
      const owner = record.owner;
      const { head, tail } = splitUserLines(found, new Set());
      const restored = TOP_KEYS.map((key) => owner[key]).filter((line) => typeof line === 'string');
      const headLines = [...restored, ...head];
      const body = [trimBlankRuns(headLines).join('\n'), tail.join('\n')].filter((part) => part.trim()).join('\n\n');
      const write = await writeTextIfChanged(file, body ? `${body}\n` : '');
      await writeOwnerSnapshot(ownerPath(), {});
      await rm(catalogPath(), { force: true });
      return { removed: 1, changed: write.changed };
    },
  };
}
