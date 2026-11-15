/** 控制面板前端：模型屏蔽/隐藏区交互、各类报错自动消退、OpenCode 安装与运行提示测试。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

class FakeNode {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = document;
    this.children = [];
    this.parentNode = null;
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
    this._textContent = '';
    this._className = '';
    this.classList = {
      add: (...names) => {
        const set = new Set(this._className.split(/\s+/).filter(Boolean));
        for (const name of names) set.add(name);
        this._className = [...set].join(' ');
      },
      remove: (...names) => {
        const drop = new Set(names);
        this._className = this._className.split(/\s+/).filter((n) => n && !drop.has(n)).join(' ');
      },
      contains: (name) => this._className.split(/\s+/).includes(name),
    };
  }

  set className(value) { this._className = String(value ?? ''); }
  get className() { return this._className; }
  set textContent(value) { this._textContent = String(value ?? ''); }
  get textContent() { return this._textContent + this.children.map((c) => c.textContent).join(''); }
  get childElementCount() { return this.children.length; }

  setAttribute(name, value) {
    const str = String(value);
    this.attributes.set(name, str);
    if (name === 'open') this.open = true;
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === 'open') this.open = false;
  }

  showModal() { this.open = true; this.attributes.set('open', ''); }
  close() { this.open = false; this.attributes.delete('open'); }
  focus() {}
  setSelectionRange() {}

  append(...nodes) {
    for (const node of nodes) {
      if (node && typeof node === 'object') {
        node.parentNode = this;
        this.children.push(node);
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
  dispatch(type, event = {}) {
    const payload = {
      type,
      target: this,
      currentTarget: this,
      preventDefault() {},
      stopPropagation() {},
      ...event,
    };
    return (this.listeners.get(type) ?? []).map((fn) => fn(payload));
  }
  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (selector.startsWith('.')) {
          if (child.classList.contains(selector.slice(1))) out.push(child);
        } else if (child.tagName.toLowerCase() === selector.toLowerCase()) {
          out.push(child);
        }
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

function makeModel(id, overrides = {}) {
  return {
    id,
    name: id.replace(/^opencode\//, ''),
    providerID: 'opencode',
    modelID: id.replace(/^opencode\//, ''),
    free: true,
    reasoning: false,
    supportedEfforts: [],
    defaultEffort: null,
    images: false,
    upstreamContextWindow: 128000,
    contextWindowOverride: null,
    contextWindow: 128000,
    verdict: 'tool',
    elapsedMs: 120,
    cached: false,
    checkedAt: 1000,
    note: '',
    ...overrides,
  };
}

function bootPanel({ initialSnapshot, confirmResult = true } = {}) {
  const nodes = new Map();
  let state = initialSnapshot ?? {
    phase: 'ready',
    error: null,
    errorCode: null,
    upstream: { ready: true, baseUrl: 'http://127.0.0.1:4096' },
    mode: 'embedded',
    lanAccess: false,
    models: [makeModel('opencode/alpha'), makeModel('opencode/beta')],
    hiddenModels: [],
    blockedModels: [],
    targets: [{ id: 'zcode', label: 'ZCode', detected: true, written: false, selectsModels: false }],
  };
  let nextTimerId = 1;
  const timers = new Map();
  const blockCalls = [];
  let confirmCalls = 0;
  let opencodeCheckCalls = 0;
  let openInstallCalls = 0;
  let modeSwitchCalls = [];

  const document = {
    body: null,
    documentElement: null,
    activeElement: null,
    createElement(tag) { return new FakeNode(tag, document); },
    createElementNS(_ns, tag) { return new FakeNode(tag, document); },
    createDocumentFragment() { return new FakeNode('fragment', document); },
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, new FakeNode('div', document));
      return nodes.get(id);
    },
    addEventListener() {},
  };
  document.body = new FakeNode('body', document);
  document.documentElement = new FakeNode('html', document);

  const window = {
    confirmResult,
    confirm() {
      confirmCalls += 1;
      return window.confirmResult;
    },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    open: () => ({}),
    navigator: {},
    oc: {
      panelShell: 'desktop',
      onState() {},
      async getState() { return structuredClone(state); },
      async refresh() { return { models: state.models.length }; },
      async probe() { return { summary: { tool: state.models.length, chat: 0, failed: 0 }, total: state.models.length }; },
      async probeOne() { return { verdict: 'tool' }; },
      async installTarget() { return { added: 1, changed: true }; },
      async uninstallTarget() { return { removed: 1 }; },
      async setUpstreamMode(mode) {
        modeSwitchCalls.push(mode);
        state = { ...state, mode };
        return { ok: true, mode, requiresStart: false };
      },
      async setLanAccess(enable) {
        state = { ...state, lanAccess: enable };
        return { lanAccess: enable };
      },
      async restart() { return structuredClone(state); },
      async getSettings() { return { probeConcurrency: 3, probeTtlMinutes: 360 }; },
      async saveSettings(patch) { return patch; },
      async getApiKey() { return { key: 'sk-test' }; },
      async setModelBlocked(id, blocked) {
        blockCalls.push({ id, blocked });
        if (blocked) {
          const hit = state.models.find((m) => m.id === id || m.modelID === id);
          if (hit) {
            state = {
              ...state,
              models: state.models.filter((m) => m.id !== hit.id),
              hiddenModels: [...(state.hiddenModels ?? []), { ...hit, blocked: true, inCatalog: true }],
              blockedModels: [...new Set([...(state.blockedModels ?? []), id])],
            };
          } else {
            state = {
              ...state,
              hiddenModels: [...(state.hiddenModels ?? []), { id, name: id, inCatalog: false, blocked: true }],
              blockedModels: [...new Set([...(state.blockedModels ?? []), id])],
            };
          }
        } else {
          const hit = (state.hiddenModels ?? []).find((m) => m.id === id);
          if (hit && hit.inCatalog !== false) {
            const { blocked: _b, inCatalog: _c, ...rest } = hit;
            state = {
              ...state,
              models: [...state.models, rest],
              hiddenModels: state.hiddenModels.filter((m) => m.id !== id),
              blockedModels: (state.blockedModels ?? []).filter((r) => r !== id),
            };
          } else {
            state = {
              ...state,
              hiddenModels: (state.hiddenModels ?? []).filter((m) => m.id !== id),
              blockedModels: (state.blockedModels ?? []).filter((r) => r !== id),
            };
          }
        }
        return { ok: true, id, blocked, blockedModels: state.blockedModels };
      },
      async checkOpencodeEnv() {
        opencodeCheckCalls += 1;
        return state.opencode;
      },
      async openOpencodeInstall() {
        openInstallCalls += 1;
        return { url: 'https://opencode.ai', opened: true };
      },
      async getUpdateState() { return { status: 'idle', currentVersion: '1.0.4' }; },
      onUpdateState() {},
      async downloadUpdate() {},
      async checkForUpdates() { return { status: 'up-to-date', currentVersion: '1.0.4' }; },
      cancelUpdate() {},
      async openReleasePage() {},
      async showDownloadedFile() {},
    },
  };

  const renderer = readFileSync(new URL('../desktop/renderer.js', import.meta.url), 'utf8');
  const context = vm.createContext({
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
    setTimeout(cb) { const id = nextTimerId++; timers.set(id, cb); return id; },
    clearTimeout(id) { timers.delete(id); },
    globalThis: null,
  });
  context.globalThis = context;
  vm.runInContext(`${renderer}\nglobalThis.__panelTest = {
    wire,
    wireUpdate,
    receiveSnapshot,
    receiveUpdateState,
    testAll,
    retestOne,
    readModels,
    installTarget,
    restartService,
    toggleLanAccess,
    saveSettings,
    blockModelById,
    unblockModelById,
    checkOpencodeNow,
    dismissNotice,
    getSnapshot() { return snapshot; },
  };`, context, { filename: 'desktop/renderer.js' });

  const api = context.__panelTest;
  api.wire();
  api.wireUpdate();
  api.receiveSnapshot(structuredClone(state));

  return {
    document,
    window,
    api,
    getState: () => state,
    setState: (next) => { state = next; },
    getCalls: () => ({ blockCalls, confirmCalls, opencodeCheckCalls, openInstallCalls, modeSwitchCalls }),
  };
}

test('前端模型屏蔽：列表行按钮需二次确认、屏蔽后立即隐藏并进底部折叠栏、展开可恢复显示、支持按 ID 手动屏蔽', async () => {
  const app = bootPanel({ confirmResult: false });
  const rows = app.document.getElementById('rows');
  assert.equal(rows.querySelectorAll('.row').length, 2);

  // 点列表行右侧「屏蔽」按钮，二次确认点取消时不请求接口
  const firstRowBlockBtn = rows.querySelectorAll('.row-block-btn')[0];
  assert.ok(firstRowBlockBtn);
  assert.equal(rows.querySelectorAll('.row')[0].querySelector('.detail-actions')?.children[0]?.textContent, undefined);
  await firstRowBlockBtn.dispatch('click')[0];
  assert.equal(app.getCalls().confirmCalls, 1);
  assert.equal(app.getCalls().blockCalls.length, 0);
  assert.equal(rows.querySelectorAll('.row').length, 2);

  // 确认屏蔽后模型从主列表隐藏，底部显示隐藏个数；展开后可点击恢复显示
  app.window.confirmResult = true;
  await rows.querySelectorAll('.row-block-btn')[0].dispatch('click')[0];
  assert.equal(app.getCalls().blockCalls.length, 1);
  assert.equal(rows.querySelectorAll('.row').length, 1);
  assert.equal(app.document.getElementById('hidden-toggle-label').textContent, '隐藏的模型 (1)');
  assert.equal(app.document.getElementById('hidden-panel').hidden, true);

  // 展开底部的隐藏模型列表
  app.document.getElementById('hidden-toggle').dispatch('click');
  assert.equal(app.document.getElementById('hidden-panel').hidden, false);
  const hiddenRows = app.document.getElementById('hidden-rows');
  const hiddenItems = hiddenRows.querySelectorAll('.hidden-item');
  assert.equal(hiddenItems.length, 1);

  // 点「恢复显示」重新回到主列表
  await hiddenItems[0].querySelector('button').dispatch('click')[0];
  assert.equal(rows.querySelectorAll('.row').length, 2);
  assert.equal(app.document.getElementById('hidden-toggle-label').textContent, '隐藏的模型 (0)');

  // 在展开区域通过模型 ID 输入框手动屏蔽规则
  app.document.getElementById('hidden-id-input').value = 'opencode/custom-id';
  await app.document.getElementById('hidden-add-btn').dispatch('click')[0];
  assert.deepEqual(app.getCalls().blockCalls.at(-1), { id: 'opencode/custom-id', blocked: true });
  assert.equal(app.document.getElementById('hidden-toggle-label').textContent, '隐藏的模型 (1)');
});

test('报错自动消退：OpenCode 未启动时测试/重测/读取目录报错，OpenCode 启动就绪后自动消失', async () => {
  const notReadySnapshot = {
    phase: 'idle',
    error: null,
    errorCode: null,
    upstream: { ready: false, baseUrl: null },
    mode: 'embedded',
    lanAccess: false,
    models: [makeModel('opencode/alpha', { checkedAt: 500, verdict: 'failed' })],
    hiddenModels: [],
    targets: [{ id: 'zcode', label: 'ZCode', detected: true, written: false }],
  };
  const app = bootPanel({ initialSnapshot: notReadySnapshot });
  const notice = app.document.getElementById('notice');
  const noticeBar = app.document.getElementById('notice-bar');

  // 1) OpenCode 未启动（idle 或 upstream.ready=false）时重测单个模型报错
  app.window.oc.probeOne = async () => { throw new Error('OpenCode 还没起来'); };
  await app.api.retestOne('opencode/alpha');
  assert.equal(notice.hidden, false);
  assert.equal(noticeBar.hidden, false);
  assert.equal(notice.textContent, '重测失败：OpenCode 还没起来');

  // OpenCode 后续启动就绪（即使 checkedAt 还是旧的 500），未就绪报错也应立刻自动消失
  const readyState = {
    ...notReadySnapshot,
    phase: 'ready',
    upstream: { ready: true, baseUrl: 'http://127.0.0.1:4096' },
  };
  app.setState(readyState);
  app.api.receiveSnapshot(structuredClone(readyState));
  assert.equal(notice.hidden, true);
  assert.equal(noticeBar.hidden, true);

  // 2) 上游断开/未就绪时（phase:'ready', upstream.ready:false）「全量检测」与「读取模型」报错，在服务恢复就绪后自动消失
  const disconnectedSnapshot = {
    ...notReadySnapshot,
    phase: 'ready',
    upstream: { ready: false, baseUrl: null },
  };
  app.setState(disconnectedSnapshot);
  app.api.receiveSnapshot(structuredClone(disconnectedSnapshot));
  app.window.oc.probe = async () => { throw new Error('OpenCode 还没起来'); };
  await app.api.testAll(false);
  assert.match(notice.textContent, /OpenCode 还没起来/);

  app.window.oc.refresh = async () => { throw new Error('OpenCode 还没起来'); };
  await app.api.readModels();
  assert.match(notice.textContent, /OpenCode 还没起来/);

  app.setState(readyState);
  app.api.receiveSnapshot(structuredClone(readyState));
  assert.equal(notice.hidden, true);
});

test('其余不会消失的报错修复：屏蔽失败模型清错、设置改输入清错、目标/广播恢复清错、支持手动 × 关闭', async () => {
  const app = bootPanel();
  const notice = app.document.getElementById('notice');

  // 1) 就绪状态下单个模型重测超时后，如果用户屏蔽了该模型，报错立即清除
  app.window.oc.probeOne = async () => { throw new Error('这次请求超时'); };
  await app.api.retestOne('opencode/alpha');
  assert.match(notice.textContent, /这次请求超时/);
  await app.api.blockModelById('opencode/alpha', 'alpha');
  // 清掉了超时错误，切到操作成功提示（可被计时器或手动关闭按钮消掉），并且确认没有卡住原 error
  assert.equal(notice.classList.contains('is-error'), false);

  // 2) 全量检测部分失败 -> 屏蔽失败模型后告警计数同步下降，全屏蔽/恢复后自动清掉
  app.setState({
    phase: 'ready',
    upstream: { ready: true, baseUrl: 'http://127.0.0.1:4096' },
    mode: 'embedded',
    lanAccess: false,
    models: [makeModel('opencode/a', { verdict: 'failed' }), makeModel('opencode/b', { verdict: 'tool' })],
    hiddenModels: [],
    targets: [],
  });
  app.api.receiveSnapshot(structuredClone(app.getState()));
  app.window.oc.probe = async () => ({
    summary: { tool: 1, chat: 0, failed: 1 },
    total: 2,
    results: [{ id: 'opencode/a', verdict: 'failed' }, { id: 'opencode/b', verdict: 'tool' }],
  });
  await app.api.testAll(false);
  assert.equal(notice.classList.contains('is-warning'), true);
  await app.api.blockModelById('opencode/a', 'a');
  assert.equal(notice.classList.contains('is-warning'), false);

  // 3) 设置校验报错 -> 修改输入框即清除 aria-invalid 与提示
  app.document.getElementById('cfg-concurrency').value = '99';
  app.document.getElementById('cfg-ttl').value = '60';
  await app.api.saveSettings();
  assert.equal(notice.classList.contains('is-error'), true);
  assert.equal(app.document.getElementById('cfg-concurrency').getAttribute('aria-invalid'), 'true');
  app.document.getElementById('cfg-concurrency').dispatch('input');
  assert.equal(app.document.getElementById('cfg-concurrency').getAttribute('aria-invalid'), 'false');
  assert.equal(notice.hidden, true);

  // 4) 更新弹窗失败报错在非错误更新状态或点关闭按钮时自动清理，且支持 #notice-dismiss 关闭任意报错
  app.window.oc.checkForUpdates = async () => { throw new Error('网络超时'); };
  await app.document.getElementById('act-check-update').dispatch('click')[0];
  assert.match(notice.textContent, /网络超时/);
  assert.equal(app.document.getElementById('notice-dismiss').hidden, false);
  app.document.getElementById('notice-dismiss').dispatch('click');
  assert.equal(notice.hidden, true);
});

test('启动 OpenCode 环境提示：未安装时顶部横幅与一次性弹窗提示安装；已安装未打开时顶部可关闭警告；打开后自动消退', async () => {
  // 1) 未带 opencode 字段的旧版快照保持横幅隐藏
  const legacy = bootPanel();
  assert.equal(legacy.document.getElementById('opencode-banner').hidden, true);

  // 2) 未安装 OpenCode 时显示安装引导横幅并弹出一次引导框
  const missingState = {
    phase: 'idle',
    error: '找不到 OpenCode',
    errorCode: 'runtime_missing',
    mode: 'embedded',
    lanAccess: false,
    models: [],
    hiddenModels: [],
    targets: [],
    opencode: {
      installed: false,
      externalRunning: false,
      installUrl: 'https://opencode.ai',
    },
  };
  const app = bootPanel({ initialSnapshot: missingState });
  const banner = app.document.getElementById('opencode-banner');
  const dialog = app.document.getElementById('opencode-install-dialog');
  assert.equal(banner.hidden, false);
  assert.equal(banner.classList.contains('is-error'), true);
  assert.match(app.document.getElementById('opencode-banner-title').textContent, /未检测到.*OpenCode/);
  assert.equal(dialog.open, true);

  // 关掉一次引导框后，下一轮快照不重复弹
  app.document.getElementById('opencode-install-later').dispatch('click');
  assert.equal(dialog.open, false);
  app.api.receiveSnapshot(structuredClone(missingState));
  assert.equal(dialog.open, false);

  // 点前往官网安装 / 重新检测
  await app.document.getElementById('opencode-banner-install').dispatch('click')[0];
  assert.equal(app.getCalls().openInstallCalls, 1);

  // 3) 已安装但外部 OpenCode 未打开 -> 显示温和提示横幅，允许暂闭
  const closedState = {
    ...missingState,
    phase: 'ready',
    error: null,
    errorCode: null,
    upstream: { ready: true, baseUrl: 'http://127.0.0.1:4096' },
    opencode: { installed: true, externalRunning: false, installUrl: 'https://opencode.ai' },
  };
  app.setState(closedState);
  app.api.receiveSnapshot(structuredClone(closedState));
  assert.equal(banner.hidden, false);
  assert.equal(banner.classList.contains('is-info'), true);
  assert.equal(banner.classList.contains('is-warning'), false);
  assert.match(app.document.getElementById('opencode-banner-title').textContent, /已安装.*未打开/);
  assert.match(app.document.getElementById('opencode-banner-desc').textContent, /CLI.*桌面版均可/);
  assert.match(app.document.getElementById('opencode-banner-desc').textContent, /无需.*打开外部 OpenCode|不打开外部 OpenCode/);

  // 点击重新检测调用后端
  await app.document.getElementById('opencode-banner-retry').dispatch('click')[0];
  assert.equal(app.getCalls().opencodeCheckCalls, 1);

  // 外部 OpenCode 启动后，顶部警告横幅自动隐藏
  const openedState = {
    ...closedState,
    opencode: { installed: true, externalRunning: true, installUrl: 'https://opencode.ai' },
  };
  app.setState(openedState);
  app.api.receiveSnapshot(structuredClone(openedState));
  assert.equal(banner.hidden, true);
});
