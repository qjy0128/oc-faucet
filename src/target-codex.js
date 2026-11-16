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
 *
 * 归属与还原（对齐 Claude Code 目标的「条件还原」纪律）：
 *   - provider 表块（②）是纯我们的地盘，快照记其 sha256；被改过说明用户接手了，
 *     安装/摘除都报错不动手；
 *   - 顶层块（①）允许用户改动：快照记我们写入的 model 取值（topApplied），逐行
 *     分清「我们的 / 你的」。安装时你改过的值吸收为将来要还原的原值；摘除时你的
 *     行原样保留，只有空着的键才按快照还原安装前原值——绝不覆盖你的更新；
 *   - 旧版快照（没记 topApplied）遇顶层块被改：分不清归属，保持报错拒绝动手。
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

function validTopApplied(value) {
  return value === undefined
    || (typeof value === 'object' && value !== null && !Array.isArray(value)
      && Object.keys(value).every((key) => key === 'model')
      && (value.model === undefined || (typeof value.model === 'string' && value.model)));
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
  if (!validTopApplied(meta.topApplied)) return null;
  const allowedMetaKeys = new Set(['version', 'state', 'managedBlocks', 'pendingManagedBlocks', 'topApplied']);
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

/** 受管块按内容认类型：块内有 TOP_KEYS 赋值是顶层块，有 [model_providers.oc-faucet] 是 provider 表块。 */
function blockKindAt(found, position) {
  for (let index = found.starts[position]; index <= found.ends[position]; index += 1) {
    const line = found.lines[index];
    if (!line.commentOnly && line.isHeader && line.raw.trim() === `[model_providers.${PROVIDER_ID}]`) return 'provider';
    if (!line.commentOnly && line.key && TOP_KEYS.includes(line.key)) return 'top';
  }
  return null;
}

/** 文件里的顶层块 / provider 块各自在 starts 里的位置；没有返回 -1；同类出现两个报错。 */
function locateBlocks(found, file) {
  const at = { top: -1, provider: -1 };
  for (const position of found.starts.keys()) {
    const kind = blockKindAt(found, position);
    if (kind === null) continue;
    if (at[kind] !== -1) throw configError(file, '里的受管标记块数量异常');
    at[kind] = position;
  }
  return at;
}

/**
 * provider 表块（纯我们的地盘）是否仍是快照记录的那一份。
 * 安装输出恒为「顶层块在前、provider 块在后」，所以快照 hash 列表的位置 1 恒是 provider 的。
 */
function providerBlockIntact(found, owner, providerIdx) {
  const meta = owner?.[OWNER_META_KEY];
  if (!meta || providerIdx < 0) return false;
  const actual = hashManagedBlocks(found)[providerIdx];
  return [meta.managedBlocks, meta.pendingManagedBlocks]
    .some((expected) => isHashList(expected) && expected[1] === actual);
}

/** 解析 `key = "value"` 行的双引号值；不是这种形状（裸标量/单引号）返回 null，按用户写法对待。 */
function quotedValue(line) {
  if (line.commentOnly || !line.key) return null;
  const match = /^\s*[A-Za-z0-9_.-]+\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/.exec(stripTrailingComment(line.raw));
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return null;
  }
}

/**
 * 顶层块里这一行是不是我们写的：三键的值必须与快照记录 / 我方常量对上，标记行也算。
 * 值对不上 = 用户改过这行 → 不算我们的，卸载时原样保留、重装时吸收为应还原原值。
 */
function isOurTopLine(line, appliedModel, catalogFile) {
  const trimmed = line.raw.trim();
  if (line.commentOnly) return trimmed === BLOCK_BEGIN || trimmed === BLOCK_END;
  if (!line.key || !TOP_KEYS.includes(line.key)) return false;
  const value = quotedValue(line);
  if (line.key === 'model_provider') return value === PROVIDER_ID;
  if (line.key === 'model_catalog_json') return value === catalogFile;
  return appliedModel !== null && value === appliedModel;
}

/** 顶层受管块整块是否仍是快照记录的那份（位置 0 恒是顶层块的 hash）。 */
function topBlockIntact(found, owner, topIdx) {
  const meta = owner?.[OWNER_META_KEY];
  if (!meta || topIdx < 0) return false;
  const actual = hashManagedBlocks(found)[topIdx];
  return [meta.managedBlocks, meta.pendingManagedBlocks]
    .some((expected) => isHashList(expected) && expected[0] === actual);
}

/**
 * 重排第一个受管块外表头之前的顶层区：我方行丢弃，用户行（含从顶层块里释放出来的）
 * 按原顺序保留。返回保留行与用户写下的同名顶层行（键 → 行文本）。
 *
 * topBlockIdx 是顶层块在 starts 里的位置（-1 表示没有）；appliedModel 是快照记录的
 * 「我们写入的 model 值」（旧快照没有则为 null——此时顶层块若已被改过，调用方应先报错）。
 */
function collectTopArea(found, { topBlockIdx, appliedModel, catalogFile, file }) {
  // 顶层区到「第一个受管块外表头」或「任何非顶层受管块」为止——再往后是表的事，不归这里管
  let end = found.lines.findIndex((line, index) => !found.inBlock(index) && line.isHeader);
  if (end < 0) end = found.lines.length;
  for (const position of found.starts.keys()) {
    if (position !== topBlockIdx) end = Math.min(end, found.starts[position]);
  }
  const kept = [];
  const userTopKeys = new Map();
  const takeUserKeyLine = (line) => {
    if (userTopKeys.has(line.key) && userTopKeys.get(line.key) !== line.raw) {
      throw configError(file, `里的顶层键 ${line.key} 出现了两个不同的值，无法判断哪份是你的；请先整理后再试`);
    }
    userTopKeys.set(line.key, line.raw);
  };
  for (let index = 0; index < end; index += 1) {
    const line = found.lines[index];
    if (found.inBlock(index)) {
      if (topBlockIdx >= 0 && index >= found.starts[topBlockIdx] && index <= found.ends[topBlockIdx]) {
        if (isOurTopLine(line, appliedModel, catalogFile)) continue; // 我方行，丢弃
        if (!line.commentOnly && line.key && TOP_KEYS.includes(line.key)) takeUserKeyLine(line);
        else kept.push(line.raw); // 用户塞进块里的注释/其他行，原样保留
      } else {
        kept.push(line.raw); // 出现在表头前的其他受管块（异常形态），不拆，原样保留
      }
      continue;
    }
    if (!line.commentOnly && line.key && TOP_KEYS.includes(line.key)) takeUserKeyLine(line);
    else kept.push(line.raw);
  }
  return { kept, userTopKeys };
}

/** 表区行：第一个受管块外表头起、任何受管块之外的行，原样保留。 */
function tableAreaLines(found) {
  const firstHeader = found.lines.findIndex((line, index) => !found.inBlock(index) && line.isHeader);
  if (firstHeader < 0) return [];
  return found.lines
    .filter((line, index) => index >= firstHeader && !found.inBlock(index))
    .map((line) => line.raw);
}

function savePendingManagedBlocks(owner, currentHashes, nextHashes, topApplied) {
  const meta = currentHashes
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
  if (topApplied) meta.topApplied = topApplied;
  owner[OWNER_META_KEY] = meta;
}

function finalizeManagedBlocks(owner) {
  const meta = owner[OWNER_META_KEY];
  owner[OWNER_META_KEY] = {
    version: OWNER_META_VERSION,
    state: 'installed',
    managedBlocks: meta.pendingManagedBlocks,
    ...(meta.topApplied ? { topApplied: meta.topApplied } : {}),
  };
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
      // 只认「provider 表块仍是快照记录的那份」：顶层块的值被用户改过不影响「我们写过」
      let at;
      try {
        at = locateBlocks(found, file);
      } catch {
        return { written: false, models: [] };
      }
      if (!record.valid || !providerBlockIntact(found, record.owner, at.provider)) return { written: false, models: [] };
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
      const catalogFile = catalogPath();
      const at = locateBlocks(found, file);
      const previousMeta = record.owner?.[OWNER_META_KEY];
      const appliedModel = previousMeta?.topApplied?.model ?? null;
      const priorOriginals = Object.fromEntries(TOP_KEYS
        .filter((key) => typeof record.owner?.[key] === 'string')
        .map((key) => [key, record.owner[key]]));
      let currentHashes = null;
      if (found.starts.length > 0) {
        if (!record.present) throw configError(file, '对应的安装前原值快照缺失');
        // provider 表块是纯我们的地盘：被改过就报错，不覆盖用户接手的内容
        if (at.provider >= 0 && !providerBlockIntact(found, record.owner, at.provider)) {
          throw configError(file, '里的受管 provider 表已被改动；为避免覆盖你可能已经接手的内容，本次没有重写它');
        }
        // 顶层块被用户改过：能逐行分清「我们的 / 你的」才继续；旧快照没记 model 写入值时分不清，报错
        if (at.top >= 0 && !topBlockIntact(found, record.owner, at.top) && appliedModel === null) {
          throw configError(file, '里的受管顶层块已被改动，且旧版快照没有记录我们写入的取值；为避免误删你的改动，本次没有重写它');
        }
        currentHashes = hashManagedBlocks(found);
      }
      const owner = previousMeta?.state === 'prepared' ? {} : priorOriginals;
      // 顶层区重排：用户的同名顶层行（块外的、以及顶层块里被用户改过的）吸收为应还原原值
      const layout = collectTopArea(found, { topBlockIdx: at.top, appliedModel, catalogFile, file });
      const installedBefore = record.present
        && (previousMeta?.state === 'installed' || (!previousMeta && Object.keys(priorOriginals).length > 0));
      for (const [key, raw] of layout.userTopKeys) {
        if (raw === priorOriginals[key]) continue; // 与原值档同款，用户没动过
        const value = quotedValue({ raw, commentOnly: false, key });
        const isOurs = key === 'model'
          ? appliedModel !== null && value === appliedModel
          : value === PROVIDER_ID || value === catalogFile;
        if (isOurs) continue; // 行值是我们写的（标记被删后残留），不能当成用户原值
        if (installedBefore && key === 'model' && appliedModel === null) {
          throw configError(file, '里的受管标记已丢失，且顶层 model 取值与快照对不上；为避免把受管值误当成你的原值，本次没有覆盖配置');
        }
        owner[key] = raw;
      }
      assertNoProviderConflict(found, file);
      // 拼接顺序有讲究：顶层块必须在第一个表头之前，provider 表放在用户表区之前
      const next = [
        topBlockLines(models, catalogFile).join('\n'),
        trimBlankRuns(layout.kept).join('\n'),
        providerBlockLines({ port, apiKey }).join('\n'),
        trimBlankRuns(tableAreaLines(found)).join('\n'),
      ]
        .filter((section) => section.trim())
        .join('\n\n');
      const expected = scan(next, file);
      if (expected.starts.length !== 2) throw configError(file, '无法确认本次生成的受管块');
      savePendingManagedBlocks(owner, currentHashes, hashManagedBlocks(expected), { model: models[0].id });
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
      const at = locateBlocks(found, file);
      if (!record.present) throw configError(file, '对应的安装前原值快照缺失');
      const owner = record.owner;
      const meta = owner[OWNER_META_KEY];
      const appliedModel = meta?.topApplied?.model ?? null;
      // provider 表块被改过 → 报错不摘（纯我们的地盘，被改说明用户接手了）
      if (at.provider >= 0 && !providerBlockIntact(found, owner, at.provider)) {
        throw configError(file, '里的受管 provider 表已被改动；为避免删掉你可能已经接手的内容，本次没有摘除它');
      }
      // 顶层块被改过且旧快照没记 model 写入值 → 分不清哪行是我们的，报错
      if (at.top >= 0 && !topBlockIntact(found, owner, at.top) && appliedModel === null) {
        throw configError(file, '里的受管顶层块已被改动，且旧版快照没有记录我们写入的取值；请手工删掉 oc-faucet 标记块后再试');
      }
      const layout = collectTopArea(found, { topBlockIdx: at.top, appliedModel, catalogFile: catalogPath(), file });
      // 条件还原：用户自己写着该键（块外或块内改过）→ 保留用户的值；只有空位才还原安装前原值
      const restored = [];
      for (const key of TOP_KEYS) {
        if (layout.userTopKeys.has(key)) continue;
        if (typeof owner[key] === 'string') restored.push(owner[key]);
      }
      const headLines = trimBlankRuns([...restored, ...layout.userTopKeys.values(), ...layout.kept]);
      const body = [headLines.join('\n'), trimBlankRuns(tableAreaLines(found)).join('\n')]
        .filter((part) => part.trim())
        .join('\n\n');
      const write = await writeTextIfChanged(file, body ? `${body}\n` : '');
      await writeOwnerSnapshot(ownerPath(), {});
      await rm(catalogPath(), { force: true });
      return { removed: 1, changed: write.changed };
    },
  };
}
