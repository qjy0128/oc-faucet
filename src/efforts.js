/**
 * 推理强度档位。
 *
 * OpenCode 用 `variants` 描述一个模型支持哪些推理档位，形状是：
 *   { low: { reasoningEffort: 'low' }, high: { reasoningEffort: 'high' }, ... }
 * 而调用时要传的是**键名**（`variant: 'high'`），不是 `reasoningEffort` 的值。
 * 两者现在恰好一样，但按接口应当认 `reasoningEffort`，别依赖巧合。
 *
 * 为什么不把档位写死：不同模型给的档位不一样（有的 low/high/max，有的
 * none/minimal/low/medium/high/xhigh）。写死一份只会对着部分模型报错，
 * 或者更糟——接受了档位却悄悄按默认跑，用户以为自己选了"最高"。
 */

/** 认得的档位名，按强度从低到高 */
export const EFFORT_ORDER = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/**
 * 告诉 ZCode「选中某个档位时，往请求体里塞什么」。
 *
 * 这段表达式不是我们发明的，是从 ZCode 自己的内置供应商配置
 * （`/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json`）
 * 里抄来的原样写法：它走 anthropic-messages 协议时，就是这么把档位变成
 * `thinking` + `output_config.effort` 的。抄它的好处是两边语义完全对得上。
 */
export const ANTHROPIC_REASONING_MAP =
  'reasoningLevel == "disabled"\n' +
  '  ? {\n' +
  '      "thinking": {\n' +
  '        "type": "disabled"\n' +
  '      }\n' +
  '    }\n' +
  '  : {\n' +
  '      "thinking": {\n' +
  '        "type": "enabled"\n' +
  '      },\n' +
  '      "output_config": {\n' +
  '        "effort": reasoningLevel\n' +
  '      }\n' +
  '    }';

/**
 * 这个模型支持哪些档位 → 映射成 `{档位名: variant 键}`。
 *
 * 不支持推理、或者没有 variants 的模型一律返回空对象：
 * 空对象的意思是"别传 variant"，不是"不支持推理"。
 *
 * @param {object} model Model（要有 `reasoning` 和 `variants`）
 * @returns {Record<string,string>}
 */
export function variantsByEffort(model) {
  if (!model || typeof model !== 'object' || model.reasoning !== true) return {};
  const variants = model.variants;
  if (!variants || typeof variants !== 'object' || Array.isArray(variants)) return {};

  const out = {};
  for (const [variantName, options] of Object.entries(variants)) {
    if (!options || typeof options !== 'object') continue;
    if (options.disabled === true) continue;
    const effort = options.reasoningEffort;
    // 只认白名单里的档位名；OpenCode 以后加了新名字就当没看见
    if (typeof effort === 'string' && EFFORT_ORDER.includes(effort)) out[effort] = variantName;
  }
  return out;
}

/**
 * 把客户端要的档位翻成能传给 OpenCode 的 variant 键。
 *
 * @param {object} model
 * @param {string} effort 档位名（已经过校验）
 * @returns {string|null} 没有这个档位就 null
 */
export function variantForEffort(model, effort) {
  if (typeof effort !== 'string') return null;
  const efforts = variantsByEffort(model);
  return Object.hasOwn(efforts, effort) ? efforts[effort] : null;
}

/**
 * 从请求体里读出客户端要的推理档位。
 *
 * 两种协议字段不一样，都是照着真实客户端的写法来的：
 *   - Anthropic：`thinking: {type:'enabled'|'disabled'}` 加 `output_config: {effort}`
 *     （这是 ZCode 自己内置供应商配置里的映射写法，见 ANTHROPIC_REASONING_MAP）
 *   - OpenAI：`reasoning_effort: 'low'|'high'|…`
 *
 * @param {'anthropic'|'openai'} protocol
 * @param {object} body
 * @returns {string|null} 档位名；没要求就是 null
 */
export function requestedEffort(protocol, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;

  if (protocol === 'openai') {
    const effort = body.reasoning_effort;
    return typeof effort === 'string' && effort.trim() ? effort.trim() : null;
  }

  // OpenAI Responses：档位藏在 reasoning.effort 里（Codex 就是这么发的）
  if (protocol === 'responses') {
    const reasoning = body.reasoning;
    const effort = reasoning && typeof reasoning === 'object' && !Array.isArray(reasoning)
      ? reasoning.effort
      : undefined;
    return typeof effort === 'string' && effort.trim() ? effort.trim() : null;
  }

  const thinking = body.thinking;
  if (thinking && typeof thinking === 'object' && !Array.isArray(thinking)) {
    // 明确关掉思考：翻成 none，能不能真的关看模型有没有 none 档
    if (thinking.type === 'disabled') return 'none';
  }

  const outputConfig = body.output_config;
  if (outputConfig && typeof outputConfig === 'object' && !Array.isArray(outputConfig)) {
    const effort = outputConfig.effort;
    if (typeof effort === 'string' && effort.trim()) return effort.trim();
  }

  return null;
}

/**
 * 把请求里的档位翻成能传给 OpenCode 的 variant。
 *
 * 三种结果要分清楚：
 *   1. 没要求档位 → `{variant:null}`，走模型默认；
 *   2. 要求了且模型支持 → 给出 variant 键；
 *   3. 要求了但模型没有这个档位 → 抛错。**不能静默降级**：
 *      用户选了"最高"，我们却按默认跑，他永远不会发现。
 *      唯一的例外是"想关掉思考但模型关不掉"（没有 none 档），这时只能走默认，
 *      因为那本来就是模型的能力边界，不是我们把他的选择丢了。
 *
 * @param {object} model
 * @param {string|null} effort
 * @returns {{variant: string|null, effort: string|null, ignored: boolean}}
 */
export function resolveVariant(model, effort) {
  if (!effort) return { variant: null, effort: null, ignored: false };

  const normalized = effort === 'disabled' ? 'none' : effort;

  // 支持推理、但 OpenCode 一个 variant 都没给：客户端带什么档位都只能按默认跑。
  // 这不是我们丢了用户的选择，是模型压根没有档位可调。
  // 不这么处理会出事：ZCode 的内置规则会给这类模型也配一个 enabled 档并映射成
  // effort:"high"，照严格校验就会把正常请求当成"档位不支持"拒掉。
  if (Object.keys(variantsByEffort(model)).length === 0) {
    return { variant: null, effort: normalized, ignored: true };
  }

  const variant = variantForEffort(model, normalized);
  if (variant) return { variant, effort: normalized, ignored: false };

  if (normalized === 'none') {
    // 模型有档位、但没有"关闭"档：只能按模型默认来。这不是丢选择，是它做不到。
    return { variant: null, effort: normalized, ignored: true };
  }

  return { variant: null, effort: normalized, ignored: false, unsupported: true };
}

/**
 * 给客户端看的档位声明。
 *
 * 三种情况要分开说清楚，别让客户端猜：
 *   1. 不支持推理 → 明确说不支持；
 *   2. 支持推理但一个档位都映射不上 → 说支持，但档位列表为空（走模型默认）；
 *   3. 有档位 → 广告这些档位，并给出默认值。
 *
 * @param {object} model
 * @returns {{enabled:boolean, supportedEfforts:string[], defaultEffort:string|null, canDisableThinking:boolean, hasVariants:boolean}}
 */
export function describeReasoning(model) {
  const efforts = variantsByEffort(model);
  const supported = Object.keys(efforts).sort(
    (a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b),
  );
  const nameable = supported.filter((e) => e !== 'none');

  if (!model || model.reasoning !== true) {
    return {
      enabled: false,
      supportedEfforts: [],
      defaultEffort: null,
      canDisableThinking: false,
      hasVariants: false,
    };
  }

  return {
    enabled: true,
    supportedEfforts: supported,
    // 默认挑 medium（最像"正常"的那档），没有就挑第一个能用的
    defaultEffort: nameable.includes('medium') ? 'medium' : (nameable[0] ?? null),
    canDisableThinking: supported.includes('none'),
    hasVariants: supported.length > 0,
  };
}
