/**
 * DSH（DeepSeek Harness）接入目标。
 *
 * DSH 是 DeepSeek 官方的桌面 AI 编程应用（Electron）。它的自定义供应商配置在
 *   ~/.dsh/profiles/desktop/cordis.patch.yml
 * 这个文件顶层是一个 YAML 数组，元素形如 `- id: <插件id> / name: <npm包名> / config: {...}`，
 * 用户自定义供应商挂在 `id: llm-pi-ai`（包名 '@deepseek-ai/dsh-llm-pi-ai'）的
 * `config.providers` 字典下。
 *
 * 难点在于：DSH 运行时自己也会改写这个文件，而且配置热生效。所以这里**不做通用 YAML
 * 解析**（项目零依赖），改用「受管块」策略：我们写的整块内容用一对标记注释包起来——
 *   # >>> oc-faucet >>>
 *   ...（完整的一个 llm-pi-ai 数组元素，内含 providers.oc-faucet）...
 *   # <<< oc-faucet <<<
 * install：块已存在就整块替换，不存在就追加到文件尾；
 * uninstall：整块删除；
 * 除此之外的内容逐字节保留——DSH 自己写的、用户手写的（哪怕也是 llm-pi-ai 节）都不动，
 * 不合并、不搬迁。
 *
 * 写入纪律与 zcode-config 一致：写前备份（同一天只备一份）、临时文件 + rename 原子替换、
 * 内容没变不写盘、文件权限 0600。另外因为 DSH 可能和我们同时改这个文件，写之前会重读
 * 一遍：发现外部动过，就在对方的最新内容上重新套块，绝不回滚对方的改动。
 *
 * 路径注入：环境变量 OCF_DSH_PATCH 可覆盖补丁文件路径（测试用），调用时现读。
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { BridgeError } from './errors.js';
import { describeReasoning } from './efforts.js';
import { assertInstallArgs, writeTextIfChanged } from './target-helpers.js';

/** 受管块的标记注释。改这两个值等于换身份，旧块会被当成别人的。 */
const BLOCK_BEGIN = '# >>> oc-faucet >>>';
const BLOCK_END = '# <<< oc-faucet <<<';

/** 自定义供应商要挂的插件节 id 与包名（DSH 的约定，逐字照抄） */
const PLUGIN_ID = 'llm-pi-ai';
const PLUGIN_NAME = '@deepseek-ai/dsh-llm-pi-ai';

/** 我们在 providers 字典下的键名 */
const PROVIDER_KEY = 'oc-faucet';

/** DSH 补丁文件的默认路径 */
function defaultPatchPath() {
  return join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
}

/**
 * 写进 YAML 的字符串标量一律走「双引号 + JSON 转义」。
 * 密钥和模型名是用户可控的：冒出冒号、井号、首尾空格、引号，裸写就把 YAML 结构写坏了
 * （「: 」是键值分隔、「 #」之后全算注释）。YAML 的双引号字符串兼容 JSON 转义，
 * 所以直接 JSON.stringify 就是最稳的写法，常量也统一走它，免得哪天常量变了就漏。
 */
function yamlQuote(value) {
  return JSON.stringify(String(value));
}

/**
 * 拼出受管块的完整文本（不含结尾换行，由拼接方负责）。
 *
 * 形状是验证过的：路由级开 compat.forceAdaptiveThinking 后，DSH 发出的推理档位
 * 就是转发口已认的 output_config.effort 原值，所以我方协议零改动。
 * reasoningEfforts 逐模型按 describeReasoning 的真实结果生成：
 *   - 键 = 档位名（off 表示关闭思考），值 = 原样发出的字符串；
 *   - 值必须落在 none/minimal/low/medium/high/xhigh/max 白名单内（转发口对不认识的
 *     档位会 400，不静默降级），describeReasoning 本身已经按白名单过滤过；
 *   - 非推理模型不写；只有 none 档（能关思考但没档位可调）的模型也不写——
 *     只写 off 一个键的表在 llm-pi-ai 的 schema 里是非法的。
 */
function buildBlock(models, { port, apiKey }) {
  const lines = [
    BLOCK_BEGIN,
    `- id: ${yamlQuote(PLUGIN_ID)}`,
    `  name: ${yamlQuote(PLUGIN_NAME)}`,
    '  config:',
    '    providers:',
    `      ${PROVIDER_KEY}:`,
    `        displayName: ${yamlQuote('OC Faucet')}`,
    '        api: anthropic-messages',
    `        baseURL: ${yamlQuote(`http://127.0.0.1:${port}`)}`,
    '        headers:',
    `          x-api-key: ${yamlQuote(apiKey)}`,
    '        compat:',
    '          forceAdaptiveThinking: true',
  ];
  if (models.length === 0) {
    // 空清单也要写成合法 YAML：留一个悬空的 `models:` 会被解析成 null
    lines.push('        models: []');
  } else {
    lines.push('        models:');
    for (const m of models) {
      lines.push(`          - id: ${yamlQuote(m.id)}`);
      lines.push(`            name: ${yamlQuote(`OC · ${m.name ?? m.id}`)}`);
      if (Number.isFinite(m?.contextWindow) && m.contextWindow > 0) {
        lines.push(`            contextWindow: ${m.contextWindow}`);
      }
      lines.push(`            input: [text${m?.images === true ? ', image' : ''}]`);
      const effort = describeReasoning(m);
      // llm-pi-ai 的 schema 只允许 off 键的值为 null，且整张表「只有 off 一个键」非法
      // （offers no level beyond "off"）。所以只有 none 档的模型（能关思考但没档位可调）
      // 整个 reasoningEfforts 节都不写，而不是写一张只有 off 的表。
      const levels = effort.supportedEfforts.filter((e) => e !== 'none');
      if (levels.length > 0) {
        lines.push('            reasoningEfforts:');
        // 有 none 档 = 能关思考：off 的值留空，DSH 会发 thinking:{type:disabled}
        if (effort.canDisableThinking) lines.push('              off:');
        for (const e of levels) {
          lines.push(`              ${e}: ${e}`);
        }
      }
    }
  }
  lines.push(BLOCK_END);
  return lines.join('\n');
}

/**
 * 在按行拆开的文件内容里找受管块。
 * strict=true 时「只有开头标记、找不到结尾标记」视为损坏并抛错——宁可报错也不瞎改；
 * status 用非 strict，把损坏块当成没写入，不在读取路径上炸。
 */
function locateBlock(lines, { strict = false } = {}) {
  const start = lines.findIndex((l) => l.trim() === BLOCK_BEGIN);
  if (start === -1) return null;
  const end = lines.findIndex((l, i) => i > start && l.trim() === BLOCK_END);
  if (end === -1) {
    if (strict) {
      throw new BridgeError(
        'DSH 补丁文件里的 oc-faucet 标记块损坏了：只有开头标记、找不到结尾标记。请打开 cordis.patch.yml 检查这两行标记后重试。',
        500,
        'dsh_block_corrupt',
      );
    }
    return null;
  }
  return { start, end };
}

/** install 的拼接：有块整块替换，没块追加到文件尾；块外内容逐字节保留 */
function spliceInstall(content, block) {
  const lines = content === '' ? [] : content.split('\n');
  const found = locateBlock(lines, { strict: true });
  const blockLines = block.split('\n');
  if (found) {
    lines.splice(found.start, found.end - found.start + 1, ...blockLines);
    return lines.join('\n');
  }
  // 追加到文件尾：先摘掉「结尾换行」split 出来的空尾巴，再由 join 统一补换行。
  // 这样无论前文末尾有没有换行，块都紧跟前文，整个文件以单个换行收尾，
  // uninstall 摘掉块之后才能逐字节回到安装前的原文。
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  lines.push(...blockLines, '');
  return lines.join('\n');
}

/** uninstall 的拼接：整块删除（含标记行），其余逐字节保留 */
function spliceUninstall(content) {
  const lines = content.split('\n');
  const found = locateBlock(lines, { strict: true });
  if (!found) return { text: content, removed: false };
  lines.splice(found.start, found.end - found.start + 1);
  return { text: lines.join('\n'), removed: true };
}

/**
 * 从受管块里提取模型 id：认 `- id: ` 行，跳过插件节自己的 llm-pi-ai。
 * 新写入的块 id 是双引号标量（见 yamlQuote），要解开转义；
 * 旧版本写下的裸标量块也照认，免得升级后状态显示「未写入」。
 */
function extractModelIds(blockLines) {
  const ids = [];
  for (const line of blockLines) {
    const m = /^\s*- id:\s*(?:"((?:[^"\\]|\\.)*)"|(\S+))\s*$/.exec(line);
    if (!m) continue;
    let id = m[2];
    if (m[1] !== undefined) {
      try {
        id = JSON.parse(`"${m[1]}"`);
      } catch {
        continue; // 引号串坏到解不开，跳过这行，别让状态读取炸掉
      }
    }
    if (id && id !== PLUGIN_ID) ids.push(id);
  }
  return ids;
}

/** 读当前文件内容。文件不存在或读不了都返回 null，不抛异常。 */
async function readCurrent(file) {
  if (!existsSync(file)) return null;
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** 写盘走共用骨架：备份（同日一份）→ 临时文件原子替换（0600），内容没变不写。 */
const writePatch = (file, payload) => writeTextIfChanged(file, payload);

async function readStatus(file) {
  const content = await readCurrent(file);
  if (content === null) return { written: false, models: [] };
  const lines = content.split('\n');
  const found = locateBlock(lines);
  if (!found) return { written: false, models: [] };
  return { written: true, models: extractModelIds(lines.slice(found.start, found.end + 1)) };
}

async function installInto(file, models, { port, apiKey }) {
  assertInstallArgs(models, { port, apiKey }, 'DSH');

  const block = buildBlock(models, { port, apiKey });
  // 读 → 套块 → 写前重读再套一次：DSH 可能正在跑、随时改写这个文件，
  // 发现外部动过就在对方的最新内容上重新套块，绝不回滚它的改动。
  let base = (await readCurrent(file)) ?? '';
  let next = spliceInstall(base, block);
  const fresh = await readCurrent(file);
  if ((fresh ?? '') !== base) {
    base = fresh ?? '';
    next = spliceInstall(base, block);
  }
  if (next === base) return { added: models.length, changed: false };
  const result = await writePatch(file, next);
  return { added: models.length, changed: result.changed };
}

async function uninstallFrom(file) {
  let base = await readCurrent(file);
  if (base === null) return { removed: 0, changed: false };
  let out = spliceUninstall(base);
  // 同 install：写前重读，外部动过就按最新内容重新摘块
  const fresh = await readCurrent(file);
  if (fresh === null) return { removed: 0, changed: false };
  if (fresh !== base) {
    base = fresh;
    out = spliceUninstall(base);
  }
  if (!out.removed) return { removed: 0, changed: false };
  const result = await writePatch(file, out.text);
  return { removed: 1, changed: result.changed };
}

/**
 * 构造 DSH 接入目标。Target 形状见 docs/接口约定.md §14。
 * @param {object} [overrides] 测试接缝；overrides.patchFile 直接指定补丁文件路径，
 *                             优先级高于 OCF_DSH_PATCH 环境变量
 */
export function createDshTarget(overrides = {}) {
  // 路径调用时现读：先 overrides.patchFile，再环境变量，最后真实默认路径
  const file = () => overrides.patchFile ?? process.env.OCF_DSH_PATCH ?? defaultPatchPath();
  return {
    id: 'dsh',
    label: 'DSH',

    /** DSH 装没装：配置目录存在就算装过（补丁文件可能还没生成） */
    detect() {
      return existsSync(dirname(file()));
    },

    /** 我们写入的模型清单。每次实读补丁文件，只认标记块里的 `- id: ` 行。 */
    status() {
      return readStatus(file());
    },

    /** 把模型写进 DSH，返回 { added, changed } */
    install(models, { port, apiKey } = {}) {
      return installInto(file(), models, { port, apiKey });
    },

    /** 摘除我们的标记块，返回 { removed, changed } */
    uninstall() {
      return uninstallFrom(file());
    },
  };
}
