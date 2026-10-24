/**
 * Bridge 快照里「模型视图」新字段的测试（工单 02：快照数据补齐）。
 *
 * 面板要靠这些字段渲染「推理：低·高」档位标签和详情里的输入能力（视频/PDF），
 * 但 #view() 以前把 variants / video / pdf 都丢掉了。这里断言：
 *   - 推理模型带 supportedEfforts / defaultEffort / canDisableThinking；
 *   - 非推理模型给空列表 / null / false 的合理缺省，不报错；
 *   - video / pdf 布尔原样透传。
 *
 * 不联网、不起进程：直接往 state.models 里塞模型，调同步的 snapshot()。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Bridge } from '../src/main.js';

/**
 * 造一个只带着给定模型清单的桥。
 * 快照是同步广播用的，所以这里也必须同步拿结果。
 */
function bridgeWith(models) {
  const bridge = new Bridge({ log: () => {} });
  bridge.state.models = models;
  return bridge;
}

/** 一个能用的最小模型骨架，测试按需覆盖字段 */
function model(overrides) {
  return {
    id: 'opencode/demo',
    providerID: 'opencode',
    modelID: 'demo',
    name: '演示',
    free: true,
    reasoning: false,
    variants: {},
    images: false,
    video: false,
    pdf: false,
    contextWindow: 128000,
    deprecated: false,
    ...overrides,
  };
}

test('快照视图：推理模型带档位明细（supportedEfforts / defaultEffort / canDisableThinking）', () => {
  const bridge = bridgeWith([
    model({
      id: 'opencode/thinker',
      modelID: 'thinker',
      reasoning: true,
      variants: {
        high: { reasoningEffort: 'high' },
        low: { reasoningEffort: 'low' },
        off: { reasoningEffort: 'none' },
      },
    }),
  ]);

  const [view] = bridge.snapshot().models;
  // 档位按强度从低到高排（none 在最前），顺序由 EFFORT_ORDER 决定
  assert.deepEqual(view.supportedEfforts, ['none', 'low', 'high']);
  // 没有 medium 时默认挑第一个能用的非 none 档
  assert.equal(view.defaultEffort, 'low');
  assert.equal(view.canDisableThinking, true, '有 none 档 = 思考可以关掉');
});

test('快照视图：推理模型的默认档位优先挑 medium', () => {
  const bridge = bridgeWith([
    model({
      id: 'opencode/mid',
      modelID: 'mid',
      reasoning: true,
      variants: {
        low: { reasoningEffort: 'low' },
        medium: { reasoningEffort: 'medium' },
        high: { reasoningEffort: 'high' },
      },
    }),
  ]);

  const [view] = bridge.snapshot().models;
  assert.deepEqual(view.supportedEfforts, ['low', 'medium', 'high']);
  assert.equal(view.defaultEffort, 'medium', 'medium 最像「正常」档，优先当默认');
  assert.equal(view.canDisableThinking, false, '没有 none 档 = 关不掉思考');
});

test('快照视图：支持推理但没有 variants 的模型给空档位，不报错', () => {
  const bridge = bridgeWith([
    model({ id: 'opencode/bare', modelID: 'bare', reasoning: true, variants: {} }),
  ]);

  const [view] = bridge.snapshot().models;
  assert.deepEqual(view.supportedEfforts, []);
  assert.equal(view.defaultEffort, null);
  assert.equal(view.canDisableThinking, false);
});

test('快照视图：非推理模型给合理缺省（空列表 / null / false）', () => {
  const bridge = bridgeWith([model({ id: 'opencode/plain', modelID: 'plain' })]);

  const [view] = bridge.snapshot().models;
  assert.deepEqual(view.supportedEfforts, []);
  assert.equal(view.defaultEffort, null);
  assert.equal(view.canDisableThinking, false);
});

test('快照视图：video / pdf 布尔原样透传', () => {
  const bridge = bridgeWith([
    model({ id: 'opencode/media', modelID: 'media', video: true, pdf: true }),
    model({ id: 'opencode/text', modelID: 'text', video: false, pdf: false }),
  ]);

  const [media, text] = bridge.snapshot().models;
  assert.equal(media.video, true);
  assert.equal(media.pdf, true);
  assert.equal(text.video, false);
  assert.equal(text.pdf, false);
});

test('快照视图：同时给出上游上下文、用户覆盖值和当前生效值', () => {
  const bridge = bridgeWith([
    model({
      upstreamContextWindow: 200_000,
      contextWindowOverride: 1_000_000,
      contextWindow: 1_000_000,
    }),
  ]);

  const [view] = bridge.snapshot().models;
  assert.equal(view.upstreamContextWindow, 200_000);
  assert.equal(view.contextWindowOverride, 1_000_000);
  assert.equal(view.contextWindow, 1_000_000);
});

test('快照视图：新字段不影响原有字段，且快照仍是同步可序列化的', () => {
  const bridge = bridgeWith([
    model({ id: 'opencode/keep', modelID: 'keep', reasoning: true, variants: { high: { reasoningEffort: 'high' } } }),
  ]);
  bridge.state.verdicts.set('opencode/keep', {
    verdict: 'tool',
    note: '测过',
    elapsedMs: 42,
    checkedAt: 123,
    cached: false,
  });

  const snap = bridge.snapshot();
  const [view] = snap.models;
  // 老字段一个不能少、值不能变
  assert.equal(view.id, 'opencode/keep');
  assert.equal(view.name, '演示');
  assert.equal(view.providerID, 'opencode');
  assert.equal(view.modelID, 'keep');
  assert.equal(view.free, true);
  assert.equal(view.reasoning, true);
  assert.equal(view.images, false);
  assert.equal(view.contextWindow, 128000);
  assert.equal(view.deprecated, false);
  assert.equal(view.verdict, 'tool');
  assert.equal(view.note, '测过');
  assert.equal(view.elapsedMs, 42);
  assert.equal(view.checkedAt, 123);
  assert.equal(view.cached, false);
  // 桌面端要拿它做同步广播，必须能整个 JSON 序列化走一遍
  assert.doesNotThrow(() => JSON.stringify(snap));
});
