/** 模型按 ID 屏蔽、持久化、转发排除、恢复显示，以及未就绪防护的单元测试。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Bridge } from '../src/main.js';
import { findMatchedBlockRules, isModelBlocked, normalizeBlockedModelId } from '../src/models.js';
import { readSettings, writeSettings } from '../src/settings.js';
import { startWebUi } from '../src/webui.js';

const MODEL_A = {
  id: 'opencode/alpha-free',
  providerID: 'opencode',
  modelID: 'alpha-free',
  name: 'Alpha Free',
  free: true,
  reasoning: false,
  variants: [],
  images: false,
  video: false,
  pdf: false,
  contextWindow: 128000,
  upstreamContextWindow: 128000,
  deprecated: false,
  costIn: 0,
  costOut: 0,
};

const MODEL_B = {
  id: 'opencode/beta-free',
  providerID: 'opencode',
  modelID: 'beta-free',
  name: 'Beta Free',
  free: true,
  reasoning: true,
  variants: ['low', 'high'],
  images: false,
  video: false,
  pdf: false,
  contextWindow: 128000,
  upstreamContextWindow: 128000,
  deprecated: false,
  costIn: 0,
  costOut: 0,
};

test('models 屏蔽匹配同时支持完整 ID（provider/model）与短 modelID', () => {
  assert.equal(normalizeBlockedModelId('  opencode/alpha-free '), 'opencode/alpha-free');
  assert.equal(normalizeBlockedModelId('alpha free'), null);
  assert.equal(normalizeBlockedModelId(''), null);

  assert.equal(isModelBlocked(MODEL_A, ['opencode/alpha-free']), true);
  assert.equal(isModelBlocked(MODEL_A, ['alpha-free']), true);
  assert.equal(isModelBlocked(MODEL_B, ['alpha-free']), false);
  assert.deepEqual(
    findMatchedBlockRules(MODEL_A, ['beta-free', 'alpha-free', 'opencode/alpha-free']),
    ['alpha-free', 'opencode/alpha-free'],
  );
});

test('settings 读写对 blockedModels 去重并过滤含空白的非法值', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-blocked-settings-'));
  const saved = process.env.OCF_DATA_DIR;
  process.env.OCF_DATA_DIR = dir;
  t.after(async () => {
    if (saved === undefined) delete process.env.OCF_DATA_DIR;
    else process.env.OCF_DATA_DIR = saved;
    await rm(dir, { recursive: true, force: true });
  });

  const written = await writeSettings({
    blockedModels: [' opencode/alpha-free ', 'alpha-free', 'alpha-free', 'bad id', '', 123],
  });
  assert.deepEqual(written.blockedModels, ['opencode/alpha-free', 'alpha-free']);

  const loaded = await readSettings();
  assert.deepEqual(loaded.blockedModels, ['opencode/alpha-free', 'alpha-free']);
});

test('Bridge：屏蔽模型从列表/目录/体检中隐藏与跳过，再次刷新保持隐藏，取消屏蔽立即恢复原判定', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-bridge-blocking-'));
  const saved = process.env.OCF_DATA_DIR;
  process.env.OCF_DATA_DIR = dir;
  await mkdir(join(dir, 'workspace'), { recursive: true });

  let probeTargets = [];
  let targetSyncCalls = 0;
  let lastSyncedIds = null;

  const client = {
    ready: true,
    isolate: true,
    async providers() {
      return {
        providers: [
          {
            id: 'opencode',
            models: {
              'alpha-free': { id: 'alpha-free', name: 'Alpha Free', status: 'active', cost: { input: 0, output: 0 } },
              'beta-free': { id: 'beta-free', name: 'Beta Free', status: 'active', cost: { input: 0, output: 0 } },
            },
          },
        ],
      };
    },
    async createSession() { return 'ses_1'; },
    async deleteSession() {},
    async prompt({ modelID }) {
      probeTargets.push(modelID);
      return { text: '{"content":"ok","calls":[]}', tokens: null, handoff: null };
    },
  };

  const fakeTarget = {
    id: 'zcode',
    label: 'ZCode',
    detect: () => true,
    status: async () => ({ id: 'zcode', label: 'ZCode', detected: true, written: true, models: lastSyncedIds ?? [] }),
    install: async (models) => {
      targetSyncCalls += 1;
      lastSyncedIds = models.map((m) => m.id);
      return { added: models.length, changed: true };
    },
    uninstall: async () => ({ removed: 0 }),
  };

  const bridge = new Bridge({ log: () => {}, targets: [fakeTarget] });
  bridge.client = client;
  bridge.server = { close: (cb) => cb?.(), closeIdleConnections: () => {} };
  bridge.state.phase = 'ready';
  await bridge.refresh();
  bridge.state.verdicts.set(MODEL_A.id, { verdict: 'tool', note: '', checkedAt: Date.now() });
  bridge.state.verdicts.set(MODEL_B.id, { verdict: 'failed', note: '暂不可用', checkedAt: Date.now() });

  t.after(async () => {
    await bridge.stop({ uninstall: false }).catch(() => {});
    if (saved === undefined) delete process.env.OCF_DATA_DIR;
    else process.env.OCF_DATA_DIR = saved;
    await rm(dir, { recursive: true, force: true });
  });

  // 屏蔽无效 ID 拒绝 400
  await assert.rejects(
    () => bridge.setModelBlocked('has space', true),
    (err) => err?.code === 'invalid_model_id' && err?.status === 400,
  );

  // 屏蔽 MODEL_B：立即隐藏、写设置持久化、同步已写入目标、probeOne 拒测
  const blocked = await bridge.setModelBlocked(MODEL_B.id, true);
  assert.equal(blocked.blocked, true);
  assert.deepEqual(blocked.blockedModels, [MODEL_B.id]);
  assert.equal(targetSyncCalls, 1);
  assert.deepEqual(lastSyncedIds, [MODEL_A.id]);

  let snap = bridge.snapshot();
  assert.deepEqual(snap.models.map((m) => m.id), [MODEL_A.id]);
  assert.deepEqual(snap.hiddenModels.map((m) => m.id), [MODEL_B.id]);
  assert.equal(snap.hiddenModels[0].inCatalog, true);
  assert.deepEqual(bridge.getModels().map((m) => m.id), [MODEL_A.id]);

  await assert.rejects(
    () => bridge.probeOne(MODEL_B.id),
    (err) => err?.code === 'model_blocked' && err?.status === 400,
  );

  // 重新拉取目录：仍自动隐藏；全量检测跳过已屏蔽的模型
  const refreshed = await bridge.refresh();
  assert.deepEqual(refreshed.map((m) => m.id), [MODEL_A.id]);
  assert.equal(bridge.snapshot().hiddenModels.length, 1);

  probeTargets = [];
  await bridge.probe({ force: true });
  assert.deepEqual(probeTargets, ['alpha-free'], '被屏蔽的模型不得消耗体检额度');

  // 手动规则找不到目录条目时仍展示于 hiddenModels（inCatalog: false）
  await bridge.setModelBlocked('ghost-model', true);
  const ghost = bridge.snapshot().hiddenModels.find((m) => m.id === 'ghost-model');
  assert.ok(ghost);
  assert.equal(ghost.inCatalog, false);

  // 取消屏蔽：MODEL_B 回到主列表且原有判定 verdict 仍在
  await bridge.setModelBlocked(MODEL_B.id, false);
  snap = bridge.snapshot();
  assert.deepEqual(snap.models.map((m) => m.id), [MODEL_A.id, MODEL_B.id]);
  assert.equal(snap.models.find((m) => m.id === MODEL_B.id)?.verdict, 'failed');
});

test('Bridge：OpenCode 未就绪时 probe / probeOne 直接抛 not_ready，不污染 verdicts 与磁盘缓存', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-not-ready-probe-'));
  const saved = process.env.OCF_DATA_DIR;
  process.env.OCF_DATA_DIR = dir;

  const bridge = new Bridge({ log: () => {}, targets: [] });
  bridge.client = { ready: false };
  bridge.state.phase = 'starting';
  bridge.state.models = [MODEL_A];

  t.after(async () => {
    await bridge.stop({ uninstall: false }).catch(() => {});
    if (saved === undefined) delete process.env.OCF_DATA_DIR;
    else process.env.OCF_DATA_DIR = saved;
    await rm(dir, { recursive: true, force: true });
  });

  await assert.rejects(() => bridge.probe(), (err) => err?.code === 'not_ready');
  await assert.rejects(() => bridge.probeOne(MODEL_A.id), (err) => err?.code === 'not_ready');
  assert.equal(bridge.state.verdicts.size, 0, '未就绪报错不应把模型标记为 failed');
});

test('webui：/api/models/block、/api/opencode/check 与 /api/state 接口契约完整', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-webui-block-'));
  const assetsDir = join(dir, 'desktop');
  const webClientFile = join(dir, 'web-client.js');
  await mkdir(assetsDir, { recursive: true });
  await writeFile(join(assetsDir, 'index.html'), '<html></html>');
  await writeFile(join(assetsDir, 'style.css'), '/* css */');
  await writeFile(join(assetsDir, 'renderer.js'), '/* js */');
  await writeFile(webClientFile, '/* client */');

  let blockedIds = [];
  let checkCount = 0;
  const fakeBridge = {
    snapshot: () => ({
      phase: 'ready',
      models: [MODEL_A].filter((m) => !blockedIds.includes(m.id)),
      hiddenModels: blockedIds.map((id) => ({ id, name: id })),
      blockedModels: [...blockedIds],
      opencode: { installed: true, externalRunning: false, installUrl: 'https://opencode.ai' },
    }),
    checkOpencodeEnv: async ({ force } = {}) => {
      if (force) checkCount += 1;
      return { installed: true, externalRunning: true, installUrl: 'https://opencode.ai' };
    },
    setModelBlocked: async (id, blocked) => {
      blockedIds = blocked ? [...new Set([...blockedIds, id])] : blockedIds.filter((x) => x !== id);
      return { ok: true, id, blocked, blockedModels: [...blockedIds] };
    },
    listTargetStates: async () => [],
    apiKey: () => 'sk-test',
    readSettings: async () => ({ probeConcurrency: 3, probeTtlMinutes: 360 }),
    requestsLogPath: () => join(dir, 'requests.jsonl'),
    zcodeConfigPath: () => join(dir, 'zcode.json'),
    lanInfo: () => ({ port: 4000, apiKey: 'sk-test', addresses: [], models: [] }),
  };

  const ui = await startWebUi({ bridge: fakeBridge, assetsDir, webClientFile });
  t.after(() => ui.close());

  const base = `http://127.0.0.1:${ui.port}`;
  const headers = { 'content-type': 'application/json', 'x-oc-token': ui.token };
  const bad = await fetch(`${base}/api/models/block`, { method: 'POST', headers, body: '{}' });
  assert.equal(bad.status, 400);

  const resBlock = await fetch(`${base}/api/models/block`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ id: MODEL_A.id, blocked: true }),
  });
  assert.equal(resBlock.status, 200);
  assert.deepEqual(await resBlock.json(), { ok: true, id: MODEL_A.id, blocked: true, blockedModels: [MODEL_A.id] });

  const resCheck = await fetch(`${base}/api/opencode/check`, { method: 'POST', headers, body: '{}' });
  assert.equal(resCheck.status, 200);
  assert.equal(checkCount, 1);

  const resState = await fetch(`${base}/api/state`, { headers: { 'x-oc-token': ui.token } });
  const state = await resState.json();
  assert.equal(state.opencode.installed, true);
  assert.deepEqual(state.blockedModels, [MODEL_A.id]);
});
