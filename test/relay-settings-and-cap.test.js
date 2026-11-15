/**
 * 客户端上下文上限保护、受控本机 OpenCode 登录态复用、客户端版本指纹及面板 UI 接线测试：
 *   1. settings.js 默认 targetContextCap=128000 / shareOpencodeAuth=false 与边界校验；
 *   2. Bridge 对未单设上限的大窗口模型（如 400k）在写入目标前收紧到 targetContextCap，保留显式 contextWindowOverride 与展示值，填 0 取消上限；
 *   3. opencode-auth.js 只提取与同步 auth.json 里的 `opencode` 条目，绝不泄漏 openai/anthropic 等第三方付费 Key，禁用即清理；
 *   4. zen-impersonate.js 客户端版本升级到 2.2.7（OPENCODE_USER_AGENT === 'opencode/latest/2.2.7/cli'）；
 *   5. desktop/index.html / style.css / renderer.js / webui.js 冷却标签、上下文上限输入框与登录态共享开关接线。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

import {
  readSettings,
  sanitizeTargetContextCap,
  writeSettings,
} from '../src/settings.js';
import {
  extractOpencodeBearerKey,
  readNativeOpencodeAuth,
  syncIsolatedOpencodeAuth,
} from '../src/opencode-auth.js';
import { OcClient } from '../src/oc-client.js';
import { OPENCODE_USER_AGENT, OPENCODE_VERSION } from '../src/zen-impersonate.js';
import { Bridge } from '../src/main.js';

function isolateDataDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'oc-cap-auth-'));
  const prev = process.env.OCF_DATA_DIR;
  process.env.OCF_DATA_DIR = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.OCF_DATA_DIR;
    else process.env.OCF_DATA_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('settings：targetContextCap 默认 128000、支持 0/null 关闭、shareOpencodeAuth 默认 false', async (t) => {
  isolateDataDir(t);

  assert.equal(sanitizeTargetContextCap(0), null);
  assert.equal(sanitizeTargetContextCap(null), null);
  assert.equal(sanitizeTargetContextCap(65536), 65536);
  assert.equal(sanitizeTargetContextCap(512, 128000), 128000);
  assert.equal(sanitizeTargetContextCap(99_999_999, 128000), 128000);

  const initial = await readSettings();
  assert.equal(initial.targetContextCap, 128000);
  assert.equal(initial.shareOpencodeAuth, false);

  const updated = await writeSettings({ targetContextCap: 65536, shareOpencodeAuth: true });
  assert.equal(updated.targetContextCap, 65536);
  assert.equal(updated.shareOpencodeAuth, true);

  const disabled = await writeSettings({ targetContextCap: 0 });
  assert.equal(disabled.targetContextCap, null);
});

test('Bridge targetContextCap：同步写入目标时默认封顶 128k，保留显式 contextWindowOverride，填 0 放开', async (t) => {
  isolateDataDir(t);

  const installedBatches = [];
  const fakeTarget = {
    id: 'fake-cap-target',
    label: '假目标',
    selectsModels: false,
    detect: () => true,
    status: async () => ({ written: installedBatches.length > 0, models: [] }),
    install: async (models) => {
      installedBatches.push(models.map((m) => ({ id: m.id, contextWindow: m.contextWindow })));
      return { changed: true, added: models.length };
    },
    uninstall: async () => ({ removed: 0, changed: false }),
  };

  const bigModel = {
    id: 'opencode/big-context-free',
    providerID: 'opencode',
    modelID: 'big-context-free',
    name: 'Big Context Free',
    free: true,
    reasoning: false,
    images: false,
    contextWindow: 400_000,
    contextLimitDefault: 400_000,
    outputLimit: 16_000,
  };
  const overrideModel = {
    id: 'opencode/custom-override-free',
    providerID: 'opencode',
    modelID: 'custom-override-free',
    name: 'Custom Override Free',
    free: true,
    reasoning: false,
    images: false,
    contextWindow: 256_000,
    contextWindowOverride: 256_000,
    contextLimitDefault: 200_000,
    outputLimit: 16_000,
  };

  const bridge = new Bridge({ log: () => {}, targets: [fakeTarget] });
  bridge.port = 41982;
  bridge.apiKey = 'oc-test-key';
  bridge.state.models = [bigModel, overrideModel];
  bridge.state.verdicts.set(bigModel.id, { verdict: 'tool', note: '' });
  bridge.state.verdicts.set(overrideModel.id, { verdict: 'tool', note: '' });

  await bridge.installTarget('fake-cap-target');
  assert.deepEqual(installedBatches[0], [
    { id: 'opencode/big-context-free', contextWindow: 128_000 },
    { id: 'opencode/custom-override-free', contextWindow: 256_000 },
  ]);

  // 面板快照仍展示原始上游上限 400_000，不被截断误导
  assert.equal(bridge.snapshot().models.find((m) => m.id === bigModel.id).contextWindow, 400_000);

  // 关闭上限限制后重装，拿到全量 400_000
  await bridge.saveSettings({ targetContextCap: 0 });
  await bridge.installTarget('fake-cap-target');
  assert.deepEqual(installedBatches[1], [
    { id: 'opencode/big-context-free', contextWindow: 400_000 },
    { id: 'opencode/custom-override-free', contextWindow: 256_000 },
  ]);
});

test('opencode-auth：严格仅复制 opencode 登录条目，绝不泄漏第三方 Key，关闭即清理', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-auth-sync-'));
  const nativeAuth = join(dir, 'native-auth.json');
  const runtimeRoot = join(dir, 'isolated-runtime');
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(nativeAuth, JSON.stringify({
    opencode: { type: 'api', key: 'zen-account-token' },
    openai: { type: 'api', key: 'sk-openai-paid-secret' },
    anthropic: { type: 'api', key: 'sk-ant-paid-secret' },
  }));
  await chmod(nativeAuth, 0o600);

  const nativeOptions = { env: { OCF_NATIVE_OPENCODE_AUTH: nativeAuth } };
  const entry = await readNativeOpencodeAuth(nativeOptions);
  assert.deepEqual(entry, { type: 'api', key: 'zen-account-token' });
  assert.equal(extractOpencodeBearerKey(entry), 'zen-account-token');

  // 默认情况下 OcClient 保持 shareOpencodeAuth === false
  const oc = new OcClient({ dataDir: dir });
  assert.equal(oc.shareOpencodeAuth, false);

  // 显式启用同步：只允许出现 opencode 字段
  const on = await syncIsolatedOpencodeAuth({ runtimeRoot, enabled: true, nativeOptions });
  assert.deepEqual(on, { synced: true, hasAuth: true });
  const isolatedFile = join(runtimeRoot, 'data', 'opencode', 'auth.json');
  assert.equal(existsSync(isolatedFile), true);
  const syncedObj = JSON.parse(await readFile(isolatedFile, 'utf8'));
  assert.deepEqual(syncedObj, { opencode: { type: 'api', key: 'zen-account-token' } });
  assert.equal(syncedObj.openai, undefined);
  assert.equal(syncedObj.anthropic, undefined);

  // 关闭同步后清出托管的 auth.json
  const off = await syncIsolatedOpencodeAuth({ runtimeRoot, enabled: false, nativeOptions });
  assert.deepEqual(off, { synced: false, hasAuth: false });
  assert.equal(existsSync(isolatedFile), false);
});

test('zen-impersonate：默认 OpenCode 版本指纹同步为 2.2.7 desktop', () => {
  assert.equal(OPENCODE_VERSION, '2.2.7');
  assert.equal(OPENCODE_USER_AGENT, 'opencode/latest/2.2.7/desktop');
});

test('面板与 Web 控制台：冷却标签、上下文上限设置与登录态开关 UI/校验正确且不破坏原保存契约', async () => {
  const html = readFileSync(new URL('../desktop/index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../desktop/style.css', import.meta.url), 'utf8');
  const webui = readFileSync(new URL('../src/webui.js', import.meta.url), 'utf8');

  for (const id of ['cfg-context-cap', 'cfg-cap-save', 'cfg-share-auth']) {
    assert.ok(html.includes(`id="${id}"`), `desktop/index.html 缺少元素 #${id}`);
  }
  assert.match(css, /\.settings \+ \.settings\s*\{/);
  assert.match(css, /\.tag-cool\s*\{/);
  // 检查 CSS 大括号成对，不存在残留断行
  const opens = (css.match(/\{/g) || []).length;
  const closes = (css.match(/\}/g) || []).length;
  assert.equal(opens, closes, `desktop/style.css 大括号未闭合：open=${opens} close=${closes}`);
  assert.match(webui, /targetContextCap/);
  assert.match(webui, /shareOpencodeAuth/);

  // 运行 renderer.js 轻量沙箱验证 UI 渲染与动作逻辑
  const elements = new Map();
  class Node {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.dataset = {};
      this.style = {};
      this.attributes = new Map();
      this.listeners = new Map();
      this.hidden = false;
      this.disabled = false;
      this.checked = false;
      this.open = false;
      this.value = '';
      this.title = '';
      this._text = '';
      this._className = '';
      this.classList = {
        add: (...names) => {
          const s = new Set(this._className.split(/\s+/).filter(Boolean));
          names.forEach((n) => s.add(n));
          this._className = [...s].join(' ');
        },
        remove: (...names) => {
          const drop = new Set(names);
          this._className = this._className.split(/\s+/).filter((n) => n && !drop.has(n)).join(' ');
        },
        contains: (name) => this._className.split(/\s+/).includes(name),
      };
    }
    set className(v) { this._className = String(v ?? ''); }
    get className() { return this._className; }
    set textContent(v) { this._text = String(v ?? ''); }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    get childElementCount() { return this.children.length; }
    setAttribute(k, v) { this.attributes.set(k, String(v)); }
    getAttribute(k) { return this.attributes.get(k) ?? null; }
    hasAttribute(k) { return this.attributes.has(k); }
    removeAttribute(k) { this.attributes.delete(k); }
    showModal() { this.open = true; }
    close() { this.open = false; }
    focus() {}
    append(...nodes) {
      for (const n of nodes) {
        if (n && typeof n === 'object') {
          if (n.tagName === '#FRAGMENT') this.children.push(...n.children);
          else this.children.push(n);
        }
      }
    }
    replaceChildren(...nodes) {
      this.children = [];
      this.append(...nodes);
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    dispatch(type, extra = {}) {
      const ev = { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...extra };
      return (this.listeners.get(type) ?? []).map((fn) => fn(ev));
    }
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => {
        for (const c of n.children) {
          if (sel.startsWith('.') && c.classList.contains(sel.slice(1))) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    }
  }

  const document = {
    body: new Node('body'),
    documentElement: new Node('html'),
    createElement: (tag) => new Node(tag),
    createElementNS: (_ns, tag) => new Node(tag),
    createDocumentFragment: () => new Node('#fragment'),
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Node('div'));
      return elements.get(id);
    },
    addEventListener() {},
    querySelectorAll: () => [],
  };

  let confirmAnswer = false;
  const savedPatches = [];
  let settingsState = {
    probeConcurrency: 3,
    probeTtlMinutes: 360,
    targetContextCap: 128000,
    shareOpencodeAuth: false,
  };
  let snapshotState = {
    phase: 'ready',
    mode: 'embedded',
    lanAccess: false,
    error: null,
    models: [
      {
        id: 'opencode/cooled-model',
        name: 'Cooled Model',
        verdict: 'tool',
        reasoning: false,
        images: false,
        cooldownUntil: Date.now() + 9 * 60_000,
        cooldownReason: 'FreeUsageLimitError',
      },
    ],
    hiddenModels: [],
    blockedModels: [],
    targets: [],
  };

  const window = {
    confirm: () => confirmAnswer,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    oc: {
      panelShell: 'desktop',
      onState() {},
      getState: async () => structuredClone(snapshotState),
      getSettings: async () => structuredClone(settingsState),
      saveSettings: async (patch) => {
        savedPatches.push(structuredClone(patch));
        settingsState = { ...settingsState, ...patch };
        return structuredClone(settingsState);
      },
      getApiKey: async () => ({ key: 'oc-key' }),
      getUpdateState: async () => ({ status: 'idle', currentVersion: '1.0.4' }),
      onUpdateState() {},
    },
  };

  const rendererCode = readFileSync(new URL('../desktop/renderer.js', import.meta.url), 'utf8');
  const ctx = vm.createContext({
    document,
    window,
    navigator: {},
    location: { search: '' },
    history: {},
    localStorage: {},
    URL,
    URLSearchParams,
    Date,
    console,
    setTimeout: () => 1,
    clearTimeout: () => {},
    globalThis: null,
  });
  ctx.globalThis = ctx;
  vm.runInContext(
    `${rendererCode}\nglobalThis.__uiTest = { wire, loadSettings, saveSettings, saveContextCap, toggleShareAuth, receiveSnapshot };`,
    ctx,
    { filename: 'desktop/renderer.js' },
  );

  const ui = ctx.__uiTest;
  ui.wire();
  ui.receiveSnapshot(structuredClone(snapshotState));

  // 模型列表渲染 .tag-cool 冷却提示
  const coolBadges = document.getElementById('rows').querySelectorAll('.tag-cool');
  assert.equal(coolBadges.length, 1);
  assert.match(coolBadges[0].textContent, /冷却 \d+ 分/);

  // loadSettings 回填 cfg-context-cap 和 cfg-share-auth
  await ui.loadSettings();
  assert.equal(document.getElementById('cfg-context-cap').value, 128000);
  assert.equal(document.getElementById('cfg-share-auth').checked, false);

  // saveContextCap：非法值 500 标红且不调接口；合法值 65536 与 0 (-> null) 保存成功
  document.getElementById('cfg-context-cap').value = '500';
  await ui.saveContextCap();
  assert.equal(document.getElementById('cfg-context-cap').getAttribute('aria-invalid'), 'true');
  assert.equal(savedPatches.length, 0);

  document.getElementById('cfg-context-cap').value = '65536';
  await document.getElementById('cfg-cap-save').dispatch('click')[0];
  assert.deepEqual(savedPatches.at(-1), { targetContextCap: 65536 });

  document.getElementById('cfg-context-cap').value = '0';
  await document.getElementById('cfg-cap-save').dispatch('click')[0];
  assert.deepEqual(savedPatches.at(-1), { targetContextCap: null });

  // toggleShareAuth：取消确认自动回弹 checkbox 且不发请求；确认则保存 shareOpencodeAuth: true
  const patchCountBeforeShare = savedPatches.length;
  confirmAnswer = false;
  document.getElementById('cfg-share-auth').checked = true;
  await document.getElementById('cfg-share-auth').dispatch('change')[0];
  assert.equal(document.getElementById('cfg-share-auth').checked, false);
  assert.equal(savedPatches.length, patchCountBeforeShare);

  confirmAnswer = true;
  document.getElementById('cfg-share-auth').checked = true;
  await document.getElementById('cfg-share-auth').dispatch('change')[0];
  assert.equal(document.getElementById('cfg-share-auth').checked, true);
  assert.deepEqual(savedPatches.at(-1), { shareOpencodeAuth: true });

  // 原并发/有效期保存按钮仍只发 { probeConcurrency, probeTtlMinutes }
  document.getElementById('cfg-concurrency').value = '4';
  document.getElementById('cfg-ttl').value = '60';
  await ui.saveSettings();
  assert.deepEqual(savedPatches.at(-1), { probeConcurrency: 4, probeTtlMinutes: 60 });
});
