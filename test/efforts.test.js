/**
 * 推理档位映射的测试。
 *
 * 要挡住的错误：客户端明确要求"最高"，我们却按默认跑，用户以为自己选了最高。
 * 所以要么正确映射到 OpenCode 的 variant，要么明确报错，绝不能静默降级。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EFFORT_ORDER,
  describeReasoning,
  variantsByEffort,
  requestedEffort,
  resolveVariant,
  variantForEffort,
} from '../src/efforts.js';

/** 本机实测的真实形状：glm-5.3-flash-free 给 low/high/max */
const GLM = {
  id: 'opencode/glm-5.3-flash-free',
  reasoning: true,
  variants: {
    low: { reasoningEffort: 'low' },
    high: { reasoningEffort: 'high' },
    max: { reasoningEffort: 'max' },
  },
};

/** 本机实测：nemotron 给六档，含 none */
const NEMOTRON = {
  id: 'opencode/nemotron-3.5-super-vl-free',
  reasoning: true,
  variants: {
    none: { reasoningEffort: 'none' },
    minimal: { reasoningEffort: 'minimal' },
    low: { reasoningEffort: 'low' },
    medium: { reasoningEffort: 'medium' },
    high: { reasoningEffort: 'high' },
    xhigh: { reasoningEffort: 'xhigh' },
  },
};

/** 本机实测：big-pickle 支持推理但 variants 是空的 */
const BIG_PICKLE = { id: 'opencode/big-pickle', reasoning: true, variants: {} };

/** 不支持推理的模型 */
const NO_REASONING = { id: 'opencode/x', reasoning: false, variants: {} };

test('variantsByEffort：档位名映射到 variant 键', () => {
  assert.deepEqual(variantsByEffort(GLM), { low: 'low', high: 'high', max: 'max' });
});

test('variantsByEffort：variant 键和 reasoningEffort 不一样时，认 reasoningEffort', () => {
  // 现在两者恰好同名，但接口上它们不是一回事。造一个不同名的，确认按 reasoningEffort 走。
  const model = {
    reasoning: true,
    variants: { turbo: { reasoningEffort: 'high' } },
  };
  assert.deepEqual(variantsByEffort(model), { high: 'turbo' });
});

test('variantsByEffort：不支持推理 / variants 为空 → 空对象', () => {
  assert.deepEqual(variantsByEffort(NO_REASONING), {});
  assert.deepEqual(variantsByEffort(BIG_PICKLE), {});
  for (const bad of [null, undefined, 'nope', 42, {}]) {
    assert.deepEqual(variantsByEffort(bad), {}, `${JSON.stringify(bad)} 应为空对象`);
  }
});

test('variantsByEffort：跳过 disabled 的档位', () => {
  const model = {
    reasoning: true,
    variants: { high: { reasoningEffort: 'high' }, low: { reasoningEffort: 'low', disabled: true } },
  };
  assert.deepEqual(variantsByEffort(model), { high: 'high' });
});

test('variantsByEffort：不认的档位名当没看见，不硬塞', () => {
  const model = { reasoning: true, variants: { weird: { reasoningEffort: '超级高' } } };
  assert.deepEqual(variantsByEffort(model), {});
});

test('variantForEffort：只给模型真有的档位', () => {
  assert.equal(variantForEffort(GLM, 'max'), 'max');
  assert.equal(variantForEffort(GLM, 'medium'), null, 'glm 没有 medium，必须给 null 而不是凑一个');
  assert.equal(variantForEffort(NEMOTRON, 'none'), 'none');
  assert.equal(variantForEffort(BIG_PICKLE, 'high'), null, '没有 variants 就没有可传的键');
  assert.equal(variantForEffort(GLM, undefined), null);
  assert.equal(variantForEffort(GLM, ''), null);
});

test('describeReasoning：有档位时广告这些档位，默认挑 medium', () => {
  const d = describeReasoning(NEMOTRON);
  assert.equal(d.enabled, true);
  // 按强度从低到高排，且只列模型真有的
  assert.deepEqual(d.supportedEfforts, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
  assert.equal(d.defaultEffort, 'medium');
  assert.equal(d.canDisableThinking, true);
  assert.equal(d.hasVariants, true);
});

test('describeReasoning：没有 medium 时退到第一个可用档位', () => {
  const d = describeReasoning(GLM);
  assert.deepEqual(d.supportedEfforts, ['low', 'high', 'max']);
  assert.equal(d.defaultEffort, 'low');
  assert.equal(d.canDisableThinking, false, 'glm 没有 none，关不掉思考');
});

test('describeReasoning：支持推理但没档位 → 说支持、档位为空', () => {
  const d = describeReasoning(BIG_PICKLE);
  assert.equal(d.enabled, true);
  assert.deepEqual(d.supportedEfforts, []);
  assert.equal(d.defaultEffort, null);
  assert.equal(d.hasVariants, false);
});

test('describeReasoning：不支持推理 → 明确说不支持', () => {
  const d = describeReasoning(NO_REASONING);
  assert.deepEqual(d, {
    enabled: false,
    supportedEfforts: [],
    defaultEffort: null,
    canDisableThinking: false,
    hasVariants: false,
  });
});

/* ------------------------------------------------------------------ */
/* 从真实请求体里读档位                                                  */
/* ------------------------------------------------------------------ */

test('requestedEffort：Anthropic 的 thinking + output_config.effort', () => {
  // 这是 ZCode 选了"最高"之后的真实形状（见内置配置里的 map 表达式）
  assert.equal(
    requestedEffort('anthropic', { thinking: { type: 'enabled' }, output_config: { effort: 'max' } }),
    'max',
  );
  assert.equal(requestedEffort('anthropic', { output_config: { effort: 'high' } }), 'high');
  // 明确关掉思考
  assert.equal(requestedEffort('anthropic', { thinking: { type: 'disabled' } }), 'none');
  // 开着思考但没指定档位 → 走默认
  assert.equal(requestedEffort('anthropic', { thinking: { type: 'enabled' } }), null);
  assert.equal(requestedEffort('anthropic', {}), null);
});

test('requestedEffort：OpenAI 的 reasoning_effort', () => {
  assert.equal(requestedEffort('openai', { reasoning_effort: 'high' }), 'high');
  assert.equal(requestedEffort('openai', { reasoning_effort: '' }), null);
  assert.equal(requestedEffort('openai', {}), null);
});

test('requestedEffort：乱七八糟的输入不抛，当作没要求', () => {
  for (const bad of [null, undefined, 'nope', 42, [], { thinking: 'x' }, { output_config: [] }]) {
    assert.equal(requestedEffort('anthropic', bad), null, `${JSON.stringify(bad)} 应为 null`);
    assert.equal(requestedEffort('openai', bad), null);
  }
});

/* ------------------------------------------------------------------ */
/* 档位 → variant 的解析，重点是「不许静默降级」                          */
/* ------------------------------------------------------------------ */

test('resolveVariant：没要求档位就不传 variant', () => {
  assert.deepEqual(resolveVariant(GLM, null), { variant: null, effort: null, ignored: false });
});

test('resolveVariant：模型有的档位正常映射', () => {
  assert.deepEqual(resolveVariant(GLM, 'max'), { variant: 'max', effort: 'max', ignored: false });
  assert.deepEqual(resolveVariant(NEMOTRON, 'xhigh'), { variant: 'xhigh', effort: 'xhigh', ignored: false });
});

test('resolveVariant：要了模型没有的档位 → 标记 unsupported（调用方必须报错）', () => {
  // glm 只有 low/high/max，没有 medium
  const r = resolveVariant(GLM, 'medium');
  assert.equal(r.unsupported, true, '不能悄悄按默认跑');
  assert.equal(r.variant, null);
});

test('resolveVariant：想关思考但模型关不掉 → 走默认，不算错', () => {
  // glm 没有 none 档，这是它的能力边界，不是我们丢了用户的选择
  const r = resolveVariant(GLM, 'none');
  assert.equal(r.ignored, true);
  assert.equal(r.variant, null);
  assert.ok(!r.unsupported);
});

test('resolveVariant：disabled 等价于 none，并映射到 none 档', () => {
  const r = resolveVariant(NEMOTRON, 'disabled');
  assert.equal(r.variant, 'none');
  assert.equal(r.effort, 'none');
});
