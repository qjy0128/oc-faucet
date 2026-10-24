/** 模型上下文覆盖的桥接测试：只用假 OpenCode、假目标和临时设置目录。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Bridge } from '../src/main.js';
import { OcClient } from '../src/oc-client.js';
import { BridgeError } from '../src/errors.js';
import * as settings from '../src/settings.js';

const MODEL_ID = 'opencode/demo';
const ORIGINAL = { context: 200_000, input: 0, output: 32_000 };

async function withSettingsDir(t, prefix = 'oc-model-context-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const previousDataDir = process.env.OCF_DATA_DIR;
  process.env.OCF_DATA_DIR = dir;
  t.after(async () => {
    if (previousDataDir === undefined) delete process.env.OCF_DATA_DIR;
    else process.env.OCF_DATA_DIR = previousDataDir;
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function providers(limit = ORIGINAL) {
  return {
    providers: [
      {
        id: 'opencode',
        models: {
          demo: {
            name: '演示模型',
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            limit: { ...limit },
          },
        },
      },
    ],
  };
}

function fakeTarget({ written = false, failInstalls = 0 } = {}) {
  let installCalls = 0;
  let remainingFailures = failInstalls;
  let latestModels = [];
  return {
    target: {
      id: 'fake',
      label: '假目标',
      detect: () => true,
      status: async () => ({ written, models: latestModels.map((model) => model.id) }),
      install: async (models) => {
        installCalls += 1;
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          throw new Error('假目标暂时不可写');
        }
        latestModels = models;
        return { added: models.length, changed: true };
      },
      uninstall: async () => ({ removed: 0, changed: false }),
    },
    get installCalls() { return installCalls; },
    get latestModels() { return latestModels; },
  };
}

function contextBridge({ limits = ORIGINAL, target, mode = 'normal' } = {}) {
  let currentLimits = { ...limits };
  let nextMode = mode;
  const writes = [];
  const bridge = new Bridge({ log: () => {}, targets: target ? [target.target ?? target] : [] });
  bridge.client = {
    ready: true,
    isolate: true,
    providers: async () => providers(currentLimits),
    setModelContextWindows: async (entries) => {
      writes.push(structuredClone(entries));
      const currentMode = nextMode;
      nextMode = 'normal';
      if (currentMode === 'reject') {
        throw new BridgeError('假 OpenCode 拒绝配置', 502, 'upstream_config_error');
      }
      if (currentMode !== 'no-apply') currentLimits = { ...entries[0].limit };
      if (currentMode === 'dispose-failure') {
        throw new BridgeError('假 dispose 失败', 502, 'upstream_dispose_error');
      }
    },
  };
  bridge.state.port = 41982;
  bridge.state.apiKey = 'test-key';
  return {
    bridge,
    writes,
    setMode(value) { nextMode = value; },
    setLimits(value) { currentLimits = { ...value }; },
    get limits() { return currentLimits; },
  };
}

test('模型上下文：保存后刷新只展示上游实值，确认同步后才能标为生效', async (t) => {
  await withSettingsDir(t);
  const fixture = contextBridge();
  const { bridge, writes } = fixture;

  await bridge.refresh();
  bridge.state.verdicts.set(MODEL_ID, { verdict: 'tool', note: '' });
  await bridge.setModelContextWindow(MODEL_ID, 1_000_000);

  assert.deepEqual(writes[0], [{
    modelID: 'demo',
    limit: { context: 1_000_000, input: 1_000_000, output: 32_000 },
  }], 'input 为 0 时按 OpenCode 的 fallback 语义改成新的上下文预算');
  assert.deepEqual((await settings.readSettings()).modelContextWindowOriginals[MODEL_ID], ORIGINAL);
  assert.equal(fixture.limits.context, 1_000_000);

  await bridge.refresh();
  const [view] = bridge.snapshot().models;
  assert.equal(view.contextWindow, 1_000_000);
  assert.equal(view.upstreamContextWindow, 200_000);
  assert.equal(view.contextWindowOverride, 1_000_000);
  assert.equal(view.contextWindowPending, false);

  await bridge.setModelContextWindow(MODEL_ID, null);
  assert.deepEqual(writes[1], [{ modelID: 'demo', limit: ORIGINAL }]);
  assert.deepEqual((await settings.readSettings()).modelContextWindows, {});
  assert.deepEqual((await settings.readSettings()).modelContextWindowOriginals, {});
  assert.deepEqual((await settings.readSettings()).modelContextWindowPending, {});

  // 清除成功后不再用历史原值覆盖后来从 provider 读到的新默认值。
  const nextDefault = { context: 300_000, output: 50_000 };
  const fakeClient = bridge.client;
  fakeClient.providers = async () => providers(nextDefault);
  await bridge.refresh();
  const [afterUpstreamChange] = bridge.snapshot().models;
  assert.equal(afterUpstreamChange.contextWindow, 300_000);
  assert.equal(afterUpstreamChange.upstreamContextWindow, 300_000);
  assert.equal(afterUpstreamChange.contextWindowOverride, null);
  assert.equal(afterUpstreamChange.contextWindowPending, false);
});

test('模型上下文：首次 PATCH 被拒绝时回滚本机意图且不假报生效', async (t) => {
  await withSettingsDir(t);
  const fixture = contextBridge({ mode: 'reject' });
  await fixture.bridge.refresh();

  await assert.rejects(
    () => fixture.bridge.setModelContextWindow(MODEL_ID, 1_000_000),
    (error) => error.code === 'upstream_config_error',
  );
  const saved = await settings.readSettings();
  assert.deepEqual(saved.modelContextWindows, {});
  assert.deepEqual(saved.modelContextWindowOriginals, {});
  assert.deepEqual(saved.modelContextWindowPending, {});
  const [view] = fixture.bridge.snapshot().models;
  assert.equal(view.contextWindow, 200_000);
  assert.equal(view.contextWindowOverride, null);
  assert.equal(view.contextWindowPending, false);
});

test('模型上下文：有请求正在处理时拒绝修改，不调用 OpenCode', async (t) => {
  await withSettingsDir(t);
  const fixture = contextBridge();
  await fixture.bridge.refresh();
  fixture.bridge.activePromptCount = 1;

  await assert.rejects(
    () => fixture.bridge.setModelContextWindow(MODEL_ID, 1_000_000),
    (error) => error.code === 'context_window_busy',
  );
  assert.deepEqual(fixture.writes, []);
  assert.deepEqual((await settings.readSettings()).modelContextWindows, {});
});

test('模型上下文：上游未确认新值时保留 pending，refresh 不显示假生效', async (t) => {
  await withSettingsDir(t);
  const fixture = contextBridge({ mode: 'no-apply' });
  await fixture.bridge.refresh();

  await assert.rejects(
    () => fixture.bridge.setModelContextWindow(MODEL_ID, 1_000_000),
    (error) => error.code === 'context_window_sync_failed',
  );
  const saved = await settings.readSettings();
  assert.equal(saved.modelContextWindows[MODEL_ID], 1_000_000);
  assert.equal(saved.modelContextWindowPending[MODEL_ID], 1_000_000);

  await fixture.bridge.refresh();
  const [view] = fixture.bridge.snapshot().models;
  assert.equal(view.contextWindow, 200_000);
  assert.equal(view.contextWindowOverride, 1_000_000);
  assert.equal(view.contextWindowPending, true);

  fixture.setMode('normal');
  await fixture.bridge.setModelContextWindow(MODEL_ID, 1_000_000);
  const [recovered] = fixture.bridge.snapshot().models;
  assert.equal(recovered.contextWindow, 1_000_000);
  assert.equal(recovered.contextWindowPending, false);
});

test('模型上下文：恢复 dispose 失败后保留恢复意图，下一次 null 会重试', async (t) => {
  await withSettingsDir(t);
  await settings.writeSettings({
    modelContextWindows: { [MODEL_ID]: 1_000_000 },
    modelContextWindowOriginals: { [MODEL_ID]: ORIGINAL },
  });
  const fixture = contextBridge({
    limits: { context: 1_000_000, input: 1_000_000, output: 32_000 },
    mode: 'dispose-failure',
  });
  await fixture.bridge.refresh();

  await assert.rejects(
    () => fixture.bridge.setModelContextWindow(MODEL_ID, null),
    (error) => error.code === 'context_window_sync_failed',
  );
  const afterFailure = await settings.readSettings();
  assert.equal(afterFailure.modelContextWindows[MODEL_ID], 1_000_000);
  assert.equal(afterFailure.modelContextWindowPending[MODEL_ID], null);
  const [pending] = fixture.bridge.snapshot().models;
  assert.equal(pending.contextWindowOverride, 1_000_000);
  assert.equal(pending.contextWindowPending, true);

  await fixture.bridge.setModelContextWindow(MODEL_ID, null);
  assert.equal(fixture.writes.length, 2, '第二次恢复必须再次写上游');
  const recovered = await settings.readSettings();
  assert.deepEqual(recovered.modelContextWindows, {});
  assert.deepEqual(recovered.modelContextWindowOriginals, {});
  assert.deepEqual(recovered.modelContextWindowPending, {});
  const [view] = fixture.bridge.snapshot().models;
  assert.equal(view.contextWindow, 200_000);
  assert.equal(view.contextWindowOverride, null);
  assert.equal(view.contextWindowPending, false);
});

test('模型上下文：恢复时目标同步失败会保留旧值，重复 null 可重试目标同步', async (t) => {
  await withSettingsDir(t);
  await settings.writeSettings({
    modelContextWindows: { [MODEL_ID]: 1_000_000 },
    modelContextWindowOriginals: { [MODEL_ID]: ORIGINAL },
  });
  const target = fakeTarget({ written: true, failInstalls: 1 });
  const fixture = contextBridge({
    limits: { context: 1_000_000, input: 1_000_000, output: 32_000 },
    target,
  });
  fixture.bridge.server = {};
  fixture.bridge.state.verdicts.set(MODEL_ID, { verdict: 'tool', note: '' });
  await fixture.bridge.refresh();

  await assert.rejects(
    () => fixture.bridge.setModelContextWindow(MODEL_ID, null),
    (error) => error.code === 'context_window_target_sync_failed',
  );
  const afterFailure = await settings.readSettings();
  assert.equal(afterFailure.modelContextWindows[MODEL_ID], 1_000_000);
  assert.equal(afterFailure.modelContextWindowPending[MODEL_ID], null);
  const [pending] = fixture.bridge.snapshot().models;
  assert.equal(pending.contextWindow, 200_000);
  assert.equal(pending.contextWindowOverride, 1_000_000);
  assert.equal(pending.contextWindowPending, true);

  await fixture.bridge.setModelContextWindow(MODEL_ID, null);
  assert.equal(target.installCalls, 2);
  assert.deepEqual((await settings.readSettings()).modelContextWindows, {});
  assert.deepEqual((await settings.readSettings()).modelContextWindowPending, {});
  const [view] = fixture.bridge.snapshot().models;
  assert.equal(view.contextWindowOverride, null);
  assert.equal(view.contextWindowPending, false);
});

test('启动时会重放上次未完成的恢复意图', async (t) => {
  const dir = await withSettingsDir(t);
  const names = ['OCF_ZCODE_CONFIG', 'OCF_ZCODE_BUILTIN', 'OCF_ZCODE_RUNTIME', 'OCF_PORT'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    OCF_ZCODE_CONFIG: join(dir, 'zcode', 'provider_config.json'),
    OCF_ZCODE_BUILTIN: join(dir, 'zcode', 'builtin.json'),
    OCF_ZCODE_RUNTIME: join(dir, 'zcode', 'runtime'),
    OCF_PORT: '0',
  });
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  await settings.writeSettings({
    modelContextWindows: { [MODEL_ID]: 1_000_000 },
    modelContextWindowOriginals: { [MODEL_ID]: ORIGINAL },
    modelContextWindowPending: { [MODEL_ID]: null },
  });

  const originalStart = OcClient.prototype.start;
  const originalProviders = OcClient.prototype.providers;
  const originalSet = OcClient.prototype.setModelContextWindows;
  let limits = { context: 1_000_000, input: 1_000_000, output: 32_000 };
  const writes = [];
  OcClient.prototype.start = async function startFake() {
    this.started = true;
    this.exited = false;
    this.port = 43212;
  };
  OcClient.prototype.providers = async function providersFake() {
    return providers(limits);
  };
  OcClient.prototype.setModelContextWindows = async function setFake(entries) {
    writes.push(structuredClone(entries));
    limits = { ...entries[0].limit };
    return { ok: true };
  };
  t.after(() => {
    OcClient.prototype.start = originalStart;
    OcClient.prototype.providers = originalProviders;
    OcClient.prototype.setModelContextWindows = originalSet;
  });

  const bridge = new Bridge({ log: () => {}, targets: [] });
  await bridge.start();
  assert.deepEqual(writes, [[{ modelID: 'demo', limit: ORIGINAL }]]);
  assert.deepEqual(limits, ORIGINAL);
  assert.equal(bridge.state.phase, 'ready');
  assert.deepEqual((await settings.readSettings()).modelContextWindows, {});
  assert.deepEqual((await settings.readSettings()).modelContextWindowPending, {});
  if (bridge.server || bridge.client?.ready) await bridge.stop({ uninstall: false });
});

test('通用设置接口：拒绝绕过模型专用操作修改上下文数据', async (t) => {
  await withSettingsDir(t, 'oc-model-context-settings-');
  const bridge = new Bridge({ log: () => {}, targets: [] });
  await assert.rejects(
    () => bridge.saveSettings({ modelContextWindows: { [MODEL_ID]: 1_000_000 } }),
    (error) => error.code === 'context_window_requires_model_action',
  );
  await assert.rejects(
    () => bridge.saveSettings({ modelContextWindowPending: { [MODEL_ID]: null } }),
    (error) => error.code === 'context_window_requires_model_action',
  );
  assert.deepEqual((await settings.readSettings()).modelContextWindows, {});
});
