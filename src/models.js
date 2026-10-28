/**
 * 把 OpenCode `/config/providers` 的原始返回"翻译"成 OC Faucet 自己的模型清单。
 *
 * 设计原则：这里只做纯函数翻译，不发任何网络请求、不读磁盘。
 * OpenCode 的字段在不同版本、不同供应商之间经常缺斤少两，所以**一律容错**：
 * 字段缺失就按最保守的默认值处理，绝不因为某一个模型长得怪就把整批模型带崩。
 */
import { BridgeError } from './errors.js';

/**
 * 水龙头只接这一家水源：OpenCode 官方的免费池。
 *
 * 为什么只认这一家：`opencode` 名下的免费模型是 OpenCode 官方给的额度，谁都能用；
 * 而你在 OpenCode 里另外配的供应商（阿里云百炼、OpenAI、智谱……）都是要花你自己的钱
 * 或者吃你自己订阅额度的渠道，把它们放进水龙头等于替你做了花钱的决定。
 */
export const FAUCET_PROVIDER_ID = 'opencode';

/** 缺失或非法的价格数字统一按 0（免费）看待 */
const MISSING = Symbol('missing');

/**
 * 把价格字段读成数字。
 * - 缺失（undefined / null / 空串）→ 0
 * - 数字 → 原样
 * - 数字字符串（"0" / "0.3"）→ 转成数字
 * - 其他看不懂的东西 → MISSING（宁可当收费，也不要把收费模型谎报成免费）
 */
function readCost(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : MISSING;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : MISSING;
  }
  return MISSING;
}

/** 取对象，不是对象就给 undefined */
function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

/**
 * 价格四项（input / output / cache.read / cache.write）全为 0 或缺失才算免费。
 *
 * 注意 `cache` 是嵌套对象：OpenCode 把缓存读写的价格单独放在 `cost.cache` 里，
 * 只看 input/output 会把"缓存贵得离谱"的模型误判成免费。
 * 名字里带不带 "free" **完全不参与判定**——实测 `opencode` 供应商下有价格全 0
 * 但名字不带 free 的模型（例如 `big-pickle`），也有名字带 free 却收费的模型。
 *
 * @param {object} rawModel OpenCode 原始模型对象
 * @returns {boolean}
 */
export function isFreeModel(rawModel) {
  const cost = asObject(rawModel && rawModel.cost);
  if (!cost) return true; // 整个 cost 都缺失 → 四项都视为 0

  const cache = asObject(cost.cache) ?? {};
  const four = [
    readCost(cost.input),
    readCost(cost.output),
    readCost(cache.read),
    readCost(cache.write),
  ];

  // 任何一项看不懂（MISSING）都算收费，避免把未知价格说成免费
  if (four.some((v) => v === MISSING)) return false;
  return four.every((v) => v === 0);
}

/**
 * 合成各接入工具共用的统一 id。
 * @param {string} providerID
 * @param {string} modelID
 * @returns {string} `providerID/modelID`
 */
export function modelIdOf(providerID, modelID) {
  if (typeof providerID !== 'string' || typeof modelID !== 'string' || !providerID || !modelID) {
    throw new BridgeError(
      '拼模型 id 需要供应商名和模型名两个非空字符串，现在拿到的是 ' +
        `${JSON.stringify(providerID)} 和 ${JSON.stringify(modelID)}。`,
      400,
      'invalid_request',
    );
  }
  return `${providerID}/${modelID}`;
}

/**
 * 拆回两段。id 在**第一个**斜杠处切开，所以模型名里本身带斜杠也没问题。
 * 不合法（不是字符串、没有 `/`、斜杠在开头或结尾）返回 null。
 *
 * @param {string} id
 * @returns {{providerID: string, modelID: string} | null}
 */
export function parseModelId(id) {
  if (typeof id !== 'string') return null;
  const at = id.indexOf('/');
  if (at <= 0 || at === id.length - 1) return null;
  return { providerID: id.slice(0, at), modelID: id.slice(at + 1) };
}

/** 上下文窗口：优先 limit.context，其次 limit.output，都没有给 null */
function readContextWindow(raw) {
  const limit = asObject(raw.limit);
  if (!limit) return null;
  for (const key of ['context', 'output']) {
    const value = limit[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    if (typeof value === 'string' && Number.isFinite(Number(value)) && Number(value) > 0) {
      return Number(value);
    }
  }
  return null;
}

/** 保留可安全恢复的原始上限，覆盖上下文后不能再从新目录里猜回原值。 */
function readUpstreamLimits(raw) {
  const limit = asObject(raw.limit);
  if (!limit) return {};
  const result = {};
  for (const key of ['context', 'input', 'output']) {
    const value = limit[key];
    const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    const minimum = key === 'input' ? 0 : 1;
    if (Number.isSafeInteger(number) && number >= minimum) result[key] = number;
  }
  return result;
}

/** 某个"输入能力"容器里有没有某种模态 */
function hasModalityIn(container, modality) {
  if (Array.isArray(container)) return container.includes(modality);
  const obj = asObject(container);
  if (!obj) return false;
  if (obj[modality] === true) return true;
  if (Array.isArray(obj.input) && obj.input.includes(modality)) return true;
  if (asObject(obj.input) && obj.input[modality] === true) return true;
  return false;
}

/**
 * 能不能吃某种模态的输入（image / video / pdf …）。
 *
 * 为什么要按模态分开读：ZCode 的模型声明里 `inputFormat` 是分开的
 * （supportsImage / supportsVideo / supportsPdf），把"能看图"和"能读 PDF"
 * 混成一个布尔值，用户就会在不能看图的模型上试图贴图。
 *
 * @param {object} raw OpenCode 原始模型对象
 * @param {'image'|'video'|'pdf'} modality
 * @returns {boolean}
 */
export function readInputModality(raw, modality) {
  if (!raw || typeof raw !== 'object') return false;

  // 1) modalities 家族（可能是数组，也可能是 {input:[...]})
  if (hasModalityIn(raw.modalities, modality)) return true;
  const modalityObj = asObject(raw.modalities);
  if (modalityObj && hasModalityIn(modalityObj.input, modality)) return true;

  // 2) capabilities 家族（本机实测的真实形状：capabilities.input.image）
  const capabilities = asObject(raw.capabilities);
  if (capabilities) {
    const input = capabilities.input;
    // 显式给了 input[modality] 布尔值就以它为准，不再猜
    if (asObject(input) && typeof input[modality] === 'boolean') return input[modality];
    if (Array.isArray(input)) return input.includes(modality);
    if (capabilities[modality] === true) return true;
    // attachment 是 OpenCode 里"能带附件"的开关，只对图片成立
    if (modality === 'image' && capabilities.attachment === true) return true;
  }

  return false;
}

/** 能不能吃图片：modalities 和 capabilities 两种写法都认 */
function readImages(raw) {
  return readInputModality(raw, 'image');
}

/** 是不是推理模型 */
function readReasoning(raw) {
  if (raw.reasoning === true) return true;
  const capabilities = asObject(raw.capabilities);
  if (!capabilities) return false;
  if (capabilities.reasoning === true) return true;
  // reasoning 也可能是对象（{type:'enabled'} 这类写法）
  return asObject(capabilities.reasoning) !== undefined;
}

/** 是否已废弃 */
function readDeprecated(raw) {
  if (raw.deprecated === true) return true;
  return raw.status === 'deprecated';
}

/** 把一条原始模型记录翻成 Model */
function toModel(providerID, modelID, raw) {
  const variants = asObject(raw.variants);
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name : modelID;

  return {
    id: modelIdOf(providerID, modelID),
    providerID,
    modelID,
    name,
    free: isFreeModel(raw),
    reasoning: readReasoning(raw),
    variants: variants ?? {},
    images: readImages(raw),
    // ZCode 的模型声明把这几项分开写，所以这里也分开留着
    video: readInputModality(raw, 'video'),
    pdf: readInputModality(raw, 'pdf'),
    contextWindow: readContextWindow(raw),
    upstreamLimits: readUpstreamLimits(raw),
    deprecated: readDeprecated(raw),
  };
}

/**
 * 把 `/config/providers` 的原始返回摊平成 Model[]，按 id 排序去重。
 *
 * 输入长得不对（null、没有 providers、providers 不是数组……）一律返回 `[]`，
 * 不抛异常：上游服务偶尔吐半截 JSON 的情况不值得让整个桥挂掉。
 *
 * @param {object} providersPayload `{providers:[{id,name,models:{...}}]}`
 * @returns {Array<{id:string,providerID:string,modelID:string,name:string,free:boolean,
 *   reasoning:boolean,variants:object,images:boolean,contextWindow:number|null,upstreamLimits:object,deprecated:boolean}>}
 */
export function collectModels(providersPayload) {
  const payload = asObject(providersPayload);
  const providers = Array.isArray(payload?.providers) ? payload.providers : [];

  const byId = new Map();

  for (const provider of providers) {
    const providerObj = asObject(provider);
    if (!providerObj) continue;
    const providerID = typeof providerObj.id === 'string' ? providerObj.id.trim() : '';
    if (!providerID) continue;
    if (!providerObj.models || typeof providerObj.models !== 'object') continue;

    // models 一般是 {modelID: {...}}；也兼容偶尔出现的数组写法
    const entries = Array.isArray(providerObj.models)
      ? providerObj.models.map((item) => [asObject(item)?.id, item])
      : Object.entries(providerObj.models);

    for (const [key, item] of entries) {
      const raw = asObject(item);
      if (!raw) continue;
      const modelID =
        typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : String(key ?? '').trim();
      if (!modelID) continue;

      const model = toModel(providerID, modelID, raw);
      // 同一个 id 重复出现时以第一条为准（后到的忽略）
      if (!byId.has(model.id)) byId.set(model.id, model);
    }
  }

  // 用码点比较而不是 localeCompare，保证任何语言环境下顺序都一样
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * 从摊平后的清单里挑出「真正能从水龙头放出去」的模型：只要 `opencode` 这一家的、免费的、没过期的。
 *
 * 三道门槛缺一不可：
 *   1. 供应商必须是 opencode —— 别的家花的是用户自己的钱/额度（见 FAUCET_PROVIDER_ID）
 *   2. 价格四项全为 0 —— 名字带 free 不算数（见 isFreeModel）
 *   3. 没被标 deprecated —— 这类模型还在目录里，但已经路由不到
 *
 * @param {Array<object>} models `collectModels()` 的输出
 * @returns {Array<object>} 新数组，不改原数组
 */
export function faucetModels(models) {
  if (!Array.isArray(models)) return [];
  return models.filter((m) => m && m.providerID === FAUCET_PROVIDER_ID && m.free && !m.deprecated);
}

/**
 * 按来源把模型清单摊开：每个来源轮流取一个，取完为止。
 *
 * 注意：`faucetModels()` 只放 `opencode` 一家进来，所以**当前调用它是空操作**
 * （只有一个来源时直接返回副本）。保留它是因为下面的坑真的踩过：
 *
 * `collectModels` 是按 id 排的，而 id 带着来源前缀，所以同一个来源的模型天然挤成一堆。
 * 早先没收窄范围时，68 个候选里有 63 个来自不可用的来源，且坏来源恰好在字母序最前面；
 * 只取前 N 个去体检会全部撞死在同一来源上，得出"一个都不能用"的结论，用户会以为软件坏了。
 *
 * 哪天再放开到多家，这里能自动按来源轮流取，保证任何一段前缀都尽量覆盖多个来源。
 *
 * @param {Array<{providerID:string}>} models
 * @returns {Array} 摊开后的新数组（不改原数组）
 */
export function interleaveByProvider(models) {
  if (!Array.isArray(models) || models.length <= 1) return Array.isArray(models) ? [...models] : [];

  const buckets = new Map();
  for (const model of models) {
    const key = model?.providerID ?? '';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(model);
  }
  if (buckets.size <= 1) return [...models];

  const lists = [...buckets.values()];
  const out = [];
  for (let i = 0; out.length < models.length; i += 1) {
    for (const list of lists) {
      if (list[i] !== undefined) out.push(list[i]);
    }
  }
  return out;
}
