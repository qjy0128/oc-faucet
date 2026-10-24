/**
 * Claude Code 接入目标。
 *
 * 复用桥里现成的 Anthropic Messages 接口（/v1/messages），不新增协议。写进
 * `~/.claude/settings.json` 的键：
 *   env.ANTHROPIC_BASE_URL                本机转发口（Claude Code 自己接 /v1/messages）
 *   env.ANTHROPIC_AUTH_TOKEN              转发口密钥，Claude Code 以 Authorization: Bearer 发出
 *   env.CLAUDE_CODE_MAX_CONTEXT_TOKENS    仅当所有所选模型窗口相同时申报（该变量是全局的）
 *   env.OC_FAUCET_TARGET_MODELS           我们写入的模型清单（status() 实读它，也当归属签名）
 *   env.OC_FAUCET_TARGET_OWNER            稳定归属标记，避免把用户自己的本机网关当成我们写的
 *   model                                 默认模型。不用 ANTHROPIC_MODEL：它会盖掉 /model 里选的模型
 *   modelSettings.<id>.effortLevel        把档位锁进模型真有的那几档（Claude Code 默认发 high）
 *   modelPicker.options                   /model 菜单行（官方字段，v2.1.242+），每个所选模型一行；
 *                                         行 description 以 "via modelOC" 结尾当归属签名（借自
 *                                         Magpie 的 "via magpie"）；用户自写的不覆盖、不摘除
 *
 * 归属与还原：要求本机地址和专用标记同时匹配；写入前先可靠落盘被覆盖的原值。
 * 快照丢失或损坏时拒绝安装/卸载，避免把已写入的值误当成用户原配置。
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { BridgeError } from './errors.js';
import { describeReasoning } from './efforts.js';
import { assertInstallArgs, writeTextIfChanged, writeOwnerSnapshot } from './target-helpers.js';
import { dataDir } from './settings.js';

const MARKER_ENV_KEY = 'OC_FAUCET_TARGET_MODELS';
const OWNER_ENV_KEY = 'OC_FAUCET_TARGET_OWNER';
const OWNER_ENV_VALUE = 'oc-faucet:claude:v1';
const DISCOVERY_ENV_KEY = 'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY';
const OWNER_SNAPSHOT_VERSION = 1;
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'];
const PICKER_PATH = ['modelPicker'];
/** /model 菜单行的归属签名：每行 description 都以它结尾。 */
const PICKER_NOTE = 'via modelOC';

function expandHome(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

/** settings.json 路径：测试注入 > OCF_CLAUDE_SETTINGS > CLAUDE_CONFIG_DIR > ~/.claude */
function resolveSettingsPath(overrides = {}) {
  if (typeof overrides.settingsPath === 'string') return overrides.settingsPath;
  if (process.env.OCF_CLAUDE_SETTINGS) return process.env.OCF_CLAUDE_SETTINGS;
  const dir = process.env.CLAUDE_CONFIG_DIR;
  if (typeof dir === 'string' && dir.trim()) return join(expandHome(dir.trim()), 'settings.json');
  return join(homedir(), '.claude', 'settings.json');
}

function resolveOwnerFile(overrides = {}) {
  if (typeof overrides.ownerFile === 'string') return overrides.ownerFile;
  if (process.env.OCF_CLAUDE_OWNER) return process.env.OCF_CLAUDE_OWNER;
  return join(dataDir(), 'claude-owner-backup.json');
}

function configError(file, detail) {
  return new BridgeError(
    `Claude Code 的配置（${file}）${detail}。为了不覆盖或写坏你的配置，这次没有改动它。请检查后重试。`,
    400,
    'claude_config_unsafe',
  );
}

function ownerSnapshotError(file, detail) {
  return new BridgeError(
    `Claude Code 的归属快照（${file}）${detail}。为了避免覆盖用户原配置，这次没有改动 Claude Code 配置。请先恢复快照或人工处理。`,
    409,
    'claude_owner_snapshot_unsafe',
  );
}

function readJsonFile(text, file) {
  if (text.trim() === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw configError(file, '不是合法 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw configError(file, '顶层不是一个 JSON 对象');
  }
  for (const key of ['env', 'modelSettings']) {
    const value = parsed[key];
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
      throw configError(file, `的 ${key} 段不是一个对象`);
    }
  }
  return parsed;
}

/** 新配置靠专用标记识别；兼容旧配置时，还要求本机地址、密钥和模型清单同时匹配。 */
function isWrittenByUs(settings) {
  const env = settings.env ?? {};
  const base = env.ANTHROPIC_BASE_URL;
  if (typeof base !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+(?:\/|$)/.test(base)) return false;
  if (env[OWNER_ENV_KEY] === OWNER_ENV_VALUE) return true;

  const token = env.ANTHROPIC_AUTH_TOKEN;
  const marker = env[MARKER_ENV_KEY];
  const modelIds = typeof marker === 'string' ? marker.split(',') : [];
  return typeof token === 'string' && token.length > 0 && modelIds.length > 0
    && modelIds.every((id) => typeof id === 'string' && /^[^/,]+\/.+/.test(id));
}

/** 该设置是全局值；只有所有所选模型都给出同一窗口时才安全写入。 */
function sharedContextWindow(models) {
  const windows = models.map((model) => model?.contextWindow);
  if (!windows.length || windows.some((value) => !Number.isSafeInteger(value) || value <= 0)) return null;
  if (windows.some((value) => value !== windows[0])) return null;
  return String(windows[0]);
}

/** /model 菜单行：model 用完整模型 ID（官方允许网关 ID 原样进菜单），label 用显示名。 */
function pickerRows(models) {
  return models.map((model) => ({
    model: model.id,
    label: typeof model.name === 'string' && model.name ? model.name : model.id,
    description: PICKER_NOTE,
  }));
}

/** 这份 modelPicker 是不是我们写的：每行 description 都带 modelOC 签名。 */
function isModelOCPicker(value) {
  if (!isPlainObject(value)) return false;
  const rows = value.options;
  if (!Array.isArray(rows) || rows.length === 0) return false;
  return rows.every((row) => isPlainObject(row)
    && typeof row.model === 'string' && row.model
    && typeof row.description === 'string' && row.description.endsWith(PICKER_NOTE));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizePath(path) {
  return Array.isArray(path) ? path : path.split('.');
}

function pathKey(path) {
  return JSON.stringify(normalizePath(path));
}

/** 按字段路径读取值，同时区分「字段不存在」和「字段值为 null」。 */
function readPathState(settings, path) {
  const parts = normalizePath(path);
  let node = settings;
  for (const part of parts) {
    if (!isPlainObject(node) || !Object.hasOwn(node, part)) return { present: false };
    node = node[part];
  }
  return { present: true, value: node };
}

/** 按字段路径写/删；父对象空了就一并删掉，不留空壳。 */
function writePathState(settings, path, state) {
  const parts = normalizePath(path);
  let node = settings;
  const parents = [];
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (!isPlainObject(node[part])) node[part] = {};
    parents.push([node, part]);
    node = node[part];
  }
  const last = parts.at(-1);
  if (state.present) node[last] = state.value;
  else delete node[last];

  for (const [parent, part] of parents.reverse()) {
    if (!isPlainObject(parent[part]) || Object.keys(parent[part]).length > 0) break;
    delete parent[part];
  }
}

function absentState() {
  return { present: false };
}

function sameState(left, right) {
  if (left.present !== right.present) return false;
  return !left.present || isDeepStrictEqual(left.value, right.value);
}

function emptyOwnerSnapshot() {
  return { version: OWNER_SNAPSHOT_VERSION, keys: {} };
}

function validState(state) {
  return isPlainObject(state) && typeof state.present === 'boolean'
    && (!state.present || Object.hasOwn(state, 'value'));
}

function validateOwnerSnapshot(parsed, file) {
  if (!isPlainObject(parsed)) throw ownerSnapshotError(file, '不是合法的 JSON 对象');

  if (!Object.hasOwn(parsed, 'version')) {
    // 旧版本是平铺的点号路径对象。按旧规则拆分，确保可以清理旧版本生成的嵌套项。
    const keys = {};
    for (const [oldPath, original] of Object.entries(parsed)) {
      const path = oldPath.split('.');
      keys[pathKey(path)] = {
        path,
        original: original === null ? absentState() : { present: true, value: original },
        applied: null,
        legacy: true,
      };
    }
    return { version: OWNER_SNAPSHOT_VERSION, keys };
  }

  if (parsed.version !== OWNER_SNAPSHOT_VERSION || !isPlainObject(parsed.keys)) {
    throw ownerSnapshotError(file, '格式不受支持或已损坏');
  }

  const keys = {};
  for (const [key, entry] of Object.entries(parsed.keys)) {
    if (!isPlainObject(entry) || !Array.isArray(entry.path) || !entry.path.length
      || entry.path.some((part) => typeof part !== 'string' || !part)
      || key !== pathKey(entry.path) || !validState(entry.original)
      || (entry.applied !== null && !validState(entry.applied))
      || (entry.legacy !== undefined && typeof entry.legacy !== 'boolean')) {
      throw ownerSnapshotError(file, '格式不受支持或已损坏');
    }
    keys[key] = entry;
  }
  return { version: OWNER_SNAPSHOT_VERSION, keys };
}

async function readOwnerSnapshotStrict(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, owner: emptyOwnerSnapshot() };
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw ownerSnapshotError(file, '不是合法 JSON');
  }
  return { exists: true, owner: validateOwnerSnapshot(parsed, file) };
}

function saveOwnedSetting(settings, owner, path, value) {
  const key = pathKey(path);
  const state = { present: true, value };
  let entry = owner.keys[key];
  if (!entry) {
    entry = {
      path: normalizePath(path),
      original: readPathState(settings, path),
      applied: null,
    };
    owner.keys[key] = entry;
  } else if (entry.applied && !sameState(readPathState(settings, path), entry.applied)) {
    // 用户在上次安装后改过受管值；本次重新接管前先把新值记为应恢复的原值。
    entry.original = readPathState(settings, path);
  }
  writePathState(settings, path, state);
  entry.applied = state;
  delete entry.legacy;
}

function releaseOwnedSetting(settings, owner, path) {
  const key = pathKey(path);
  const entry = owner.keys[key];
  if (!entry) return;
  const current = readPathState(settings, path);
  if ((entry.applied && sameState(current, entry.applied)) || (entry.legacy && current.present)) {
    writePathState(settings, path, entry.original);
  }
  delete owner.keys[key];
}

/**
 * 写 modelPicker 进快照与配置。与 saveOwnedSetting 的差别：现值只要还带 modelOC
 * 签名，哪怕和上次写入不同（用户手改过行、或旧版本写的），original 也不取它——
 * 否则卸载会把它还原成一份过期的我方菜单。
 */
function saveOwnedPicker(settings, owner, rows) {
  const key = pathKey(PICKER_PATH);
  const state = { present: true, value: { options: rows } };
  let entry = owner.keys[key];
  const current = readPathState(settings, PICKER_PATH);
  if (!entry) {
    entry = {
      path: [...PICKER_PATH],
      original: current.present && isModelOCPicker(current.value) ? absentState() : current,
      applied: null,
    };
    owner.keys[key] = entry;
  } else if (entry.applied && !sameState(current, entry.applied) && !isModelOCPicker(current.value)) {
    entry.original = current;
  }
  writePathState(settings, PICKER_PATH, state);
  entry.applied = state;
  delete entry.legacy;
}

function assertSnapshotCoversConfig(settings, owner, file) {
  if (!isWrittenByUs(settings)) return;
  const requiredEnvKeys = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', MARKER_ENV_KEY];
  if (settings.env?.[OWNER_ENV_KEY] === OWNER_ENV_VALUE) {
    requiredEnvKeys.push(DISCOVERY_ENV_KEY, OWNER_ENV_KEY);
  }
  const required = [...requiredEnvKeys.map((key) => ['env', key]), ['model']];
  for (const path of required) {
    if (!owner.keys[pathKey(path)]) throw ownerSnapshotError(file, '缺少配置所需的原值记录');
  }
}

/**
 * 把该写的键写进去。owner 就地累积被覆盖的原值，调用方负责落盘。
 * @returns {object} 改好的配置对象
 */
function applyPatch(settings, models, { port, apiKey }, owner) {
  const next = JSON.parse(JSON.stringify(settings));
  const effortSettings = [];
  for (const model of models) {
    const effort = describeReasoning(model).defaultEffort;
    if (!effort || !EFFORT_LEVELS.includes(effort)) continue;
    effortSettings.push({ path: ['modelSettings', model.id, 'effortLevel'], value: effort });
  }
  const desiredEffortKeys = new Set(effortSettings.map(({ path }) => pathKey(path)));
  for (const entry of Object.values(owner.keys)) {
    if (entry.path[0] === 'modelSettings' && entry.path.at(-1) === 'effortLevel'
      && !desiredEffortKeys.has(pathKey(entry.path))) {
      releaseOwnedSetting(next, owner, entry.path);
    }
  }

  const writes = [
    [['env', 'ANTHROPIC_BASE_URL'], `http://127.0.0.1:${port}`],
    [['env', 'ANTHROPIC_AUTH_TOKEN'], apiKey],
    [['env', DISCOVERY_ENV_KEY], '1'],
    [['env', MARKER_ENV_KEY], models.map((model) => model.id).join(',')],
    [['env', OWNER_ENV_KEY], OWNER_ENV_VALUE],
    [['model'], models[0].id],
  ];
  for (const [path, value] of writes) {
    saveOwnedSetting(next, owner, path, value);
  }

  const contextPath = ['env', 'CLAUDE_CODE_MAX_CONTEXT_TOKENS'];
  const contextWindow = sharedContextWindow(models);
  if (contextWindow === null) releaseOwnedSetting(next, owner, contextPath);
  else saveOwnedSetting(next, owner, contextPath, contextWindow);

  for (const { path, value } of effortSettings) {
    saveOwnedSetting(next, owner, path, value);
  }

  // /model 菜单：用户自己写过 modelPicker 就整份让位（与 Magpie 一致），否则换成我们的行。
  const picker = readPathState(next, PICKER_PATH);
  if (!picker.present || isModelOCPicker(picker.value)) {
    saveOwnedPicker(next, owner, pickerRows(models));
  }
  return next;
}

/** 只还原仍保持我方写入值的字段，用户后来改过的内容予以保留。 */
function restoreOwnedKeys(settings, owner) {
  const next = JSON.parse(JSON.stringify(settings));
  for (const entry of Object.values(owner.keys)) {
    const current = readPathState(next, entry.path);
    if (entry.legacy && entry.applied === null) {
      writePathState(next, entry.path, entry.original);
    } else if (entry.applied && sameState(current, entry.applied)) {
      writePathState(next, entry.path, entry.original);
    }
  }
  return next;
}

/**
 * 创建 Claude Code 接入目标。
 * @param {object} [overrides] 测试用的路径注入
 */
export function createClaudeTarget(overrides = {}) {
  const path = () => resolveSettingsPath(overrides);
  const ownerPath = () => resolveOwnerFile(overrides);

  return {
    id: 'claude',
    label: 'Claude Code',
    protocol: 'anthropic',
    selectsModels: true,

    detect() {
      return existsSync(dirname(path()));
    },

    async status() {
      const file = path();
      const text = await readFileOrNone(file);
      if (text === null) return { written: false, models: [] };
      let settings;
      try {
        settings = readJsonFile(text, file);
      } catch {
        return { written: false, models: [] };
      }
      if (!isWrittenByUs(settings)) return { written: false, models: [] };
      const marker = settings.env?.[MARKER_ENV_KEY];
      return { written: true, models: typeof marker === 'string' && marker ? marker.split(',') : [] };
    },

    async install(models, { port, apiKey } = {}) {
      assertInstallArgs(models, { port, apiKey }, 'Claude Code');
      if (!models.length) {
        throw new BridgeError('模型清单是空的，没法写入 Claude Code。请至少勾选一个可用模型。', 400, 'bad_models');
      }
      const file = path();
      const settings = readJsonFile((await readFileOrNone(file)) ?? '', file);
      const snapshotFile = ownerPath();
      const alreadyOwned = isWrittenByUs(settings);
      const snapshot = await readOwnerSnapshotStrict(snapshotFile);
      if (alreadyOwned && !snapshot.exists) {
        throw ownerSnapshotError(snapshotFile, '不存在');
      }
      const owner = snapshot.owner;
      assertSnapshotCoversConfig(settings, owner, snapshotFile);
      const next = applyPatch(settings, models, { port, apiKey }, owner);
      // 先持久化用户原值，确保配置写入失败时也不会丢失恢复依据。
      await writeOwnerSnapshot(snapshotFile, owner);
      const write = await writeTextIfChanged(file, `${JSON.stringify(next, null, 2)}\n`);
      return { added: models.length, skipped: [], changed: write.changed };
    },

    async uninstall() {
      const file = path();
      const text = await readFileOrNone(file);
      if (text === null) return { removed: 0, changed: false };
      const settings = readJsonFile(text, file);
      if (!isWrittenByUs(settings)) return { removed: 0, changed: false };
      const snapshotFile = ownerPath();
      const snapshot = await readOwnerSnapshotStrict(snapshotFile);
      if (!snapshot.exists) throw ownerSnapshotError(snapshotFile, '不存在');
      const owner = snapshot.owner;
      assertSnapshotCoversConfig(settings, owner, snapshotFile);
      // 快照缺 modelPicker 记录、但配置里的菜单确带 modelOC 签名时（如快照被手工裁过），
      // 补一条「原值不存在」，让通用还原逻辑把它摘掉（对齐 Magpie 靠签名认领的做法）。
      const picker = readPathState(settings, PICKER_PATH);
      if (picker.present && isModelOCPicker(picker.value) && !owner.keys[pathKey(PICKER_PATH)]) {
        owner.keys[pathKey(PICKER_PATH)] = {
          path: [...PICKER_PATH],
          original: absentState(),
          applied: { present: true, value: picker.value },
        };
      }
      const next = restoreOwnedKeys(settings, owner);
      const write = await writeTextIfChanged(file, `${JSON.stringify(next, null, 2)}\n`);
      await writeOwnerSnapshot(snapshotFile, emptyOwnerSnapshot());
      return { removed: 1, changed: write.changed };
    },
  };
}

async function readFileOrNone(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}
