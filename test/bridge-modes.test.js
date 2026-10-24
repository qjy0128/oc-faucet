/**
 * Bridge 的双方案（内嵌 ⇄ 伪装）接线测试：模式校验、忙拒、热切换、失败回滚、
 * 体检缓存按方案分指纹。全部用假客户端（构造缝 makeClient），不触网不起进程。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Bridge } from '../src/main.js';
import { PROBE_FINGERPRINT } from '../src/probe.js';
import * as settings from '../src/settings.js';

/** 假上游客户端：记录生命周期，目录里放一个本方案专属的免费模型 */
function fakeClient(label) {
  const events = [];
  return {
    label,
    events,
    ready: true,
    isolate: label !== 'masquerade',
    baseUrl: `fake://${label}`,
    async start() {
      this.ready = true;
      events.push('start');
    },
    async stop() {
      this.ready = false;
      events.push('stop');
    },
    async providers() {
      return {
        providers: [{
          id: 'opencode',
          models: {
            [`${label}-free`]: {
              name: `${label} 模型`,
              cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
              limit: { context: 1000, output: 100 },
            },
          },
        }],
      };
    },
    async createSession() { return `ses_fake_${label}`; },
    async prompt(o) {
      events.push(['prompt', o]);
      return { text: '{"content":"ok","calls":[]}', tokens: null, handoff: null };
    },
    async deleteSession() {},
  };
}

/** 造一个带客户端工厂缝的 Bridge；目录与设置都进临时目录 */
async function bridgeWithClients({ masqueradeStartError } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'oc-bridge-modes-'));
  const previousDataDir = process.env.OCF_DATA_DIR;
  process.env.OCF_DATA_DIR = dir;
  await settings.ensureLayout();
  const created = [];
  const bridge = new Bridge({
    log: () => {},
    targets: [],
    makeClient: (mode) => {
      if (mode === 'masquerade' && masqueradeStartError) {
        const bad = fakeClient('masquerade');
        bad.start = async () => {
          throw masqueradeStartError;
        };
        created.push(bad);
        return bad;
      }
      const client = fakeClient(mode);
      created.push(client);
      return client;
    },
  });
  return {
    bridge,
    created,
    restore: async () => {
      if (previousDataDir === undefined) delete process.env.OCF_DATA_DIR;
      else process.env.OCF_DATA_DIR = previousDataDir;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** 把桥拉到「内嵌方案在跑」的状态 */
async function runningEmbedded() {
  const ctx = await bridgeWithClients();
  await bridgeWithClientsStart(ctx.bridge);
  return ctx;
}

async function bridgeWithClientsStart(bridge) {
  // 不走 bridge.start()（那会碰真实目录与端口），手动走同样的构造路径
  bridge.state.mode = 'embedded';
  bridge.client = fakeClient('embedded');
  await bridge.client.start();
  bridge.state.phase = 'ready';
  bridge.state.upstream = { ready: true, baseUrl: bridge.client.baseUrl };
  await bridge.refresh();
  return bridge;
}

test('setUpstreamMode：不认识的名字直接 400', async (t) => {
  const ctx = await bridgeWithClients();
  t.after(ctx.restore);
  await assert.rejects(
    () => ctx.bridge.setUpstreamMode('随机方案'),
    (error) => error.code === 'invalid_upstream_mode',
  );
});

test('setUpstreamMode：有请求在跑时 409 忙拒，什么都没动', async (t) => {
  const ctx = await runningEmbedded();
  t.after(ctx.restore);
  ctx.bridge.activePromptCount = 1;
  await assert.rejects(
    () => ctx.bridge.setUpstreamMode('masquerade'),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, 'upstream_mode_busy');
      return true;
    },
  );
  assert.equal(ctx.bridge.state.mode, 'embedded');
  assert.equal((await settings.readSettings()).upstreamMode, 'embedded');
});

test('setUpstreamMode：服务没在跑时只落盘，状态跟着走', async (t) => {
  const ctx = await bridgeWithClients();
  t.after(ctx.restore);
  const result = await ctx.bridge.setUpstreamMode('masquerade');
  assert.deepEqual(result, { ok: true, mode: 'masquerade', changed: true });
  assert.equal((await settings.readSettings()).upstreamMode, 'masquerade');
  assert.equal(ctx.bridge.snapshot().mode, 'masquerade', '快照要带方案字段');
});

test('setUpstreamMode：热切换——新的先起、旧的再停、目录刷新、判定按方案恢复', async (t) => {
  const ctx = await runningEmbedded();
  t.after(ctx.restore);

  // 给内嵌方案的模型写一条真缓存结论（restore 会重建缓存对象，假的会被换掉）
  await ctx.bridge.cache.set('opencode/embedded-free', PROBE_FINGERPRINT, 'tool', '能按协议产生工具调用');
  await ctx.bridge.restore();
  assert.equal(ctx.bridge.getModels().length, 1, '内嵌方案的判定先恢复出来');

  const result = await ctx.bridge.setUpstreamMode('masquerade');
  assert.equal(result.changed, true);
  assert.equal(ctx.bridge.state.mode, 'masquerade');
  assert.equal(ctx.bridge.client.label, 'masquerade', '客户端换成伪装的');
  assert.equal(ctx.bridge.snapshot().mode, 'masquerade');
  // 目录换成伪装方案的模型；内嵌的判定不能串过来
  assert.ok(ctx.bridge.state.models.some((m) => m.modelID === 'masquerade-free'));
  assert.equal(ctx.bridge.getModels().length, 0, '伪装方案没有自己的判定，不能捡内嵌的用');
  // 再切回去：内嵌的判定从缓存回来了（两方案的结论互不串用）
  await ctx.bridge.setUpstreamMode('embedded');
  assert.equal(ctx.bridge.client.label, 'embedded');
  assert.equal(ctx.bridge.getModels().length, 1, '切回内嵌后判定按本方案指纹恢复');
});

test('setUpstreamMode：新方案起不来时原地回滚（设置、客户端、判定都不动）', async (t) => {
  const ctx = await runningEmbedded();
  t.after(ctx.restore);
  ctx.bridge.cache = { async load() {}, get: () => null, async set() {} };
  await ctx.bridge.restore();

  const failing = await bridgeWithClients({ masqueradeStartError: new Error('zen 连不上') });
  t.after(failing.restore);
  await bridgeWithClientsStart(failing.bridge);
  failing.bridge.cache = ctx.bridge.cache;

  await assert.rejects(
    () => failing.bridge.setUpstreamMode('masquerade'),
    (error) => {
      assert.equal(error.code, 'upstream_mode_switch_failed');
      assert.match(error.message, /已退回/);
      return true;
    },
  );
  assert.equal(failing.bridge.state.mode, 'embedded', '方案退回内嵌');
  assert.equal(failing.bridge.client.label, 'embedded', '客户端还是原来那只');
  assert.equal(failing.bridge.client.ready, true, '原客户端没被停');
  assert.equal((await settings.readSettings()).upstreamMode, 'embedded', '设置也退回去');
});

test('体检：伪装方案走 -zen 指纹写缓存，内嵌走基础指纹', async (t) => {
  const ctx = await runningEmbedded();
  t.after(ctx.restore);
  await ctx.bridge.probe({ limit: 1 });
  let onDisk = JSON.parse(await readFile(settings.probeCacheFile(), 'utf8'));
  assert.equal(onDisk.entries['opencode/embedded-free'].fingerprint, PROBE_FINGERPRINT, '内嵌用基础指纹');

  await ctx.bridge.setUpstreamMode('masquerade');
  await ctx.bridge.probe({ limit: 1 });
  onDisk = JSON.parse(await readFile(settings.probeCacheFile(), 'utf8'));
  assert.equal(onDisk.entries['opencode/masquerade-free'].fingerprint, `${PROBE_FINGERPRINT}-zen`, '伪装用 -zen 后缀');
});

test('probe(onlyFailed)：只重测失败的那批，成功的吃缓存不动', async (t) => {
  const ctx = await runningEmbedded();
  t.after(ctx.restore);
  // 给 embedded-free 塞一条失败判定（模拟"那一刻路由不到"）
  ctx.bridge.state.verdicts.set('opencode/embedded-free', { verdict: 'failed', note: 'HTTP 500', elapsedMs: 1, checkedAt: Date.now(), cached: false });
  const probed = [];
  const originalPrompt = ctx.bridge.client.prompt.bind(ctx.bridge.client);
  ctx.bridge.client.prompt = async (options) => {
    probed.push(options.modelID);
    return originalPrompt(options);
  };
  ctx.bridge.cache = { async load() {}, get: () => null, async set() {} };

  await ctx.bridge.probe({ onlyFailed: true });
  assert.deepEqual(probed, ['embedded-free'], '只发失败的那一个');
});
