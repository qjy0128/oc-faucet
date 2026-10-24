/**
 * qoder 接入目标：把体检通过的模型写进 qoder CLI 的全局设置。
 *
 * qodercli 的全局设置在 ~/.qoder/settings.json（纯 JSON），顶层的 providers 节
 * 可以放自定义供应商。我们只增删 providers['oc-faucet'] 这一个键：用户手写的
 * 其它供应商、顶层 model（默认模型）、mcpServers、hooks 等，一个字段都不动。
 *
 * 同一款 CLI 有两个发行版，settings.json 的 schema 相同、各用各的目录
 * （照 Magpie internal/agent/qoder.go 的边界并列支持，两个目标互不影响）：
 *   国际版 qodercli    $QODER_CONFIG_DIR/settings.json    默认 ~/.qoder
 *   中国版 qoderclicn  $QODERCN_CONFIG_DIR/settings.json  默认 ~/.qoder-cn
 * 桌面图形界面的 BYOK 存在加密 sqlite 里，不碰。
 *
 * 检测的坑（借自 Magpie）：qoder 的 JetBrains 插件会往同一目录写一份只含
 * enabledPlugins 的 settings.json，那不代表装了 CLI——文件在但只含
 * enabledPlugins 时 detect() 不算装过。
 *
 * 写入纪律与 zcode-config 一致：读 → 改 → 写前备份（同日一份）→ 临时文件原子替换，
 * 内容没变不写盘。文件权限 0600——里面有密钥明文。
 *
 * 路径注入：OCF_QODER_SETTINGS / OCF_QODERCN_SETTINGS 可覆盖 settings.json 路径
 * （测试用），调用时现读；createQoderTarget({ settingsPath }) /
 * createQoderCnTarget({ settingsPath }) 是另一条缝（测试/接线用）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { BridgeError } from './errors.js';
import { describeReasoning } from './efforts.js';
import { assertInstallArgs, writeTextIfChanged } from './target-helpers.js';

/** 我们在 providers 里占的那个键。改这个值等于换身份，原有配置会被当成别人的。 */
export const PROVIDER_KEY = 'oc-faucet';

/** 显示给用户看的供应商名字 */
export const DISPLAY_NAME = 'OC Faucet';

/** 两个发行版的全部差异：目标 id/label、官方目录变量、默认目录名、测试用路径变量。 */
const BUILDS = {
  qoder: { id: 'qoder', label: 'qoder', envDir: 'QODER_CONFIG_DIR', envFile: 'OCF_QODER_SETTINGS', dir: '.qoder' },
  'qoder-cn': { id: 'qoder-cn', label: 'qoder CN', envDir: 'QODERCN_CONFIG_DIR', envFile: 'OCF_QODERCN_SETTINGS', dir: '.qoder-cn' },
};

function expandHome(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

/** settings.json 的路径：测试变量 > 发行版官方目录变量 > 默认目录；调用时现读 */
function settingsPathFor(build) {
  if (process.env[build.envFile]) return process.env[build.envFile];
  const dir = process.env[build.envDir];
  if (typeof dir === 'string' && dir.trim()) return join(expandHome(dir.trim()), 'settings.json');
  return join(homedir(), build.dir, 'settings.json');
}

/** 国际版的默认路径 */
export function settingsPath() {
  return settingsPathFor(BUILDS.qoder);
}

/** 是不是一个普通 JSON 对象（不是 null、不是数组） */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** JetBrains 插件留下的 settings.json 只含 enabledPlugins；那不是 CLI 在用的迹象。 */
function pluginOnlySettings(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false; // 读不成 JSON 时不能断定是插件的文件
  }
  if (!isPlainObject(parsed)) return false;
  const keys = Object.keys(parsed);
  return keys.length > 0 && keys.every((key) => key === 'enabledPlugins');
}

/**
 * 读设置文件。文件不存在 → 空对象（用户还没动过 qoder 的自定义设置，正常）。
 * 文件损坏（不是合法 JSON、或顶层不是对象）→ 报人话并停手：
 * 硬写会把里面已有的配置全弄丢，宁可让用户自己修好再来。
 */
async function readSettings(file, label) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BridgeError(
      `${label} 的设置文件（${file}）损坏了：内容不是合法的 JSON。为了不弄丢里面已有的配置，这次没有动它。请用文本编辑器打开这个文件，修正 JSON 语法（或者删掉它让 qoder 重建），然后再试一次。`,
      400,
      'qoder_settings_broken',
    );
  }
  if (!isPlainObject(parsed)) {
    throw new BridgeError(
      `${label} 的设置文件（${file}）损坏了：顶层应该是一个 JSON 对象，实际不是。我们没有动它；请打开修正后再试一次。`,
      400,
      'qoder_settings_broken',
    );
  }
  return parsed;
}

/**
 * 拼出 providers['oc-faucet'] 这一节。schema 是对着 qodercli 的真实读法查证过的：
 *   - protocol 已是 anthropic，type 省略（缺省 openai-compatible 即可）
 *   - 不写 maxOutputTokens：上游这份数据不可靠，宁可缺省也不瞎写
 *   - model 是用户在这个供应商下选的默认模型：现有值还在新清单里就保留用户的
 *     选择，否则（没选过 / 选的已不在清单）回退到清单第一个；清单为空就没有这个字段
 */
function buildProviderSection({ port, apiKey, models, currentModel = null }) {
  const section = {
    protocol: 'anthropic',
    authType: 'api-key',
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey,
    displayName: DISPLAY_NAME,
  };
  if (models.length > 0) {
    section.model =
      typeof currentModel === 'string' && models.some((m) => m.id === currentModel)
        ? currentModel
        : models[0].id;
  }
  section.models = models.map((m) => buildModelEntry(m));
  return section;
}

/**
 * 拼 models 数组里的一条模型声明。
 *   - contextWindow：仅当模型带了正数值才写，不知道就不写
 *   - capabilities.vision   = 模型能看图（images）
 *   - capabilities.tools 恒 true：写入清单本就是体检通过、能用工具的模型
 *   - capabilities.thinking = qoder 的 CustomProviderThinkingCapability 对象（实测 schema：
 *     布尔会被拒收）。有真实档位：modes 含 enabled（含 none 档再加 disabled），
 *     supportedEffortLevels 只报 qoder 词表内的档（low/medium/high/xhigh/max，
 *     minimal 不在其中，丢弃）；没档位的推理模型与非推理模型：整个 thinking 键不写
 *     （空对象会触发它的跨字段校验报错）。
 */
function buildModelEntry(m) {
  const effort = describeReasoning(m);
  const entry = { model: m.id, displayName: `OC · ${m.name || m.id}` };
  if (Number.isFinite(m.contextWindow) && m.contextWindow > 0) {
    entry.contextWindow = m.contextWindow;
  }
  // qoder 词表没有 minimal；none 是「关思考」，不进 supportedEffortLevels
  const QODER_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
  const levels = (effort.supportedEfforts ?? []).filter((e) => QODER_EFFORTS.includes(e));
  entry.capabilities = { tools: true, vision: m.images === true };
  if (levels.length > 0) {
    // 空 modes 的对象会被 qoder 拒收（requiresBudgetForEnabled 依赖 modes 含 enabled），没档位就整键不写
    entry.capabilities.thinking = {
      modes: effort.canDisableThinking ? ['enabled', 'disabled'] : ['enabled'],
      requiresBudgetForEnabled: false,
      supportedEffortLevels: levels,
      requiredBetasForEffort: [],
    };
  }
  return entry;
}

/** 写盘走共用骨架：备份（同日一份）→ 临时文件原子替换（0600），内容没变不写。 */
function writeSettings(file, data) {
  return writeTextIfChanged(file, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * 拼一个 qoder 发行版的接入目标，形状同 docs/接口约定.md §14。
 *
 * @param {object} build BUILDS 里的一行（发行版身份与路径依据）
 * @param {object} [overrides] 留给测试/接线的缝：settingsPath 只接受路径字符串；
 *   不传就走 测试变量 → 官方目录变量 → 默认目录。
 */
function createQoderSiteTarget(build, overrides = {}) {
  const resolvePath =
    typeof overrides.settingsPath === 'string' ? () => overrides.settingsPath : () => settingsPathFor(build);

  return {
    id: build.id,
    label: build.label,

    /** 装没装：配置目录在，且已有的 settings.json 不是 JetBrains 插件留下的纯 enabledPlugins 文件 */
    detect() {
      const file = resolvePath();
      if (!existsSync(dirname(file))) return false;
      if (!existsSync(file)) return true;
      try {
        return !pluginOnlySettings(readFileSync(file, 'utf8'));
      } catch {
        return true; // 读不出来时不能断定是插件的文件
      }
    },

    /** 我们写入的模型清单。每次调用都实读设置文件，不用内存缓存糊弄。 */
    async status() {
      const file = resolvePath();
      if (!existsSync(file)) return { written: false, models: [] };
      const data = await readSettings(file, build.label);
      const providers = isPlainObject(data.providers) ? data.providers : {};
      const section = providers[PROVIDER_KEY];
      if (!isPlainObject(section)) return { written: false, models: [] };
      const list = Array.isArray(section.models) ? section.models : [];
      const models = list
        .map((entry) => (isPlainObject(entry) && typeof entry.model === 'string' ? entry.model : null))
        .filter((id) => id !== null);
      return { written: true, models };
    },

    /** 把体检通过的模型写进 providers['oc-faucet']，其它内容一个字段不动 */
    async install(models, { port, apiKey } = {}) {
      assertInstallArgs(models, { port, apiKey }, build.label);

      const file = resolvePath();
      const data = await readSettings(file, build.label);
      if (data.providers !== undefined && !isPlainObject(data.providers)) {
        throw new BridgeError(
          `${build.label} 的设置文件（${file}）里 providers 字段格式不对：应该是一个 JSON 对象。我们没有动它；请打开修正后再试一次。`,
          400,
          'qoder_settings_broken',
        );
      }
      const providers = isPlainObject(data.providers) ? data.providers : {};
      // 节里现有的默认模型选择带进去：还在新清单里就保留用户的，别每次重写都冲掉
      const existing = providers[PROVIDER_KEY];
      const currentModel = isPlainObject(existing) && typeof existing.model === 'string' ? existing.model : null;
      providers[PROVIDER_KEY] = buildProviderSection({ port, apiKey, models, currentModel });
      data.providers = providers;

      const result = await writeSettings(file, data);
      return { added: models.length, changed: result.changed };
    },

    /** 只摘掉 providers['oc-faucet']；providers 空了就把 providers 键本身也摘掉 */
    async uninstall() {
      const file = resolvePath();
      if (!existsSync(file)) return { removed: 0, changed: false };
      const data = await readSettings(file, build.label);
      const providers = isPlainObject(data.providers) ? data.providers : null;
      if (!providers || !Object.hasOwn(providers, PROVIDER_KEY)) {
        return { removed: 0, changed: false };
      }
      delete providers[PROVIDER_KEY];
      if (Object.keys(providers).length === 0) delete data.providers;
      const result = await writeSettings(file, data);
      return { removed: 1, changed: result.changed };
    },
  };
}

/** 国际版（qodercli） */
export function createQoderTarget(overrides = {}) {
  return createQoderSiteTarget(BUILDS.qoder, overrides);
}

/** 中国版（qoderclicn） */
export function createQoderCnTarget(overrides = {}) {
  return createQoderSiteTarget(BUILDS['qoder-cn'], overrides);
}
