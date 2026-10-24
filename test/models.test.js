/**
 * models.js 的测试。
 *
 * 夹具全部来自本机真实 OpenCode（1.19.3）的 `GET /config/providers` 返回，
 * 只裁掉了用不着的字段，形状保持原样——用编造的夹具测不出真实世界的坑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { collectModels, faucetModels, interleaveByProvider, isFreeModel, modelIdOf, parseModelId } from '../src/models.js';
import { BridgeError } from '../src/errors.js';

/* ------------------------------------------------------------------ */
/* 真实夹具：从本机 `curl -s http://127.0.0.1:45999/config/providers` 抄来 */
/* ------------------------------------------------------------------ */

/** 价格四项全 0 的真实免费模型（名字里也带 free） */
const REAL_DEEPSEEK_FLASH_FREE = {
  id: 'deepseek-v4.1-flash-free',
  providerID: 'opencode',
  api: { id: 'deepseek-v4.1-flash-free', url: 'https://opencode.ai/inference/openai/v1' },
  name: 'DeepSeek V4.1 Flash Free',
  family: 'deepseek-flash',
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: { field: 'reasoning_content' },
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 200000, output: 32000 },
  status: 'active',
  variants: { low: { reasoningEffort: 'low' }, high: { reasoningEffort: 'high' } },
};

/** 价格全 0 但名字**不带** free 的真实模型——只看名字的实现在这里会翻车 */
const REAL_BIG_PICKLE = {
  id: 'big-pickle',
  providerID: 'opencode',
  name: 'Big Pickle',
  family: 'big-pickle',
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: { field: 'reasoning_content' },
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 200000, input: 160000, output: 32000 },
  status: 'active',
  variants: {},
};

/** 真实收费模型：四项都不为 0 */
const REAL_CLAUDE_SONNET = {
  id: 'claude-sonnet-4-5',
  providerID: 'opencode',
  name: 'Claude Sonnet 4.5',
  family: 'claude-sonnet',
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: true },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: true,
  },
  cost: {
    input: 3,
    output: 15,
    cache: { read: 0.3, write: 3.75 },
    tiers: [{ input: 6, output: 22.5, cache: { read: 0.6, write: 7.5 } }],
  },
  limit: { context: 1000000, output: 64000 },
  status: 'active',
  variants: {},
};

/** 真实收费模型：input/output 为 0，但 cache 读写不是 0（只看前两项会误判成免费） */
const REAL_CACHE_ONLY_PAID = {
  id: 'MiniMax-M3',
  providerID: 'minimax-cn',
  name: 'MiniMax-M3',
  family: 'minimax',
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: true, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0.3, output: 1.2, cache: { read: 0.06, write: 0 } },
  limit: { context: 1000000, output: 512000 },
  status: 'active',
  variants: { none: { thinking: { type: 'disabled' } } },
};

/** 真实结构的完整响应壳 */
function payloadOf(...providers) {
  return { providers, default: {} };
}

/* ------------------------------------------------------------------ */
/* isFreeModel                                                         */
/* ------------------------------------------------------------------ */

test('isFreeModel：价格四项全 0 算免费', () => {
  assert.equal(isFreeModel(REAL_DEEPSEEK_FLASH_FREE), true);
  assert.equal(isFreeModel(REAL_BIG_PICKLE), true);
});

test('isFreeModel：名字带 free 不算数，要看价格', () => {
  // 名字带 free 但价格非 0 → 收费
  const liar = {
    id: 'trap-free',
    name: 'Trap Free',
    cost: { input: 1, output: 2, cache: { read: 0.1, write: 0.2 } },
  };
  assert.equal(isFreeModel(liar), false);

  // 名字不带 free 但价格全 0 → 免费（真实例子 big-pickle）
  assert.equal(isFreeModel(REAL_BIG_PICKLE), true);
  assert.ok(!/free/i.test(REAL_BIG_PICKLE.name), '夹具本身名字里不该有 free');
});

test('isFreeModel：input/output 为 0 但 cache 非 0 → 收费', () => {
  assert.equal(isFreeModel({ cost: { input: 0, output: 0, cache: { read: 0.5, write: 0 } } }), false);
  assert.equal(isFreeModel({ cost: { input: 0, output: 0, cache: { read: 0, write: 0.5 } } }), false);
  // 负数/异常值不当作免费
  assert.equal(isFreeModel({ cost: { input: 0, output: 0, cache: { read: -1, write: 0 } } }), false);
});

test('isFreeModel：字段缺失按 0 处理，只有一项非 0 就是收费', () => {
  assert.equal(isFreeModel({}), true, '整个 cost 缺失 → 视为全 0');
  assert.equal(isFreeModel({ cost: {} }), true);
  assert.equal(isFreeModel({ cost: { input: 0 } }), true, '只给 input 且为 0');
  assert.equal(isFreeModel({ cost: { input: 0, output: 0 } }), true, 'cache 整个缺失');
  assert.equal(isFreeModel({ cost: { input: 0, output: 0, cache: {} } }), true);

  // 只要有一项非 0 就是收费
  assert.equal(isFreeModel({ cost: { input: 0, output: 0, cache: { read: 0, write: 0.01 } } }), false);
  assert.equal(isFreeModel({ cost: { input: 0.01 } }), false);
});

test('isFreeModel：不认识的价格值宁可当收费，不谎报免费', () => {
  assert.equal(isFreeModel({ cost: { input: 'abc', output: 0 } }), false);
  assert.equal(isFreeModel({ cost: { input: null, output: null } }), true, 'null 视为缺失');
  assert.equal(isFreeModel({ cost: { input: '0', output: '0', cache: { read: '0', write: '0' } } }), true);
  assert.equal(isFreeModel(null), true, '完全没给东西也不该炸');
});

/* ------------------------------------------------------------------ */
/* collectModels                                                       */
/* ------------------------------------------------------------------ */

test('collectModels：把真实响应摊平，条数与结构符合契约', () => {
  const models = collectModels(
    payloadOf({
      id: 'opencode',
      name: 'opencode',
      models: {
        'deepseek-v4.1-flash-free': REAL_DEEPSEEK_FLASH_FREE,
        'big-pickle': REAL_BIG_PICKLE,
        'claude-sonnet-4-5': REAL_CLAUDE_SONNET,
      },
    }),
  );

  assert.equal(models.length, 3);
  assert.deepEqual(
    models.map((m) => m.id),
    ['opencode/big-pickle', 'opencode/claude-sonnet-4-5', 'opencode/deepseek-v4.1-flash-free'],
    '按 id 排序',
  );

  const flash = models.find((m) => m.modelID === 'deepseek-v4.1-flash-free');
  assert.deepEqual(flash, {
    id: 'opencode/deepseek-v4.1-flash-free',
    providerID: 'opencode',
    modelID: 'deepseek-v4.1-flash-free',
    name: 'DeepSeek V4.1 Flash Free',
    free: true,
    reasoning: true,
    variants: { low: { reasoningEffort: 'low' }, high: { reasoningEffort: 'high' } },
    images: true,
    // 视频/PDF 现在单独提取，因为 ZCode 的能力声明是分开写的
    video: false,
    pdf: false,
    contextWindow: 200000,
    upstreamLimits: { context: 200000, output: 32000 },
    deprecated: false,
  });
});

test('collectModels：多供应商合并后统一排序', () => {
  const models = collectModels(
    payloadOf(
      { id: 'opencode', name: 'opencode', models: { 'big-pickle': REAL_BIG_PICKLE } },
      { id: 'minimax-cn', name: 'minimax', models: { 'MiniMax-M3': REAL_CACHE_ONLY_PAID } },
    ),
  );
  assert.deepEqual(
    models.map((m) => m.id),
    ['minimax-cn/MiniMax-M3', 'opencode/big-pickle'],
  );
});

test('collectModels：同一个 id 重复出现只留一条', () => {
  const models = collectModels(
    payloadOf(
      {
        id: 'opencode',
        models: {
          dup: { id: 'dup', name: '先出现的', cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } },
        },
      },
      { id: 'opencode', models: { dup: { id: 'dup', name: '后出现的', cost: { input: 9 } } } },
    ),
  );
  assert.equal(models.length, 1);
  assert.equal(models[0].name, '先出现的', '重复时以先出现的为准');
  assert.equal(models[0].free, true);
});

test('collectModels：字段大面积缺失也不抛异常', () => {
  const models = collectModels(payloadOf({ id: 'p', models: { 'm1': {} } }));
  assert.deepEqual(models, [
    {
      id: 'p/m1',
      providerID: 'p',
      modelID: 'm1',
      name: 'm1', // 没 name 就用 modelID 顶上
      free: true,
      reasoning: false,
      variants: {},
      images: false,
      video: false,
      pdf: false,
      contextWindow: null,
      upstreamLimits: {},
      deprecated: false,
    },
  ]);
});

test('collectModels：输入长得不对时返回空数组而不是抛错', () => {
  for (const bad of [null, undefined, {}, [], { providers: null }, { providers: 'x' }, { providers: [null, 1, 'x'] }]) {
    assert.deepEqual(collectModels(bad), [], `输入 ${JSON.stringify(bad)} 应得空数组`);
  }
  // 供应商没有 id / models 长得不对 → 跳过它，但不影响别人
  const models = collectModels(
    payloadOf(
      { name: '没有 id', models: { a: {} } },
      { id: 'ok', models: null },
      { id: 'good', models: { m: { id: 'm' } } },
    ),
  );
  assert.deepEqual(models.map((m) => m.id), ['good/m']);
});

test('collectModels：contextWindow 取 limit.context，取不到退到 limit.output', () => {
  const models = collectModels(
    payloadOf({
      id: 'p',
      models: {
        hasContext: { limit: { context: 200000, output: 32000 } },
        onlyOutput: { limit: { output: 8192 } },
        noLimit: {},
        emptyLimit: { limit: {} },
        weirdLimit: { limit: { context: 'abc', output: 4096 } },
      },
    }),
  );
  const byId = Object.fromEntries(models.map((m) => [m.modelID, m.contextWindow]));
  assert.equal(byId.hasContext, 200000);
  assert.equal(byId.onlyOutput, 8192);
  assert.equal(byId.noLimit, null);
  assert.equal(byId.emptyLimit, null);
  assert.equal(byId.weirdLimit, 4096, 'context 不是数字时退到 output');
});

test('collectModels：images 认 modalities 也认 capabilities', () => {
  const models = collectModels(
    payloadOf({
      id: 'p',
      models: {
        byModalitiesArray: { modalities: ['text', 'image'] },
        byModalitiesObject: { modalities: { input: ['text', 'image'] } },
        byCapabilities: { capabilities: { input: { image: true } } },
        byCapabilitiesFalse: { capabilities: { input: { image: false }, attachment: false } },
        imageFalseWinsOverAttachment: { capabilities: { attachment: true, input: { image: false } } },
        none: {},
      },
    }),
  );
  const byId = Object.fromEntries(models.map((m) => [m.modelID, m.images]));
  assert.equal(byId.byModalitiesArray, true);
  assert.equal(byId.byModalitiesObject, true);
  assert.equal(byId.byCapabilities, true);
  assert.equal(byId.byCapabilitiesFalse, false);
  assert.equal(byId.imageFalseWinsOverAttachment, false, '显式 image:false 优先于 attachment');
  assert.equal(byId.none, false);
});

test('collectModels：deprecated 认 status 也认布尔', () => {
  const models = collectModels(
    payloadOf({
      id: 'p',
      models: {
        byStatus: { status: 'deprecated' },
        byBool: { deprecated: true },
        active: { status: 'active' },
        nothing: {},
        falseBool: { deprecated: false, status: 'active' },
      },
    }),
  );
  const byId = Object.fromEntries(models.map((m) => [m.modelID, m.deprecated]));
  assert.equal(byId.byStatus, true);
  assert.equal(byId.byBool, true);
  assert.equal(byId.active, false);
  assert.equal(byId.nothing, false);
  assert.equal(byId.falseBool, false);
});

test('collectModels：variant 缺失给 {}，不是 undefined', () => {
  const models = collectModels(payloadOf({ id: 'p', models: { a: { variants: null }, b: {} } }));
  for (const model of models) {
    assert.deepEqual(model.variants, {});
    assert.equal(typeof model.variants, 'object');
  }
});

/* ------------------------------------------------------------------ */
/* modelIdOf / parseModelId                                            */
/* ------------------------------------------------------------------ */

test('modelIdOf：拼成 provider/model', () => {
  assert.equal(modelIdOf('opencode', 'big-pickle'), 'opencode/big-pickle');
  assert.equal(modelIdOf('minimax-cn', 'MiniMax-M3'), 'minimax-cn/MiniMax-M3');
});

test('modelIdOf：参数不成对时抛 BridgeError', () => {
  for (const [p, m] of [[undefined, 'x'], ['x', undefined], ['', 'x'], ['x', ''], [1, 2], [null, null]]) {
    assert.throws(() => modelIdOf(p, m), (error) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, 'invalid_request');
      assert.equal(error.status, 400);
      return true;
    });
  }
});

test('parseModelId：拆回两段，按第一个斜杠切', () => {
  assert.deepEqual(parseModelId('opencode/big-pickle'), {
    providerID: 'opencode',
    modelID: 'big-pickle',
  });
  // 模型名本身带斜杠也要能拆对
  assert.deepEqual(parseModelId('openrouter/anthropic/claude-3'), {
    providerID: 'openrouter',
    modelID: 'anthropic/claude-3',
  });
});

test('parseModelId：不合法返回 null', () => {
  for (const bad of ['noslash', '', '/leading', 'trailing/', '/', null, undefined, 123, {}, []]) {
    assert.equal(parseModelId(bad), null, `${JSON.stringify(bad)} 应为 null`);
  }
});

test('modelIdOf 与 parseModelId 可以来回转', () => {
  const id = modelIdOf('opencode', 'deepseek-v4.1-flash-free');
  assert.deepEqual(parseModelId(id), {
    providerID: 'opencode',
    modelID: 'deepseek-v4.1-flash-free',
  });
});

/* ------------------------------------------------------------------ */
/* interleaveByProvider：按来源摊开模型清单                              */

test('interleaveByProvider：每个来源轮流取，任何前缀都尽量覆盖多个来源', () => {
  // 真实会话里 68 个候选，来源分布很不均匀，坏来源还总在字母序最前面。
  const models = [
    ...Array.from({ length: 27 }, (_, i) => ({ id: `alibaba/a${i}`, providerID: 'alibaba' })),
    ...Array.from({ length: 24 }, (_, i) => ({ id: `openai/o${i}`, providerID: 'openai' })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `opencode/oc${i}`, providerID: 'opencode' })),
    ...Array.from({ length: 7 }, (_, i) => ({ id: `zai/z${i}`, providerID: 'zai' })),
  ];
  const out = interleaveByProvider(models);

  assert.equal(out.length, models.length, '一个都不能少');
  assert.deepEqual([...out].sort((a, b) => (a.id < b.id ? -1 : 1)), [...models].sort((a, b) => (a.id < b.id ? -1 : 1)));

  // 关键性质：取前 12 个时，必须覆盖到 4 个来源，而不是全挤在第一个。
  const first12 = new Set(out.slice(0, 12).map((m) => m.providerID));
  assert.equal(first12.size, 4, `前 12 个应当覆盖全部 4 个来源，实际只有 ${first12.size} 个`);
});

test('interleaveByProvider：只有一个来源时保持原顺序', () => {
  const models = [{ id: 'a/1', providerID: 'a' }, { id: 'a/2', providerID: 'a' }];
  assert.deepEqual(interleaveByProvider(models).map((m) => m.id), ['a/1', 'a/2']);
});

test('interleaveByProvider：空数组与非法输入都返回空数组，不抛', () => {
  assert.deepEqual(interleaveByProvider([]), []);
  for (const bad of [null, undefined, 'nope', 42, {}]) {
    assert.deepEqual(interleaveByProvider(bad), [], `${JSON.stringify(bad)} 应为空数组`);
  }
});

test('interleaveByProvider：不改动传入的数组', () => {
  const models = [
    { id: 'a/1', providerID: 'a' },
    { id: 'b/1', providerID: 'b' },
    { id: 'a/2', providerID: 'a' },
  ];
  const copy = JSON.parse(JSON.stringify(models));
  interleaveByProvider(models);
  assert.deepEqual(models, copy, '原数组必须原封不动');
});

/* ------------------------------------------------------------------ */
/* faucetModels：只放行 opencode 官方的免费模型                            */
/* 这是需求本体：用户在 OpenCode 里另外配的供应商花的是他自己的钱，不能放进来。 */
/* ------------------------------------------------------------------ */

/** 造一条摊平后的模型记录，只关心被筛的三个字段 */
function faucetCase(providerID, { free = true, deprecated = false, modelID = 'm' } = {}) {
  return { id: `${providerID}/${modelID}`, providerID, modelID, name: modelID, free, deprecated };
}

test('faucetModels：只留 opencode 这一家的模型', () => {
  const models = [
    faucetCase('opencode', { modelID: 'deepseek-v4.1-flash-free' }),
    faucetCase('alibaba-token-plan-cn', { modelID: 'qwen3.8-max' }),
    faucetCase('openai', { modelID: 'gpt-5.5' }),
    faucetCase('zai-coding-plan', { modelID: 'glm-5.2' }),
    faucetCase('opencode', { modelID: 'big-pickle' }),
  ];
  assert.deepEqual(
    faucetModels(models).map((m) => m.id),
    ['opencode/deepseek-v4.1-flash-free', 'opencode/big-pickle'],
    '别的供应商一个都不该混进来',
  );
});

test('faucetModels：opencode 里收费的也不要', () => {
  const models = [
    faucetCase('opencode', { modelID: 'free-one', free: true }),
    faucetCase('opencode', { modelID: 'paid-one', free: false }),
  ];
  assert.deepEqual(faucetModels(models).map((m) => m.modelID), ['free-one']);
});

test('faucetModels：要过期的也不要（目录里还留着但已经路由不到）', () => {
  const models = [
    faucetCase('opencode', { modelID: 'live', deprecated: false }),
    faucetCase('opencode', { modelID: 'dead', deprecated: true }),
  ];
  assert.deepEqual(faucetModels(models).map((m) => m.modelID), ['live']);
});

test('faucetModels：不符合条件时返回空数组，而不是抛异常', () => {
  assert.deepEqual(faucetModels([]), []);
  // 全部都是别的供应商 → 一个都不放
  assert.deepEqual(faucetModels([faucetCase('openai'), faucetCase('zai-coding-plan')]), []);
  for (const bad of [null, undefined, 'nope', 42, {}]) {
    assert.deepEqual(faucetModels(bad), [], `${JSON.stringify(bad)} 应为空数组`);
  }
});

test('faucetModels：不改动传入的数组', () => {
  const models = [faucetCase('opencode'), faucetCase('openai')];
  const copy = JSON.parse(JSON.stringify(models));
  faucetModels(models);
  assert.deepEqual(models, copy, '原数组必须原封不动');
});

test('faucetModels 接在 collectModels 后面：从真实结构一路筛到底', () => {
  // 形状照抄本机 /config/providers：两家供应商，各有一个免费模型
  const payload = {
    providers: [
      {
        id: 'opencode',
        name: 'OpenCode',
        models: {
          'big-pickle': { name: 'Big Pickle', cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } },
          'gpt-5.5': { name: 'GPT-5.5', cost: { input: 3, output: 15 } },
        },
      },
      {
        id: 'zai-coding-plan',
        name: 'Z.ai',
        models: {
          'glm-5.2': { name: 'GLM-5.2', cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } },
        },
      },
    ],
  };
  const picked = faucetModels(collectModels(payload));
  assert.deepEqual(picked.map((m) => m.id), ['opencode/big-pickle']);
});
