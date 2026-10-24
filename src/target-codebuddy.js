/**
 * CodeBuddy 接入目标：把体检通过的模型写进 CodeBuddy CLI 的自定义模型配置。
 *
 * CodeBuddy 是腾讯的 AI 编程 CLI（Claude Code 的 fork）。它的自定义模型配置在
 * ~/.codebuddy/models.json（可能尚不存在，不存在就新建），形状：
 *   { "models": [ {id, name, url, apiKey, ...} ], "availableModels": [...]? }
 * 只支持 OpenAI Chat Completions 协议，url 必须是完整的 /v1/chat/completions 路径，
 * apiKey 是明文。写好后用户用 `codebuddy --model <id>` 选用。
 *
 * 写入纪律（每一条都有讲究）：
 *   - 只增删带归属标记（ocFaucetOwner === 'oc-faucet-v1'）的条目，用户手写的一个字段都不动；
 *   - id 与用户手写条目冲突时让位：跳过该模型，在返回值里如实报告；
 *   - availableModels 白名单**已存在**时把我们的 id 追加进去（移除时同步摘除）；
 *     不存在则**不新建**——新建白名单会把用户其它模型从菜单里藏掉；
 *   - CLI 会解析条目值里的 ${VAR} 环境变量引用，所以写入的任何字符串值都不许含 $，
 *     install 里有一道断言兜底；
 *   - 写前备份（同一天只备一份）→ 临时文件原子替换 → 内容没变不写盘；
 *   - 文件权限 0600（里面有明文密钥）；只写用户级配置，不碰项目级。
 *
 * 路径注入：models.json 用环境变量 OCF_CODEBUDDY_MODELS 覆盖（调用时现读，测试指到
 * 临时目录）；detect() 的两个候选目录用 createCodebuddyTarget({ detectDirs }) 注入。
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { BridgeError } from './errors.js';
import { assertInstallArgs, writeTextIfChanged } from './target-helpers.js';

/** 归属标记：status / 合并 / 移除全靠它认出自家条目。改这个值等于换身份。 */
export const CODEBUDDY_OWNER = 'oc-faucet-v1';

/** models.json 的真实路径：环境变量优先（测试用），否则走用户级默认位置 */
function modelsFile(overrides) {
  return overrides.modelsFile ?? process.env.OCF_CODEBUDDY_MODELS ?? join(homedir(), '.codebuddy', 'models.json');
}

/** detect() 的两个候选目录：配置目录、CLI 安装目录 */
function detectDirs(overrides) {
  return (
    overrides.detectDirs ?? [join(homedir(), '.codebuddy'), join(homedir(), '.local', 'share', 'codebuddy')]
  );
}

/**
 * 读 models.json。文件不存在 → 空骨架（用户可能还没配过自定义模型）。
 * 文件存在但 JSON 损坏 → BridgeError：宁可报错也不许静默覆盖用户的东西。
 */
async function readModels(file) {
  if (!existsSync(file)) return { models: [] };
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    throw new BridgeError(
      `CodeBuddy 的模型配置文件（${file}）内容损坏，读不出来。我们没有动它。请打开这个文件检查格式（可以用 JSON 校验工具），修好后再点一次「一键接入」。`,
      400,
      'codebuddy_config_corrupt',
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BridgeError(
      `CodeBuddy 的模型配置文件（${file}）格式不对：顶层应该是一个 JSON 对象。我们没有动它，请检查后重试。`,
      400,
      'codebuddy_config_corrupt',
    );
  }
  // 文件可能只有 availableModels 等其它字段；models 缺了补上空数组，其余字段原样保留
  if (!Array.isArray(parsed.models)) return { ...parsed, models: [] };
  return parsed;
}

/** 写盘走共用骨架：内容没变不写 → 写前备份（同日一份）→ 临时文件原子替换，权限 0600 */
function writeModels(file, config) {
  return writeTextIfChanged(file, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * 拼一条 CodeBuddy 自定义模型条目。字段纪律：
 *   - maxInputTokens 只在 contextWindow 是正数时写；
 *   - 不写 maxOutputTokens、不写 relatedModels、不写任何推理字段；
 *   - supportsToolCall 恒 true（工具调用由本桥的信封协议翻译出来）；
 *   - supportsImages 跟随模型的 images。
 */
function buildEntry(model, { port, apiKey }) {
  const entry = {
    id: model.id,
    name: `OC · ${model.name ?? model.id}`,
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    apiKey,
  };
  if (Number.isFinite(model.contextWindow) && model.contextWindow > 0) {
    entry.maxInputTokens = model.contextWindow;
  }
  entry.supportsToolCall = true;
  entry.supportsImages = model.images === true;
  entry.ocFaucetOwner = CODEBUDDY_OWNER;
  return entry;
}

/**
 * $ 防护：CodeBuddy CLI 会把条目值里的 ${VAR} 当环境变量展开，
 * 写进去一个 $ 就可能被替换成莫名其妙的东西。所有字符串值逐条检查，
 * 有 $ 就在写盘前整体拒绝。
 */
function assertNoDollar(entries) {
  for (const entry of entries) {
    for (const [key, value] of Object.entries(entry)) {
      if (typeof value === 'string' && value.includes('$')) {
        throw new BridgeError(
          `模型「${entry.id}」的配置值（${key}）里含有 $ 字符。CodeBuddy 会把它当环境变量引用展开，写进去就用不了了，所以没有写入。请检查模型 id 或密钥里为什么出现了 $。`,
          500,
          'unsafe_value',
        );
      }
    }
  }
}

/**
 * @param {object} [overrides] 测试注入缝：{ modelsFile?: string, detectDirs?: string[] }
 */
export function createCodebuddyTarget(overrides = {}) {
  return {
    id: 'codebuddy',
    label: 'CodeBuddy',

    /** CodeBuddy 装没装：配置目录（~/.codebuddy）或 CLI 安装目录（~/.local/share/codebuddy）有一个在就算装过 */
    detect() {
      return detectDirs(overrides).some((dir) => existsSync(dir));
    },

    /** 我们写入的模型清单。每次调用都实读文件，只认带归属标记的条目，不用内存缓存糊弄。 */
    async status() {
      const config = await readModels(modelsFile(overrides));
      const models = config.models.filter((m) => m?.ocFaucetOwner === CODEBUDDY_OWNER).map((m) => m.id);
      return { written: models.length > 0, models };
    },

    /**
     * 把模型写进 models.json。
     * 先摘掉自己上次写的（同步语义：清单变了要跟着换），再追加这次的；
     * id 撞上用户手写条目时让位跳过，返回值里如实列出 skipped。
     * @returns {Promise<{added:number, skipped:string[], changed:boolean}>}
     */
    async install(models, { port, apiKey } = {}) {
      assertInstallArgs(models, { port, apiKey }, 'CodeBuddy');

      // 先建好全部条目并过 $ 防护：任何一条不合格就一个字段都不写
      const entries = models.map((m) => buildEntry(m, { port, apiKey }));
      assertNoDollar(entries);

      const file = modelsFile(overrides);
      const config = await readModels(file);

      // 记住我们上次写了哪些 id——白名单同步要靠它摘掉 stale id
      const prevOwnedIds = new Set(
        config.models.filter((m) => m?.ocFaucetOwner === CODEBUDDY_OWNER).map((m) => m.id),
      );
      // 用户手写条目占住的 id：让位
      const userIds = new Set(
        config.models.filter((m) => m?.ocFaucetOwner !== CODEBUDDY_OWNER).map((m) => m.id),
      );

      const kept = config.models.filter((m) => m?.ocFaucetOwner !== CODEBUDDY_OWNER);
      const accepted = [];
      const skipped = [];
      for (const entry of entries) {
        if (userIds.has(entry.id)) {
          skipped.push(entry.id);
          continue;
        }
        // 同一次安装里模型 id 重复也别堆两份
        if (!accepted.some((m) => m.id === entry.id)) accepted.push(entry);
      }
      config.models = [...kept, ...accepted];

      // 白名单已存在才同步：摘掉我们不再提供的旧 id，追加新 id；不存在则不新建
      if (Array.isArray(config.availableModels)) {
        const next = config.availableModels.filter((id) => !prevOwnedIds.has(id));
        for (const entry of accepted) {
          if (!next.includes(entry.id)) next.push(entry.id);
        }
        config.availableModels = next;
      }

      const result = await writeModels(file, config);
      return { added: accepted.length, skipped, changed: result.changed };
    },

    /**
     * 摘掉我们写入的全部条目（availableModels 同步摘除），用户手写的一个字段不动。
     * @returns {Promise<{removed:number, changed:boolean}>}
     */
    async uninstall() {
      const file = modelsFile(overrides);
      const config = await readModels(file);
      const ours = config.models.filter((m) => m?.ocFaucetOwner === CODEBUDDY_OWNER);
      if (ours.length === 0) return { removed: 0, changed: false };

      const ourIds = new Set(ours.map((m) => m.id));
      config.models = config.models.filter((m) => m?.ocFaucetOwner !== CODEBUDDY_OWNER);
      if (Array.isArray(config.availableModels)) {
        config.availableModels = config.availableModels.filter((id) => !ourIds.has(id));
      }

      const result = await writeModels(file, config);
      return { removed: ours.length, changed: result.changed };
    },
  };
}
