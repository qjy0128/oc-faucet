/**
 * Pi 接入目标：把经过体检的 OpenCode 模型写入 Pi 的自定义 provider。
 *
 * Pi 的用户级模型清单在 ~/.pi/agent/models.json，provider 配置使用官方支持的
 * `baseUrl`、`api`、`apiKey`、`headers`、`models` 字段。Pi 允许 JSONC，因此读取时
 * 接受注释和尾逗号；写回时输出普通 JSON，同时保留所有未受管的 JSON 数据。
 *
 * Pi 的模型 schema 没有归属字段：我们用官方支持的自定义请求头保存 provider 归属
 * 签名，并要求模型显示名带固定前缀。不会仅凭 provider 或模型 id 同名就覆盖配置。
 *
 * 路径注入：PI_CODING_AGENT_DIR 遵循 Pi 的用户目录覆盖规则；测试也可传入
 * { agentDir, modelsFile, detectDirs }，不读取真实用户配置。
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { BridgeError } from './errors.js';
import { assertInstallArgs, writeTextIfChanged } from './target-helpers.js';

/** Pi provider 的官方配置键；同名但未签名的 provider 会被视为用户配置。 */
export const PI_PROVIDER_KEY = 'oc-faucet';

/** `headers` 是 Pi 官方支持的 provider 字段，用它记录受管身份，不添加未知字段。 */
export const PI_OWNER_HEADER = 'x-oc-faucet-owner';
export const PI_OWNER = 'oc-faucet-v1';

/** 我们写入的模型显示名前缀，同时是模型级受管签名的一部分。 */
const MODEL_NAME_PREFIX = 'OC Faucet · ';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function expandHome(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

function agentDirectory(overrides) {
  if (typeof overrides.agentDir === 'string') return overrides.agentDir;
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (typeof envDir === 'string' && envDir.trim()) return resolve(expandHome(envDir.trim()));
  return join(homedir(), '.pi', 'agent');
}

function modelsFile(overrides) {
  if (typeof overrides.modelsFile === 'string') return overrides.modelsFile;
  return join(agentDirectory(overrides), 'models.json');
}

/**
 * 将 JSONC 注释换成空格，避免注释把两边的 JSON 字符拼到一起。
 * 字符串中的斜杠和引号由状态机保护。
 */
function stripJsonComments(text) {
  // 字符串下标是 UTF-16 单位；用 split('') 保持和 text[i] 的索引一致，emoji 也不会错位。
  const out = text.split('');
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch !== '/' || (text[i + 1] !== '/' && text[i + 1] !== '*')) continue;

    const lineComment = text[i + 1] === '/';
    out[i] = ' ';
    out[i + 1] = ' ';
    i += 1;
    if (lineComment) {
      while (i + 1 < text.length && text[i + 1] !== '\n' && text[i + 1] !== '\r') {
        i += 1;
        out[i] = ' ';
      }
      continue;
    }
    let closed = false;
    while (i + 1 < text.length) {
      i += 1;
      if (text[i] === '*' && text[i + 1] === '/') {
        out[i] = ' ';
        i += 1;
        out[i] = ' ';
        closed = true;
        break;
      }
      if (text[i] !== '\n' && text[i] !== '\r') out[i] = ' ';
    }
    if (!closed) throw new SyntaxError('JSONC 注释没有结束');
  }
  return out.join('');
}

/** JSONC 只允许 JSON 值；去掉字符串外紧贴数组/对象结束符的尾逗号。 */
function removeTrailingCommas(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch !== ',') {
      out += ch;
      continue;
    }
    let next = i + 1;
    while (next < text.length && /\s/.test(text[next])) next += 1;
    if (text[next] === '}' || text[next] === ']') continue;
    out += ch;
  }
  return out;
}

function parseJsonc(text) {
  return JSON.parse(removeTrailingCommas(stripJsonComments(text)));
}

function configError(file, detail = '内容不是合法的 JSONC 对象') {
  return new BridgeError(
    `Pi 的模型配置（${file}）${detail}。为了不弄丢已有配置，这次没有改动它。请先修好文件后再试。`,
    400,
    'pi_config_corrupt',
  );
}

async function readConfig(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }

  let parsed;
  try {
    parsed = parseJsonc(text);
  } catch {
    throw configError(file);
  }
  if (!isPlainObject(parsed)) throw configError(file, '格式不对：顶层应该是一个对象');
  if (parsed.providers !== undefined && !isPlainObject(parsed.providers)) {
    throw configError(file, '格式不对：providers 应该是一个对象');
  }
  return parsed;
}

function isOwnedProvider(provider) {
  return (
    isPlainObject(provider) &&
    isPlainObject(provider.headers) &&
    provider.headers[PI_OWNER_HEADER] === PI_OWNER
  );
}

function isOwnedModel(model) {
  return (
    isPlainObject(model) &&
    typeof model.id === 'string' &&
    model.id.includes('/') &&
    typeof model.name === 'string' &&
    model.name.startsWith(MODEL_NAME_PREFIX)
  );
}

function assertSafeApiKey(apiKey) {
  // Pi 把以 ! 开头的 apiKey 当 shell 命令、把环境变量名当引用。
  // 桥接密钥使用 ocf- 前缀，不需要这两种解释。
  if (
    apiKey.startsWith('!') ||
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKey) ||
    Object.hasOwn(process.env, apiKey) ||
    /[\u0000\r\n]/.test(apiKey)
  ) {
    throw new BridgeError(
      'Pi 的密钥会把以 ! 开头的内容当命令、把变量名当环境变量引用；当前密钥可能被 Pi 误解，所以没有写入。',
      500,
      'pi_unsafe_key',
    );
  }
}

function buildModel(model) {
  const entry = {
    id: model.id,
    name: `${MODEL_NAME_PREFIX}${typeof model.name === 'string' && model.name ? model.name : model.id}`,
    reasoning: model.reasoning === true,
    input: model.images === true ? ['text', 'image'] : ['text'],
  };
  if (Number.isFinite(model.contextWindow) && model.contextWindow > 0) {
    entry.contextWindow = model.contextWindow;
  }
  // 当前 OpenCode 标准模型清单没有 maxTokens；若调用方已有可靠值才写。
  if (Number.isFinite(model.maxTokens) && model.maxTokens > 0) entry.maxTokens = model.maxTokens;
  return entry;
}

function providerConflict(file) {
  return new BridgeError(
    `Pi 的 provider「${PI_PROVIDER_KEY}」已经存在，但没有 OC Faucet 的受管标记。为保护原配置，这次没有覆盖它；请先在 Pi 配置里换一个 provider 名，或手动检查后处理。`,
    409,
    'pi_provider_conflict',
  );
}

/**
 * 创建 Pi 接入目标。
 * @param {{agentDir?:string, modelsFile?:string, detectDirs?:string[]}} [overrides] 测试路径注入
 */
export function createPiTarget(overrides = {}) {
  return {
    id: 'pi',
    label: 'Pi',

    detect() {
      const dirs = overrides.detectDirs ?? [agentDirectory(overrides)];
      return dirs.some((dir) => existsSync(dir));
    },

    async status() {
      const file = modelsFile(overrides);
      if (!existsSync(file)) return { written: false, models: [] };
      const data = await readConfig(file);
      const provider = data.providers?.[PI_PROVIDER_KEY];
      if (!isOwnedProvider(provider) || !Array.isArray(provider.models)) {
        if (isOwnedProvider(provider) && provider.models !== undefined) throw configError(file, '格式不对：受管 provider 的 models 应该是数组');
        return { written: false, models: [] };
      }
      const models = provider.models.filter(isOwnedModel).map((model) => model.id);
      return { written: models.length > 0, models };
    },

    /** 只替换可验证为本目标的模型；id 与用户条目冲突时跳过并报告。 */
    async install(models, { port, apiKey } = {}) {
      assertInstallArgs(models, { port, apiKey }, 'Pi');
      assertSafeApiKey(apiKey);

      const file = modelsFile(overrides);
      const data = await readConfig(file);
      const providers = data.providers ?? {};
      const existing = providers[PI_PROVIDER_KEY];
      if (existing !== undefined && !isOwnedProvider(existing)) throw providerConflict(file);
      if (isOwnedProvider(existing) && !Array.isArray(existing.models)) {
        throw configError(file, '格式不对：受管 provider 的 models 应该是数组');
      }

      const oldModels = isOwnedProvider(existing) ? existing.models : [];
      const kept = oldModels.filter((model) => !isOwnedModel(model));
      const userIds = new Set(
        kept.map((model) => (isPlainObject(model) && typeof model.id === 'string' ? model.id : null)).filter(Boolean),
      );
      const accepted = [];
      const skipped = [];
      const acceptedIds = new Set();
      for (const model of models) {
        if (userIds.has(model.id)) {
          skipped.push(model.id);
          continue;
        }
        if (acceptedIds.has(model.id)) continue;
        acceptedIds.add(model.id);
        accepted.push(buildModel(model));
      }

      const oldHeaders = isPlainObject(existing?.headers) ? existing.headers : {};
      providers[PI_PROVIDER_KEY] = {
        ...(isPlainObject(existing) ? existing : {}),
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: 'openai-completions',
        apiKey,
        headers: { ...oldHeaders, [PI_OWNER_HEADER]: PI_OWNER },
        models: [...kept, ...accepted],
      };
      data.providers = providers;

      const result = await writeTextIfChanged(file, `${JSON.stringify(data, null, 2)}\n`);
      return { added: accepted.length, skipped, changed: result.changed };
    },

    /** 移除带受管签名的模型，并清理只由我们建立的 provider。 */
    async uninstall() {
      const file = modelsFile(overrides);
      if (!existsSync(file)) return { removed: 0, changed: false };
      const data = await readConfig(file);
      const providers = data.providers;
      const provider = providers?.[PI_PROVIDER_KEY];
      if (!isOwnedProvider(provider)) return { removed: 0, changed: false };
      if (!Array.isArray(provider.models)) throw configError(file, '格式不对：受管 provider 的 models 应该是数组');

      const removedModels = provider.models.filter(isOwnedModel);
      const kept = provider.models.filter((model) => !isOwnedModel(model));
      // install([]) 也会建立带签名的空 provider；卸载时应把它清理干净。
      if (removedModels.length === 0 && kept.length > 0) return { removed: 0, changed: false };
      if (kept.length > 0) {
        provider.models = kept;
        const headers = { ...provider.headers };
        delete headers[PI_OWNER_HEADER];
        if (Object.keys(headers).length > 0) provider.headers = headers;
        else delete provider.headers;
      } else {
        delete provider.baseUrl;
        delete provider.api;
        delete provider.apiKey;
        delete provider.models;
        const headers = { ...provider.headers };
        delete headers[PI_OWNER_HEADER];
        if (Object.keys(headers).length > 0) provider.headers = headers;
        else delete provider.headers;
        if (Object.keys(provider).length === 0) delete providers[PI_PROVIDER_KEY];
      }
      if (Object.keys(providers).length === 0) delete data.providers;

      const result = await writeTextIfChanged(file, `${JSON.stringify(data, null, 2)}\n`);
      return { removed: removedModels.length, changed: result.changed };
    },
  };
}
