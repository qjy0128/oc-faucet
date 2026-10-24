/**
 * Kimi Code CLI 接入目标。
 *
 * 配置格式是 TOML；项目没有 TOML 解析依赖，因此只用明确的受管块写入：块外文本
 * 保持原样，块内由本模块生成。这里不宣称完整校验 TOML，只做必要的字符串状态
 * 检查和表头冲突检查；遇到未闭合字符串或损坏标记时拒绝写入。
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { BridgeError } from './errors.js';
import { describeReasoning } from './efforts.js';
import { assertInstallArgs, writeTextIfChanged } from './target-helpers.js';

const BLOCK_BEGIN = '# >>> oc-faucet >>>';
const BLOCK_END = '# <<< oc-faucet <<<';
const PROVIDER_NAME = 'oc-faucet';
const MODEL_ALIAS_PREFIX = 'oc-faucet/';
const DEFAULT_CONTEXT_SIZE = 128000;

function expandHome(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

function resolveConfigPath(overrides = {}) {
  if (typeof overrides.configPath === 'string') return overrides.configPath;
  if (process.env.OCF_KIMI_CONFIG) return process.env.OCF_KIMI_CONFIG;
  const root = process.env.KIMI_CODE_HOME;
  if (typeof root === 'string' && root.trim()) return join(expandHome(root.trim()), 'config.toml');
  return join(homedir(), '.kimi-code', 'config.toml');
}

function configError(file, detail = '格式不确定') {
  return new BridgeError(
    `Kimi Code 的配置文件（${file}）${detail}。为了避免覆盖或写入无效配置，这次没有改动它。请检查文件后重试。`,
    400,
    'kimi_config_unsafe',
  );
}

function tomlQuote(value) {
  let out = '"';
  for (const ch of String(value)) {
    const code = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\f') out += '\\f';
    else if (ch === '\r') out += '\\r';
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

function newlineOf(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function scanTomlLines(text, file) {
  const lines = [];
  let state = 'normal';
  let escaped = false;
  let start = 0;
  let i = 0;
  let lineOutsideString = true;
  while (i <= text.length) {
    const atEof = i === text.length;
    const ch = text[i];
    if (atEof || ch === '\n') {
      const end = i > start && text[i - 1] === '\r' ? i - 1 : i;
      // 行若从多行字符串内部开始，即使闭合符随后出现在同一行，也仍按字符串内容处理，
      // 避免把字符串里的内容误认成标记或表头。
      lines.push({ start, end, raw: text.slice(start, end), outsideString: lineOutsideString });
      if (state === 'basic' || state === 'literal') throw configError(file, '含有未闭合的单行字符串');
      if (state === 'comment') state = 'normal';
      start = i + 1;
      i += 1;
      lineOutsideString = state === 'normal' || state === 'comment';
      if (atEof) break;
      continue;
    }

    if (state === 'comment') {
      i += 1;
      continue;
    }
    if (state === 'basic') {
      if (escaped) {
        escaped = false;
        i += 1;
      } else if (ch === '\\') {
        escaped = true;
        i += 1;
      } else if (ch === '"') {
        state = 'normal';
        i += 1;
      } else {
        i += 1;
      }
      continue;
    }
    if (state === 'literal') {
      if (ch === "'") state = 'normal';
      i += 1;
      continue;
    }
    if (state === 'multi-basic') {
      if (escaped) {
        escaped = false;
        i += 1;
      } else if (ch === '\\') {
        escaped = true;
        i += 1;
      } else if (text.startsWith('"""', i)) {
        state = 'normal';
        i += 3;
      } else {
        i += 1;
      }
      continue;
    }
    if (state === 'multi-literal') {
      if (text.startsWith("'''", i)) {
        state = 'normal';
        i += 3;
      } else {
        i += 1;
      }
      continue;
    }

    // state === normal
    if (ch === '#') {
      state = 'comment';
      i += 1;
    } else if (text.startsWith('"""', i)) {
      state = 'multi-basic';
      i += 3;
    } else if (text.startsWith("'''", i)) {
      state = 'multi-literal';
      i += 3;
    } else if (ch === '"') {
      state = 'basic';
      i += 1;
    } else if (ch === "'") {
      state = 'literal';
      i += 1;
    } else {
      i += 1;
    }
  }
  if (state === 'multi-basic' || state === 'multi-literal' || state === 'basic' || state === 'literal') {
    throw configError(file, '含有未闭合的字符串');
  }
  return lines;
}

function markerLines(lines, file) {
  const starts = [];
  const ends = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.outsideString) continue;
    const value = line.raw.trim();
    if (value.startsWith('# >>> oc-faucet') && value !== BLOCK_BEGIN) {
      throw configError(file, '受管块开始标记格式不正确');
    }
    if (value.startsWith('# <<< oc-faucet') && value !== BLOCK_END) {
      throw configError(file, '受管块结束标记格式不正确');
    }
    if (value === BLOCK_BEGIN) starts.push(index);
    if (value === BLOCK_END) ends.push(index);
  }
  return { starts, ends };
}

function locateBlock(text, lines, file) {
  const { starts, ends } = markerLines(lines, file);
  if (starts.length === 0 && ends.length === 0) return null;
  if (starts.length !== 1 || ends.length !== 1 || starts[0] >= ends[0]) {
    throw configError(file, '受管块标记重复、缺失或顺序错误');
  }
  const first = lines[starts[0]];
  const last = lines[ends[0]];
  return { startLine: starts[0], endLine: ends[0], start: first.start, end: last.end };
}

function decodeTomlQuoted(raw) {
  const quote = raw[0];
  if (quote === "'") {
    if (raw.length < 2 || raw.at(-1) !== "'") return null;
    return raw.slice(1, -1);
  }
  if (quote !== '"' || raw.length < 2 || raw.at(-1) !== '"') return null;
  let out = '';
  for (let i = 1; i < raw.length - 1; i += 1) {
    const ch = raw[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    i += 1;
    if (i >= raw.length - 1) return null;
    const escape = raw[i];
    const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
    if (Object.hasOwn(simple, escape)) {
      out += simple[escape];
      continue;
    }
    const length = escape === 'u' ? 4 : escape === 'U' ? 8 : 0;
    if (!length) return null;
    const hex = raw.slice(i + 1, i + 1 + length);
    if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(hex)) return null;
    const code = Number.parseInt(hex, 16);
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null;
    out += String.fromCodePoint(code);
    i += length;
  }
  return out;
}

function parseDottedKey(raw) {
  const parts = [];
  let i = 0;
  while (i < raw.length) {
    while (/\s/.test(raw[i] ?? '')) i += 1;
    const start = i;
    const quote = raw[i];
    if (quote === '"' || quote === "'") {
      i += 1;
      let escaped = false;
      while (i < raw.length) {
        if (quote === '"' && !escaped && raw[i] === '\\') {
          escaped = true;
          i += 1;
          continue;
        }
        if (!escaped && raw[i] === quote) {
          i += 1;
          break;
        }
        escaped = false;
        i += 1;
      }
      const decoded = decodeTomlQuoted(raw.slice(start, i));
      if (decoded === null) return null;
      parts.push(decoded);
    } else {
      while (/[A-Za-z0-9_-]/.test(raw[i] ?? '')) i += 1;
      if (i === start) return null;
      parts.push(raw.slice(start, i));
    }
    while (/\s/.test(raw[i] ?? '')) i += 1;
    if (i === raw.length) break;
    if (raw[i] !== '.') return null;
    i += 1;
    if (i === raw.length) return null;
  }
  return parts.length > 0 ? parts : null;
}

function parseTableHeader(line, file) {
  const trimmed = line.trimStart();
  const array = trimmed.startsWith('[[');
  if (!array && !trimmed.startsWith('[')) return null;
  const openLength = array ? 2 : 1;
  let quote = null;
  let escaped = false;
  let close = -1;
  for (let i = openLength; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (quote) {
      if (quote === '"' && !escaped && ch === '\\') {
        escaped = true;
        continue;
      }
      if (!escaped && ch === quote) quote = null;
      escaped = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ']' && (!array || trimmed[i + 1] === ']')) {
      close = i;
      break;
    }
  }
  if (close < 0 || quote) throw configError(file, '含有无法识别的 TOML 表头');
  const tail = trimmed.slice(close + openLength).trim();
  if (tail && !tail.startsWith('#')) throw configError(file, '含有无法识别的 TOML 表头');
  const path = parseDottedKey(trimmed.slice(openLength, close));
  if (!path) throw configError(file, '含有无法识别的 TOML 表头');
  return { path, array };
}

function tableHeaders(text, lines, file, ignoredBlock = null) {
  const headers = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (ignoredBlock && index >= ignoredBlock.startLine && index <= ignoredBlock.endLine) continue;
    const line = lines[index];
    if (!line.outsideString) continue;
    const trimmed = line.raw.trimStart();
    if (!trimmed.startsWith('[')) continue;
    // 普通注释也以 # 开头，不会进入此分支。
    const parsed = parseTableHeader(line.raw, file);
    if (parsed) headers.push(parsed);
  }
  return headers;
}

function assignmentEqualsIndex(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index];
    if (quote) {
      if (quote === '"' && !escaped && ch === '\\') {
        escaped = true;
        continue;
      }
      if (!escaped && ch === quote) quote = null;
      escaped = false;
      continue;
    }
    if (ch === '#') return -1;
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '=') return index;
  }
  return -1;
}

function assertNoInlineTargetConflicts(text, lines, file, ignoredBlock = null) {
  let tablePath = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (ignoredBlock && index >= ignoredBlock.startLine && index <= ignoredBlock.endLine) continue;
    const line = lines[index];
    if (!line.outsideString) continue;
    const trimmed = line.raw.trimStart();
    if (trimmed.startsWith('[')) {
      const header = parseTableHeader(line.raw, file);
      if (header) tablePath = header.path;
      continue;
    }

    const equals = assignmentEqualsIndex(line.raw);
    if (equals < 0) continue;
    const keyPath = parseDottedKey(line.raw.slice(0, equals).trim());
    if (!keyPath) {
      if (/^(?:providers|models)(?:\s|\.|=|$)/.test(trimmed)) {
        throw configError(file, '含有无法安全判断的 providers/models 配置');
      }
      continue;
    }

    const fullPath = [...tablePath, ...keyPath];
    if (tablePath.length === 0 && keyPath.length === 1 && (keyPath[0] === 'providers' || keyPath[0] === 'models')) {
      // 根级内联表可能藏有供应商或模型子项。这里不做完整 TOML 解析，因此保守拒绝，
      // 避免追加与已有配置冲突的表头。
      throw configError(file, `根级 ${keyPath[0]} 内联配置无法安全合并`);
    }
    if (fullPath[0] === 'providers' && fullPath[1] === PROVIDER_NAME) {
      throw configError(file, `已有 ${PROVIDER_NAME} 供应商的点号或内联配置，无法安全合并`);
    }
    const insideModelAliasTable = tablePath[0] === 'models'
      && typeof tablePath[1] === 'string'
      && tablePath[1].startsWith(MODEL_ALIAS_PREFIX);
    if (
      !insideModelAliasTable
      && fullPath[0] === 'models'
      && typeof fullPath[1] === 'string'
      && fullPath[1].startsWith(MODEL_ALIAS_PREFIX)
    ) {
      throw configError(file, '已有 OC Faucet 模型别名的点号或内联配置，无法安全合并');
    }
  }
}

function isPrefix(path, prefix) {
  return path.length >= prefix.length && prefix.every((part, index) => path[index] === part);
}

function buildModelBlock(model, contextSize) {
  const alias = `${MODEL_ALIAS_PREFIX}${model.id}`;
  const capabilities = ['tool_use'];
  const effort = describeReasoning(model);
  if (model.reasoning === true) capabilities.push('thinking');
  if (model.images === true) capabilities.push('image_in');
  const lines = [
    `[models.${tomlQuote(alias)}]`,
    `provider = ${tomlQuote(PROVIDER_NAME)}`,
    `model = ${tomlQuote(model.id)}`,
    `max_context_size = ${contextSize}`,
    `capabilities = [${capabilities.map(tomlQuote).join(', ')}]`,
  ];
  const efforts = effort.supportedEfforts.filter((value) => value !== 'none');
  if (efforts.length > 0) lines.push(`support_efforts = [${efforts.map(tomlQuote).join(', ')}]`);
  return lines.join('\n');
}

function buildBlock(models, { port, apiKey }) {
  const lines = [
    BLOCK_BEGIN,
    `[providers.${tomlQuote(PROVIDER_NAME)}]`,
    'type = "openai"',
    `base_url = ${tomlQuote(`http://127.0.0.1:${port}/v1`)}`,
    `api_key = ${tomlQuote(apiKey)}`,
  ];
  for (const model of models) {
    const context = Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0
      ? model.contextWindow
      : DEFAULT_CONTEXT_SIZE;
    lines.push('', buildModelBlock(model, context));
  }
  lines.push(BLOCK_END);
  return lines.join('\n');
}

function spliceInstall(text, block, file) {
  const lines = scanTomlLines(text, file);
  const found = locateBlock(text, lines, file);
  const eol = newlineOf(text);
  if (found) return text.slice(0, found.start) + block + text.slice(found.end);
  if (text === '') return block;
  return `${text}${eol}${block}`;
}

function spliceUninstall(text, file) {
  const lines = scanTomlLines(text, file);
  const found = locateBlock(text, lines, file);
  if (!found) return { text, removed: false };
  let start = found.start;
  let end = found.end;
  const eol = newlineOf(text);
  // 新追加的块在 EOF 时，连同我们为标记另加的分隔换行一起摘除，尽量还原原文末尾。
  if (end === text.length && start >= eol.length && text.slice(start - eol.length, start) === eol) start -= eol.length;
  if (end < text.length && text.startsWith(eol, end)) end += eol.length;
  return { text: text.slice(0, start) + text.slice(end), removed: true };
}

function extractModelIds(text, lines, block, file) {
  if (!block) return [];
  const ids = [];
  for (let index = block.startLine + 1; index < block.endLine; index += 1) {
    const header = parseTableHeader(lines[index].raw, file);
    if (header?.path[0] === 'models' && header.path.length === 2 && header.path[1].startsWith(MODEL_ALIAS_PREFIX)) {
      ids.push(header.path[1].slice(MODEL_ALIAS_PREFIX.length));
    }
  }
  return ids;
}

async function readText(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/** 创建 Kimi Code CLI 接入目标。 */
export function createKimiTarget(overrides = {}) {
  const path = () => resolveConfigPath(overrides);
  return {
    id: 'kimi',
    label: 'Kimi Code',

    detect() {
      return existsSync(dirname(path()));
    },

    async status() {
      const file = path();
      const text = await readText(file);
      if (text === null) return { written: false, models: [] };
      try {
        const lines = scanTomlLines(text, file);
        const block = locateBlock(text, lines, file);
        return block
          ? { written: true, models: extractModelIds(text, lines, block, file) }
          : { written: false, models: [] };
      } catch {
        return { written: false, models: [] };
      }
    },

    async install(models, { port, apiKey } = {}) {
      assertInstallArgs(models, { port, apiKey }, 'Kimi Code');
      const file = path();
      const existing = await readText(file);
      const text = existing ?? '';
      const lines = scanTomlLines(text, file);
      const block = locateBlock(text, lines, file);
      const headers = tableHeaders(text, lines, file, block);
      assertNoInlineTargetConflicts(text, lines, file, block);
      const providerPath = ['providers', PROVIDER_NAME];
      if (headers.some(({ path: headerPath }) => isPrefix(headerPath, providerPath))) {
        throw new BridgeError(
          `Kimi Code 配置里已有与 ${PROVIDER_NAME} 相同的供应商表，无法安全添加；请先在 config.toml 里处理冲突。`,
          409,
          'kimi_provider_conflict',
        );
      }
      const aliases = new Set();
      const accepted = [];
      const skipped = [];
      for (const model of models) {
        if (aliases.has(model.id)) continue;
        aliases.add(model.id);
        if ([...model.id].some((char) => char.codePointAt(0) < 0x20 || char.codePointAt(0) === 0x7f)) {
          throw new BridgeError('模型 id 含有控制字符，无法安全写入 Kimi Code 配置。', 400, 'bad_models');
        }
        const alias = `${MODEL_ALIAS_PREFIX}${model.id}`;
        if (headers.some(({ path: headerPath }) => headerPath[0] === 'models' && headerPath[1] === alias)) {
          skipped.push(model.id);
        } else {
          accepted.push(model);
        }
      }
      if (accepted.length === 0 && !block) return { added: 0, skipped, changed: false };
      const next = spliceInstall(text, buildBlock(accepted, { port, apiKey }), file);
      const result = await writeTextIfChanged(file, next);
      return { added: accepted.length, skipped, changed: result.changed };
    },

    async uninstall() {
      const file = path();
      const existing = await readText(file);
      if (existing === null) return { removed: 0, changed: false };
      const result = spliceUninstall(existing, file);
      if (!result.removed) return { removed: 0, changed: false };
      const write = await writeTextIfChanged(file, result.text);
      return { removed: 1, changed: write.changed };
    },
  };
}
