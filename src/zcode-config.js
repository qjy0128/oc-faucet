/**
 * ZCode 供应商配置托管。
 *
 * ZCode 把用户的供应商配置放在 ~/.zcode/v2/provider_config.json，结构是：
 * {
 *   schemaVersion: 1,
 *   config: {
 *     providerOrder: ["openrouter", "deepseek", ...],
 *     providerConfigRules: { providerRules: [ {providerId, templateId, providerName, config:{...}} ] },
 *     modelConfigRules: { providerModelRules: [...], manualProviderModelRules: [...] }
 *   }
 * }
 *
 * 我们只往 providerRules 里加**自己那一条**（providerId = oc-faucet），
 * 把它的 baseUrl 指向本机转发口。用户手写的供应商、以及 ZCode 自带的那些，
 * 一条都不许动。卸载时也只摘掉自己那一条。
 *
 * config 字段的形状（从 ZCode 内置配置与 bundle 里的 schema 反推确认）：
 *   group: 'standard-personal'   —— 只有这个组允许 api.baseUrl 指向任意地址
 *   access: { type:'api-key', apiKey }  —— 本机口自己发的密钥
 *   api: { type:'anthropic-messages', baseUrl }  —— ZCode 用 Anthropic 协议跟我们说话
 *   personalModelIds: [模型id...]  —— 我们自己声明的模型
 *   modelOrder: [...]              —— 显示顺序
 *
 * 另外还得处理一个坑：我们借用的 "anthropic" 模板自带 5 个 claude 模型名，
 * 光写 personalModelIds 并不能把它们从菜单里去掉——ZCode 会把模板自带的
 * 一起列出来。本机转发口并不提供这些模型，用户点到就是失败。所以安装时
 * 按 ZCode 自己的规则（modelConfigRules.providerModelRules）给 oc-faucet
 * 逐条写明 enabled:false。卸载时一并摘掉。
 */
import { readFile, writeFile, rename, mkdir, copyFile, readdir } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { BridgeError } from './errors.js';
import { ANTHROPIC_REASONING_MAP, describeReasoning } from './efforts.js';

/** 我们在 ZCode 里注册的供应商 id。改这个值等于换一个身份，原有配置会被当成别人的。 */
export const PROVIDER_ID = 'oc-faucet';

/** 显示给用户看的供应商名字 */
export const PROVIDER_NAME = 'OC Faucet（OpenCode）';

/** 借用的 ZCode 模板 id。这个模板自带 5 个 claude 模型名，见 disableBuiltinModels()。 */
export const TEMPLATE_ID = 'anthropic';

/**
 * ZCode 自己那份「内置供应商清单」可能待的两处地方：
 *   1. 应用包里   /Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json
 *   2. 运行目录   ~/.zcode/v2/runtime/provider/<平台>/<版本>/endpoint-<hash>/zcode-builtin.json
 * 两处内容可能不同（运行目录那份会随增量更新变新），所以优先读运行目录里 revision 最大的，
 * 读不到再退回应用包。ZCode 没装或换了布局时，整体静默跳过——这个功能是锦上添花，不该拦住安装。
 */
function builtinConfigCandidates() {
  const out = [];
  const runtimeRoot = process.env.OCF_ZCODE_RUNTIME ?? join(homedir(), '.zcode', 'v2', 'runtime', 'provider');
  try {
    for (const platform of readdirSync(runtimeRoot)) {
      const platformDir = join(runtimeRoot, platform);
      let versions;
      try {
        versions = readdirSync(platformDir);
      } catch {
        continue;
      }
      for (const version of versions) {
        const versionDir = join(platformDir, version);
        let endpoints;
        try {
          endpoints = readdirSync(versionDir);
        } catch {
          continue;
        }
        for (const endpoint of endpoints) {
          const file = join(versionDir, endpoint, 'zcode-builtin.json');
          if (existsSync(file)) out.push(file);
        }
      }
    }
  } catch {
    /* 目录不存在就算了 */
  }
  const bundled =
    process.env.OCF_ZCODE_BUILTIN ??
    '/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json';
  if (existsSync(bundled)) out.push(bundled);
  return out;
}

/**
 * 问 ZCode 要某个模板自带哪些模型。
 *
 * 为什么不写死一份常量：这份清单是 ZCode 的，会随它的版本变。写死等于赌它不变，
 * 赌错了用户就会在菜单里看到点不通的模型。读不到就返回空数组——宁可少禁用，不可乱禁用。
 */
export async function templateBuiltinModelIds(templateId = TEMPLATE_ID) {
  let best = [];
  let bestRevision = -1;
  for (const file of builtinConfigCandidates()) {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      continue;
    }
    const revision = Number.isInteger(parsed?.revision) ? parsed.revision : 0;
    const templates = parsed?.config?.providerConfigRules?.templateRules;
    if (!Array.isArray(templates)) continue;
    const rule = templates.find((t) => t?.templateId === templateId);
    const ids = rule?.config?.builtinModelIds;
    if (!Array.isArray(ids)) continue;
    // 取 revision 最大的那份：ZCode 增量更新后，运行目录里的比应用包里的新。
    if (revision > bestRevision) {
      bestRevision = revision;
      best = ids.filter((x) => typeof x === 'string' && x);
    }
  }
  return best;
}

/**
 * 拼出「禁用模板自带模型」的规则。
 *
 * 我们借用的 anthropic 模板自带 claude-fable-5-1 等 5 个模型名，ZCode 会把它们
 * 和 personalModelIds 一起摆在菜单里。本机转发口并不提供这些模型，用户点到就是
 * 一次注定失败的请求。这里按 ZCode 自己的规则逐条写 enabled:false 把它们摘掉。
 *
 * 只禁用「不在我们自己清单里」的：万一哪天我们的模型名和模板自带的重名，
 * 也不该把自己的模型禁掉。
 */
export async function disableBuiltinModels(ourModelIds) {
  const builtin = await templateBuiltinModelIds();
  const ours = new Set(ourModelIds);
  return builtin
    .filter((id) => !ours.has(id))
    .map((modelId) => ({ providerId: PROVIDER_ID, modelId, config: { enabled: false } }));
}

/** ZCode 用户配置文件路径 */
export function configPath() {
  return process.env.OCF_ZCODE_CONFIG ?? join(homedir(), '.zcode', 'v2', 'provider_config.json');
}

/** ZCode 配置目录（备份文件放这儿） */
function configDir() {
  return dirname(configPath());
}

/** 读配置。文件不存在或坏了都返回一个空骨架，不抛异常——用户可能还没用过 ZCode。 */
export async function readConfig() {
  const file = configPath();
  if (!existsSync(file)) return emptyConfig();
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return emptyConfig();
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 坏文件不要静默覆盖，交给调用方决定——但读操作本身不该炸。
    return emptyConfig();
  }
  return normalize(parsed);
}

function emptyConfig() {
  return {
    schemaVersion: 1,
    config: {
      providerOrder: [],
      providerConfigRules: { providerRules: [] },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    },
  };
}

/** 把读到的配置补全成我们后续能安全读写的形状 */
function normalize(raw) {
  const base = emptyConfig();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const config = raw.config && typeof raw.config === 'object' && !Array.isArray(raw.config) ? raw.config : {};
  const rules = config.providerConfigRules;
  const providerRules =
    rules && typeof rules === 'object' && Array.isArray(rules.providerRules) ? rules.providerRules : [];
  const modelRules = config.modelConfigRules && typeof config.modelConfigRules === 'object' ? config.modelConfigRules : {};
  return {
    ...raw,
    schemaVersion: Number.isInteger(raw.schemaVersion) ? raw.schemaVersion : 1,
    config: {
      ...config,
      providerOrder: Array.isArray(config.providerOrder) ? config.providerOrder : [],
      providerConfigRules: { ...rules, providerRules },
      modelConfigRules: {
        ...modelRules,
        providerModelRules: Array.isArray(modelRules.providerModelRules) ? modelRules.providerModelRules : [],
        manualProviderModelRules: Array.isArray(modelRules.manualProviderModelRules)
          ? modelRules.manualProviderModelRules
          : [],
      },
    },
  };
}

/**
 * 拼出我们那一条 provider 规则。
 *
 * 注意 config 里**不能出现 `builtinModelIds`**：ZCode 对 standard-personal 组的
 * 配置做的是严格校验（多余字段直接判非法），而这个组本来就不允许声明内置模型——
 * 它只认 personalModelIds。用户自己加的那些供应商（openrouter、minimax-2 …）
 * 也都只有 group/access/api/personalModelIds/modelOrder 这几个字段。
 */
export function buildProviderRule({ port, apiKey, models }) {
  const ids = models.map((m) => m.id);
  return {
    providerId: PROVIDER_ID,
    templateId: TEMPLATE_ID,
    providerName: PROVIDER_NAME,
    enabled: true,
    config: {
      group: 'standard-personal',
      access: { type: 'api-key', apiKey },
      api: { type: 'anthropic-messages', baseUrl: `http://127.0.0.1:${port}` },
      personalModelIds: ids,
      modelOrder: ids,
    },
  };
}

/**
 * 把 OpenCode 的模型摊成 ZCode 认识的「能力声明」。
 *
 * 为什么需要：ZCode 光知道一个 modelId，是不知道它能不能看图、支持哪些推理档位的。
 * 它自己有一套内置能力表（`zcode-builtin.json` 的 `modelConfigRules.modelRules`），
 * 按 modelId 正则匹配，兜底规则是"不支持视觉、档位 disabled/enabled"。
 * 水龙头接入的模型大多不在那张表里，于是界面上显示的能力是错的——
 * 明明能看图的模型不带"视觉"标记，明明有 low/high/max 的模型只能选开/关。
 * 这些声明就是拿来盖掉那张内置表的。
 *
 * 写在 `providerModelRules` 而不是 `manualProviderModelRules`：后者是受限子集，
 * 只有 image/video/pdf 和档位，写不了 supportsText、outputFormat 这些；
 * 而 `providerModelRules` 的 config 是完整模型配置，覆盖时是按字段嵌套合并的，
 * 只写我们要改的那几项就够了，其余（比如内置的 maxOutputTokens）原样保留。
 *
 * 字段名和 `reasoningLevel.map` 的写法都不是猜的，是从 ZCode 内置供应商配置
 * 里逐字对照出来的（同一个文件里就有 43 种真实写法）。
 *
 * @param {Array<object>} models
 * @returns {Array<object>} providerModelRules 数组
 */
export function buildCapabilityRules(models) {
  if (!Array.isArray(models)) return [];

  return models.map((m) => {
    const effort = describeReasoning(m);
    // ZCode 的映射表达式只认 "disabled" 这个字面量来关思考；
    // OpenCode 那边对应的是 variants 里的 none，所以界面上把它显示成 disabled。
    const values = effort.supportedEfforts.map((e) => (e === 'none' ? 'disabled' : e));

    const properties = {
      inputFormat: {
        supportsText: true,
        supportsImage: m.images === true,
        supportsVideo: m.video === true,
        supportsAudio: false,
        supportsPdf: m.pdf === true,
      },
      outputFormat: { supportsText: true },
      // 这几个按本项目实测的语义写死：
      //   - 工具调用：走信封协议，由本桥翻译，模型本身要能产出 calls
      //   - 结构化输出 / 原生搜索 / 会话中系统消息：OpenCode 都没提供，别谎称支持
      supportsToolCall: true,
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
    };
    if (Number.isFinite(m.contextWindow) && m.contextWindow > 0) {
      properties.contextWindow = m.contextWindow;
    }

    /** @type {Record<string,unknown>} */
    const config = { enabled: true, properties };
    // 没有可申报的档位就别写这一项：写了反而会让界面上出现一个选了没反应的档位框
    if (values.length) {
      config.optionSpecs = {
        reasoningLevel: { values, map: ANTHROPIC_REASONING_MAP },
      };
    }

    return { providerId: PROVIDER_ID, modelId: m.id, config };
  });
}

/** 在已读出的配置里找我们那一条 provider 规则（没有 → undefined） */
function findOurRule(config) {
  return config.config.providerConfigRules.providerRules.find((r) => r?.providerId === PROVIDER_ID);
}

/** 当前是否已经装上了、装的什么 */
export async function status() {
  const rule = findOurRule(await readConfig());
  if (!rule) return { installed: false, port: null, models: 0 };
  const baseUrl = rule?.config?.api?.baseUrl ?? '';
  const match = /:(\d+)\/?$/.exec(baseUrl);
  return {
    installed: true,
    port: match ? Number(match[1]) : null,
    models: Array.isArray(rule?.config?.personalModelIds) ? rule.config.personalModelIds.length : 0,
  };
}

/**
 * 实读配置文件，返回我们那一条 provider 规则里的 personalModelIds 数组；
 * 没装上、或那条没有合法的清单字段，都返回 []。
 * 给 target-zcode 的 status() 用——它不该自己钻 config 内部的三层字段。
 */
export async function readOurModelIds() {
  const rule = findOurRule(await readConfig());
  return Array.isArray(rule?.config?.personalModelIds) ? rule.config.personalModelIds : [];
}

/** 写盘：备份 → 加锁 → 原子替换。内容没变就不写。 */
async function writeConfig(config, { backup = true } = {}) {
  const file = configPath();
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  const payload = `${JSON.stringify(config, null, 2)}\n`;

  let existing = null;
  if (existsSync(file)) {
    existing = await readFile(file, 'utf8');
    if (existing === payload) return { changed: false };
  }

  if (backup && existing !== null) {
    await backupOnce(existing);
  }

  const tmp = `${file}.oc-faucet.tmp`;
  await writeFile(tmp, payload, { mode: 0o600 });
  await rename(tmp, file);
  return { changed: true };
}

/**
 * 备份当前配置。同一天只备份一次，避免每次刷新都堆一堆文件。
 * 备份失败不算致命——写配置本身更重要。
 */
async function backupOnce(existing) {
  try {
    const stamp = new Date().toISOString().slice(0, 10);
    const target = join(configDir(), `provider_config.json.oc-faucet-backup-${stamp}`);
    if (existsSync(target)) return;
    await writeFile(target, existing, { mode: 0o600 });
  } catch {
    /* 备份是尽力而为 */
  }
}

/**
 * 装上/更新我们的那一条。
 * **只动 providerId === PROVIDER_ID 的那一条**，其余原样保留（包括顺序）。
 */
export async function install({ port, apiKey, models }) {
  if (!Number.isInteger(port) || port <= 0) throw new BridgeError('转发口端口不合法，无法写入 ZCode 配置', 500, 'bad_port');
  if (typeof apiKey !== 'string' || !apiKey) throw new BridgeError('本机密钥缺失，无法写入 ZCode 配置', 500, 'bad_key');
  if (!Array.isArray(models)) throw new BridgeError('模型清单不合法', 500, 'bad_models');
  // 空清单一个字节都不许写：写了只会得到一条 personalModelIds 为空的条目——
  // 面板上显示「未写入」、停服摘除会跳过它，等于把明文密钥白白留在配置里。
  if (models.length === 0) {
    throw new BridgeError('没有可写入的模型，这次没有动 ZCode 的配置。请先在面板里体检一遍，再点「一键接入」。', 400, 'no_models');
  }

  const config = await readConfig();
  const rules = config.config.providerConfigRules.providerRules;
  const mine = buildProviderRule({ port, apiKey, models });
  const index = rules.findIndex((r) => r?.providerId === PROVIDER_ID);

  if (index >= 0) rules[index] = mine;
  else rules.push(mine);

  // 把模板自带的模型逐条禁掉，免得用户点到本机口不提供的模型。
  const disableRules = await disableBuiltinModels(models.map((m) => m.id));
  // 逐模型声明能力（视觉 / 推理档位），盖掉 ZCode 内置能力表里的错误结论。
  const capabilityRules = buildCapabilityRules(models);
  const modelRules = config.config.modelConfigRules.providerModelRules;
  // 先清掉我们上次留下的，再写这次要的：清单会随 ZCode 版本变，不能只增不减。
  // 注意禁用规则和能力声明都在这个数组里，靠 providerId 一起清。
  const kept = modelRules.filter((r) => r?.providerId !== PROVIDER_ID);
  config.config.modelConfigRules.providerModelRules = [...kept, ...disableRules, ...capabilityRules];

  // 老版本曾把能力声明写进 manualProviderModelRules；顺手清掉，别留下重复且不完整的一套。
  const manual = config.config.modelConfigRules.manualProviderModelRules;
  if (Array.isArray(manual)) {
    config.config.modelConfigRules.manualProviderModelRules = manual.filter(
      (r) => r?.providerId !== PROVIDER_ID,
    );
  }

  // 顺序表里也登记一下，让它在 ZCode 的供应商列表里可见
  const order = config.config.providerOrder;
  if (!order.includes(PROVIDER_ID)) order.push(PROVIDER_ID);

  const result = await writeConfig(config);
  return {
    added: models.length,
    disabledBuiltins: disableRules.length,
    capabilities: capabilityRules.length,
    changed: result.changed,
  };
}

/** 摘掉我们自己的那一条，别人的一条不动 */
export async function uninstall() {
  const config = await readConfig();
  const rules = config.config.providerConfigRules.providerRules;
  const before = rules.length;
  config.config.providerConfigRules.providerRules = rules.filter((r) => r?.providerId !== PROVIDER_ID);
  config.config.providerOrder = config.config.providerOrder.filter((id) => id !== PROVIDER_ID);
  // 连同我们写的禁用规则一起清干净，别给用户留下无主的配置。
  const modelRules = config.config.modelConfigRules.providerModelRules;
  config.config.modelConfigRules.providerModelRules = modelRules.filter((r) => r?.providerId !== PROVIDER_ID);
  // 能力声明也一并摘掉，否则会在 ZCode 里留下指向不存在供应商的孤儿规则
  const manualRules = config.config.modelConfigRules.manualProviderModelRules;
  if (Array.isArray(manualRules)) {
    config.config.modelConfigRules.manualProviderModelRules = manualRules.filter(
      (r) => r?.providerId !== PROVIDER_ID,
    );
  }
  const removed = before - config.config.providerConfigRules.providerRules.length;
  if (removed === 0) return { removed: 0, changed: false };
  const result = await writeConfig(config);
  return { removed, changed: result.changed };
}

/**
 * 列出配置目录里由我们产生的备份文件，供界面「回滚」用。
 * 只读，不改任何东西。
 */
export async function listBackups() {
  try {
    const entries = await readdir(configDir());
    return entries
      .filter((name) => name.startsWith('provider_config.json.oc-faucet-backup-'))
      .map((name) => join(configDir(), name))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** 用某个备份还原。（界面上是明确的破坏性动作，调用前要先跟用户确认。） */
export async function restoreBackup(backupPath) {
  const allowed = await listBackups();
  if (!allowed.includes(backupPath)) throw new BridgeError('这个备份文件不是本程序生成的，拒绝还原', 400, 'bad_backup');
  await copyFile(backupPath, configPath());
  return { restored: backupPath };
}
