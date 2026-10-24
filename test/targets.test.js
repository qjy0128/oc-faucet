/**
 * 「接入目标」抽象（src/targets.js）与 ZCode 适配器（src/target-zcode.js）的测试。
 *
 * 接缝沿用 zcode-config.test.js 的打法：临时目录 + OCF_ZCODE_CONFIG 环境变量
 * 把配置路径指过去，断言落盘文件的真实内容，绝不碰用户真实的 ~/.zcode。
 * zcode-config 的所有路径都是调用时现读环境变量，所以这里不用查询串绕模块缓存。
 * 内置清单指向不存在的路径：读不到就跳过禁用，测试不依赖本机装没装 ZCode。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTargets } from '../src/targets.js';
import { createZcodeTarget } from '../src/target-zcode.js';
import { Bridge } from '../src/main.js';

/**
 * 每个测试一个临时目录；所有默认目标的路径都指向这里，结束后还原并清理。
 * @returns {Promise<{dir:string, file:string}>}
 */
async function withTempZcode(t, initial) {
  const dir = await mkdtemp(join(tmpdir(), 'oc-targets-'));
  const file = join(dir, 'provider_config.json');
  if (initial !== undefined) {
    await writeFile(file, typeof initial === 'string' ? initial : JSON.stringify(initial, null, 2));
  }
  const targets = join(dir, 'targets');
  const isolated = {
    OCF_ZCODE_CONFIG: file,
    OCF_ZCODE_BUILTIN: join(dir, 'no-such-builtin.json'),
    OCF_ZCODE_RUNTIME: join(dir, 'no-such-runtime'),
    OCF_DSH_PATCH: join(targets, 'dsh', 'cordis.patch.yml'),
    OCF_QODER_SETTINGS: join(targets, 'qoder', 'settings.json'),
    OCF_QODERCN_SETTINGS: join(targets, 'qoder-cn', 'settings.json'),
    OCF_WORKBUDDY_MODELS: join(targets, 'workbuddy', 'models.json'),
    OCF_CODEBUDDY_MODELS: join(targets, 'codebuddy', 'models.json'),
    PI_CODING_AGENT_DIR: join(targets, 'pi', 'agent'),
    OCF_KIMI_CONFIG: join(targets, 'kimi', 'config.toml'),
    OCF_CLAUDE_SETTINGS: join(targets, 'claude', 'settings.json'),
    OCF_CLAUDE_OWNER: join(targets, 'claude', 'owner.json'),
    OCF_CODEX_CONFIG: join(targets, 'codex', 'config.toml'),
    OCF_CODEX_CATALOG: join(targets, 'codex', 'models.json'),
    OCF_CODEX_OWNER: join(targets, 'codex', 'owner.json'),
  };
  const saved = Object.fromEntries(Object.keys(isolated).map((key) => [key, process.env[key]]));
  Object.assign(process.env, isolated);
  t.after(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, file };
}

/** 用户手写的那条供应商：我们的动作一个字段都不许碰它 */
const userProvider = {
  providerId: 'deepseek',
  templateId: 'deepseek',
  providerName: 'DeepSeek',
  config: { group: 'standard-personal', access: { type: 'api-key', apiKey: 'sk-user-handwritten' } },
};

const baseConfig = {
  schemaVersion: 1,
  config: {
    providerOrder: ['deepseek'],
    providerConfigRules: { providerRules: [userProvider] },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
  },
};

const MODELS = [
  { id: 'opencode/deepseek-v4.1-flash-free', name: 'deepseek-v4.1-flash-free' },
  { id: 'opencode/glm-5.3-flash-free', name: 'glm-5.3-flash-free' },
];

/* ------------------------------------------------------------------ */
/* 注册表                                                                */
/* ------------------------------------------------------------------ */

test('注册表：默认收编十个目标，目标实现同一组接口', () => {
  const targets = createTargets();
  assert.deepEqual(targets.map((x) => x.id), [
    'zcode', 'dsh', 'qoder', 'qoder-cn', 'workbuddy', 'codebuddy', 'pi', 'kimi', 'claude', 'codex',
  ]);
  for (const target of targets) {
    assert.ok(target.label, `${target.id} 要有显示名`);
    for (const fn of ['detect', 'status', 'install', 'uninstall']) {
      assert.equal(typeof target[fn], 'function', `${target.id} 必须实现 ${fn}()`);
    }
  }
});

test('注册表：overrides 按 id 换掉默认实现（测试塞假目标用的缝）', () => {
  const fake = {
    id: 'zcode',
    label: '假的',
    detect: () => false,
    status: async () => ({ written: false, models: [] }),
    install: async () => ({}),
    uninstall: async () => ({}),
  };
  const [target] = createTargets({ zcode: fake });
  assert.equal(target, fake);
});

/* ------------------------------------------------------------------ */
/* ZCode 适配器                                                          */
/* ------------------------------------------------------------------ */

test('detect：配置文件在、或配置目录在，都算检测到了 ZCode', async (t) => {
  const { file } = await withTempZcode(t, baseConfig);
  const target = createZcodeTarget();
  assert.equal(target.detect(), true, '配置文件在');
  await rm(file);
  assert.equal(target.detect(), true, '文件没了但配置目录还在，也算装过');
});

test('detect：配置目录和文件都不在，才算没检测到', async (t) => {
  const { dir } = await withTempZcode(t, undefined);
  process.env.OCF_ZCODE_CONFIG = join(dir, 'nope', 'provider_config.json');
  const target = createZcodeTarget();
  assert.equal(target.detect(), false);
});

test('status：以配置文件的真实内容为准，不信内存缓存', async (t) => {
  const { file } = await withTempZcode(t, baseConfig);
  const target = createZcodeTarget();

  assert.deepEqual(await target.status(), { written: false, models: [] });

  // 外部（用户手动、或上一次进程写的）把文件改了，status 必须如实反映
  const withRule = structuredClone(baseConfig);
  withRule.config.providerConfigRules.providerRules.push({
    providerId: 'oc-faucet',
    templateId: 'anthropic',
    providerName: 'OC Faucet（OpenCode）',
    enabled: true,
    config: {
      group: 'standard-personal',
      access: { type: 'api-key', apiKey: 'k' },
      api: { type: 'anthropic-messages', baseUrl: 'http://127.0.0.1:41982' },
      personalModelIds: ['opencode/a', 'opencode/b'],
      modelOrder: ['opencode/a', 'opencode/b'],
    },
  });
  await writeFile(file, JSON.stringify(withRule, null, 2));
  assert.deepEqual(await target.status(), { written: true, models: ['opencode/a', 'opencode/b'] });

  // 再改回去（比如崩溃后用户自己清理了），也必须如实反映
  await writeFile(file, JSON.stringify(baseConfig, null, 2));
  assert.deepEqual(await target.status(), { written: false, models: [] });
});

test('install：薄封装 zcode-config，落盘内容和返回形状都不变', async (t) => {
  const { file } = await withTempZcode(t, baseConfig);
  const target = createZcodeTarget();

  const result = await target.install(MODELS, { port: 41982, apiKey: 'oc-secret' });
  assert.equal(result.changed, true);
  assert.equal(result.added, 2);

  const saved = JSON.parse(await readFile(file, 'utf8'));
  const rules = saved.config.providerConfigRules.providerRules;
  const mine = rules.find((r) => r.providerId === 'oc-faucet');
  assert.equal(mine.config.api.baseUrl, 'http://127.0.0.1:41982');
  assert.equal(mine.config.access.apiKey, 'oc-secret');
  assert.deepEqual(mine.config.personalModelIds, MODELS.map((m) => m.id));
  assert.deepEqual(rules.find((r) => r.providerId === 'deepseek'), userProvider, '用户手写的一条不动');

  assert.deepEqual(await target.status(), { written: true, models: MODELS.map((m) => m.id) });
});

test('uninstall：只摘自己那一条；没装过是安全空操作', async (t) => {
  const { file } = await withTempZcode(t, baseConfig);
  const target = createZcodeTarget();

  const noop = await target.uninstall();
  assert.deepEqual(noop, { removed: 0, changed: false });

  await target.install(MODELS, { port: 41982, apiKey: 'oc-secret' });
  const result = await target.uninstall();
  assert.equal(result.removed, 1);
  assert.equal(result.changed, true);

  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(saved.config.providerConfigRules.providerRules, [userProvider]);
  assert.deepEqual(await target.status(), { written: false, models: [] });
});

/* ------------------------------------------------------------------ */
/* 桥（Bridge）的目标注册表行为                                          */
/* 打法参照 main-restore.test.js：不起真实进程，直接造一个状态齐备的桥。   */
/* ------------------------------------------------------------------ */

const BRIDGE_MODEL = {
  id: 'opencode/good-one',
  providerID: 'opencode',
  modelID: 'good-one',
  name: '能用的',
  free: true,
  reasoning: false,
  variants: {},
  images: false,
  contextWindow: null,
  deprecated: false,
};

/** 造一个不用启动的桥：直接塞好端口、密钥和一个体检通过的模型 */
function bridgeReady(options = {}) {
  const bridge = new Bridge({ log: () => {}, ...options });
  bridge.state.port = 41982;
  bridge.state.apiKey = 'oc-test-key';
  bridge.state.models = [BRIDGE_MODEL];
  bridge.state.verdicts.set(BRIDGE_MODEL.id, { verdict: 'tool', note: '', checkedAt: Date.now(), cached: false });
  return bridge;
}

test('桥：import() 委托注册表里的 zcode 目标，旧 zcode 字段原样保留', async (t) => {
  await withTempZcode(t, baseConfig);
  const bridge = bridgeReady();

  const result = await bridge.import();
  assert.equal(result.changed, true);
  assert.equal(result.added, 1);

  const snap = bridge.snapshot();
  // 界面还在读旧字段，形状一个字都不能变
  assert.equal(snap.zcode.installed, true);
  assert.equal(snap.zcode.models, 1);
  assert.equal(snap.zcode.port, 41982);

  const z = snap.targets.find((x) => x.id === 'zcode');
  assert.deepEqual(z, { id: 'zcode', label: 'ZCode', detected: true, written: true, models: ['opencode/good-one'], selectsModels: false });

  await bridge.uninstall();
  const after = bridge.snapshot();
  assert.equal(after.zcode.installed, false);
  assert.equal(after.targets.find((x) => x.id === 'zcode').written, false);
});

test('桥：installTarget/uninstallTarget 按 id 找到目标干活', async (t) => {
  await withTempZcode(t, baseConfig);
  const bridge = bridgeReady();

  const result = await bridge.installTarget('zcode');
  assert.equal(result.changed, true);
  const states = await bridge.listTargetStates();
  assert.equal(states.find((x) => x.id === 'zcode').written, true);

  const removed = await bridge.uninstallTarget('zcode');
  assert.equal(removed.removed, 1);
  assert.equal((await bridge.listTargetStates()).find((x) => x.id === 'zcode').written, false);
});

test('桥：不认识的目标 id 要报人话，不能闷声炸', async () => {
  const bridge = bridgeReady();
  await assert.rejects(() => bridge.installTarget('not-a-target'), /接入目标/);
  await assert.rejects(() => bridge.uninstallTarget('not-a-target'), /接入目标/);
});

test('桥：listTargetStates 每次实读配置文件——外部改了就按新的报', async (t) => {
  const { file } = await withTempZcode(t, baseConfig);
  const bridge = bridgeReady();

  const before = await bridge.listTargetStates();
  assert.equal(before.find((x) => x.id === 'zcode').written, false);

  await bridge.installTarget('zcode');
  // 模拟崩溃之后外部把配置清了：不经过桥，直接改文件
  await writeFile(file, JSON.stringify(baseConfig, null, 2));

  const after = await bridge.listTargetStates();
  assert.equal(after.find((x) => x.id === 'zcode').written, false, '必须以文件真实内容为准');
  assert.equal(
    bridge.snapshot().targets.find((x) => x.id === 'zcode').written,
    false,
    '快照跟着最近一次实读走',
  );
});

test('桥：注册表是通用的——注入假目标也能被 installTarget 调到', async () => {
  const calls = [];
  const fake = {
    id: 'fake-one',
    label: '假目标',
    detect: () => true,
    status: async () => ({ written: calls.length > 0, models: calls.flatMap((c) => c.models.map((m) => m.id)) }),
    install: async (models, opts) => {
      calls.push({ models, opts });
      return { changed: true, added: models.length };
    },
    uninstall: async () => ({ removed: 1, changed: true }),
  };
  const bridge = bridgeReady({ targets: [fake] });

  const result = await bridge.installTarget('fake-one');
  assert.equal(result.added, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.port, 41982);
  assert.equal(calls[0].opts.apiKey, 'oc-test-key');
  assert.deepEqual(calls[0].models.map((m) => m.id), ['opencode/good-one'], '写进去的应当是体检通过的那批');

  const states = await bridge.listTargetStates();
  assert.deepEqual(states, [
    { id: 'fake-one', label: '假目标', detected: true, written: true, models: ['opencode/good-one'], selectsModels: false },
  ]);
});

test('桥：还没读过目标状态时，快照里的 targets 也是数组（空）', () => {
  const bridge = new Bridge({ log: () => {} });
  assert.deepEqual(bridge.snapshot().targets, []);
});

/* ------------------------------------------------------------------ */
/* 按目标勾选模型（Claude Code / Codex 用）                              */
/* ------------------------------------------------------------------ */

/** 一个支持勾选的假目标 + 两个体检通过的模型 */
function selectionBridge(t, calls) {
  const dir = mkdtempSync(join(tmpdir(), 'oc-select-'));
  const savedDataDir = process.env.OCF_DATA_DIR;
  process.env.OCF_DATA_DIR = dir;
  t.after(() => {
    if (savedDataDir === undefined) delete process.env.OCF_DATA_DIR;
    else process.env.OCF_DATA_DIR = savedDataDir;
    rmSync(dir, { recursive: true, force: true });
  });

  const fake = {
    id: 'fake-pick',
    label: '可勾选的目标',
    selectsModels: true,
    detect: () => true,
    status: async () => ({ written: calls.length > 0, models: [...calls] }),
    install: async (models) => {
      calls.length = 0;
      calls.push(...models.map((model) => model.id));
      return { changed: true, added: models.length };
    },
    uninstall: async () => ({ removed: 1, changed: true }),
  };
  const bridge = bridgeReady({ targets: [fake] });
  const second = { ...BRIDGE_MODEL, id: 'opencode/good-two', modelID: 'good-two', name: '第二个' };
  bridge.state.models = [BRIDGE_MODEL, second];
  bridge.state.verdicts.set(second.id, { verdict: 'tool', note: '', checkedAt: Date.now(), cached: false });
  return { bridge, fake };
}

test('勾选目标：只写勾中的那几个，并且把选择记住', async (t) => {
  const { bridge, fake } = selectionBridge(t, []);
  void fake;

  const first = await bridge.installTarget('fake-pick', { modelIds: ['opencode/good-two'] });
  assert.equal(first.added, 1);
  assert.deepEqual(await bridge.installTarget('fake-pick').then(() => bridge.listTargetStates()), [
    { id: 'fake-pick', label: '可勾选的目标', detected: true, written: true, models: ['opencode/good-two'], selectsModels: true },
  ]);

  // 不传 modelIds（改密钥、改上下文之后的重写）应当沿用上次勾选，不偷偷扩大范围
  const calls = [];
  bridge.targets = [{ ...bridge.targets[0], install: async (models) => { calls.push(models.map((m) => m.id)); return { changed: true, added: models.length }; } }];
  await bridge.installTarget('fake-pick');
  assert.deepEqual(calls[0], ['opencode/good-two']);
});

test('勾选目标：一个都没勾中要报错；没勾过的目标写全部可用模型', async (t) => {
  const { bridge } = selectionBridge(t, []);
  await assert.rejects(
    () => bridge.installTarget('fake-pick', { modelIds: ['opencode/不存在'] }),
    /至少要选一个可用模型/,
  );

  const calls = [];
  bridge.targets = [{ ...bridge.targets[0], install: async (models) => { calls.push(models.map((m) => m.id)); return { changed: true, added: models.length }; } }];
  await bridge.installTarget('fake-pick');
  assert.deepEqual(calls[0], ['opencode/good-one', 'opencode/good-two']);
});

test('不支持勾选的目标照旧写全部可用模型', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-noselect-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const fake = {
    id: 'fake-all',
    label: '不勾选的目标',
    detect: () => true,
    status: async () => ({ written: false, models: [] }),
    install: async (models) => {
      calls.push(models.map((model) => model.id));
      return { changed: true, added: models.length };
    },
    uninstall: async () => ({ removed: 1, changed: true }),
  };
  const bridge = bridgeReady({ targets: [fake] });
  await bridge.installTarget('fake-all', { modelIds: ['opencode/good-one'] });
  assert.deepEqual(calls[0], ['opencode/good-one'], '没开勾选的目标不受选择影响');
});
