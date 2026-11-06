/**
 * 上下文窗口编辑器的隔离交互测试。
 * 使用最小 DOM 和模拟 window.oc，不启动真实服务或读取用户配置。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

class FakeNode {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.listeners = new Map();
    this.className = '';
    this._text = '';
    this.disabled = false;
    this.hidden = false;
    this.value = '';
    this.scrollTop = 0;
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.selectionDirection = 'none';
    this.classList = {
      add: (...names) => this.setClasses(new Set([...this.classes(), ...names])),
      remove: (...names) => this.setClasses(new Set([...this.classes()].filter((name) => !names.includes(name)))),
      contains: (name) => this.classes().has(name),
      toggle: (name, force) => {
        const classes = this.classes();
        const enabled = force ?? !classes.has(name);
        if (enabled) classes.add(name);
        else classes.delete(name);
        this.setClasses(classes);
        return enabled;
      },
    };
  }

  classes() {
    return new Set(String(this.className).split(/\s+/).filter(Boolean));
  }

  setClasses(classes) {
    this.className = [...classes].join(' ');
  }

  set textContent(value) {
    this.children = [];
    this._text = String(value ?? '');
  }

  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join('');
  }

  get childElementCount() {
    return this.children.length;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node.tagName === '#fragment') this.children.push(...node.children);
      else this.children.push(node);
    }
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) ?? [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }

  dispatch(type) {
    if (type === 'click' && this.tagName.toLowerCase() === 'button' && !this.disabled) this.focus();
    const event = { target: this, currentTarget: this, stopPropagation() {} };
    return (this.listeners.get(type) ?? []).map((callback) => callback(event));
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  setSelectionRange(start, end, direction = 'none') {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction;
  }

  querySelectorAll(selector) {
    const className = selector.startsWith('.') ? selector.slice(1) : null;
    const tagName = className ? null : selector.toLowerCase();
    const found = [];
    const visit = (node) => {
      for (const child of node.children) {
        if ((className && child.classList.contains(className)) || (tagName && child.tagName.toLowerCase() === tagName)) {
          found.push(child);
        }
        visit(child);
      }
    };
    visit(this);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function bootRenderer() {
  const nodes = new Map();
  const document = {
    activeElement: null,
    documentElement: new FakeNode('html', null),
    createElement(tagName) {
      return new FakeNode(tagName, document);
    },
    createElementNS(_namespace, tagName) {
      return new FakeNode(tagName, document);
    },
    createDocumentFragment() {
      return new FakeNode('#fragment', document);
    },
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, new FakeNode('div', document));
      return nodes.get(id);
    },
    addEventListener() {},
  };

  const snapshotModel = {
    id: 'opencode/demo',
    name: '演示模型',
    providerID: 'opencode',
    verdict: 'chat',
    contextWindow: 128_000,
    upstreamContextWindow: 128_000,
    contextWindowOverride: null,
    contextWindowPending: false,
    supportedEfforts: [],
  };
  let latestState = { phase: 'ready', models: [{ ...snapshotModel }] };
  const calls = [];
  const installs = [];
  const stateSubscriptions = [];
  let rejectFirstSave;
  let nextTimerId = 1;
  const timers = new Map();
  const window = {
    confirm: () => true,
    oc: {
      panelShell: 'desktop',
      onState(callback, onConnectionError) {
        stateSubscriptions.push({ callback, onConnectionError });
      },
      async setModelContextWindow(id, value) {
        calls.push({ id, value });
        if (calls.length === 1) {
          return new Promise((_resolve, reject) => {
            rejectFirstSave = reject;
          });
        }
        latestState = {
          phase: 'ready',
          models: [{
            ...snapshotModel,
            contextWindow: 128_000,
            contextWindowOverride: value,
            contextWindowPending: value !== null,
          }],
        };
      },
      async getState() {
        return latestState;
      },
      async getSettings() {
        return { probeConcurrency: 3, probeTtlMinutes: 360 };
      },
      async getApiKey() {
        return { key: 'test-key' };
      },
      async installTarget(id, modelIds) {
        installs.push({ id, modelIds });
        return { added: modelIds ? modelIds.length : 2, changed: true };
      },
      async uninstallTarget(id) {
        installs.push({ id, uninstalled: true });
      },
      async refresh() {
        return { models: latestState.models.length };
      },
      async probe() {
        return { summary: { tool: 1, chat: 0, failed: 0 }, total: 1 };
      },
      async probeOne(id) {
        return { id, verdict: 'tool' };
      },
      async setUpstreamMode(mode) {
        return { mode, requiresStart: false };
      },
      async restart() {
        return latestState;
      },
      async saveSettings(patch) {
        return patch;
      },
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
    setTimeout(callback) {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    globalThis: null,
  });
  context.globalThis = context;
  vm.runInContext(`${renderer}\nglobalThis.__contextWindowTest = {
    renderList,
    renderTargets,
    render,
    renderStatus,
    toggle,
    readModels,
    testAll,
    retestOne,
    installTarget,
    restartService,
    start,
    switchUpstreamMode,
    saveSettings,
    note,
    beginAction,
    refreshSnapshot,
    receiveSnapshot,
    setSnapshot(next) { snapshot = next; },
    useListAsRender() { render = renderList; },
  };`, context, { filename: 'desktop/renderer.js' });

  return {
    document,
    window,
    calls,
    installs,
    stateSubscriptions,
    get latestState() { return latestState; },
    set latestState(value) { latestState = value; },
    rejectFirstSave(error) { rejectFirstSave(error); },
    runTimers() {
      const scheduled = [...timers.values()];
      timers.clear();
      for (const callback of scheduled) callback();
    },
    testApi: context.__contextWindowTest,
  };
}

function byClass(root, className) {
  return root.querySelectorAll(`.${className}`);
}

test('编辑草稿经快照刷新保留，失败可重试，保存与恢复传入正确 token 数', async () => {
  const app = bootRenderer();
  const { document, calls, testApi } = app;
  const list = document.getElementById('list');
  const rows = document.getElementById('rows');
  testApi.setSnapshot(app.latestState);
  testApi.toggle('opencode/demo');

  let input = byClass(rows, 'context-window-input')[0];
  input.value = '1m';
  input.dispatch('input');
  input.focus();
  input.setSelectionRange(2, 2);

  // 模拟 Web 版每 1.5 秒收到一次快照，同时检查输入内容、焦点和光标仍在原处。
  testApi.setSnapshot({ ...app.latestState, models: app.latestState.models.map((model) => ({ ...model })) });
  testApi.renderList();
  input = byClass(rows, 'context-window-input')[0];
  assert.equal(input.value, '1m');
  assert.equal(document.activeElement, input);
  assert.equal(input.selectionStart, 2);
  assert.equal(list.scrollTop, 0);

  let save = [...rows.querySelectorAll('button')].find((button) => button.textContent === '保存');
  const firstAttempt = save.dispatch('click')[0];
  input = byClass(rows, 'context-window-input')[0];
  assert.equal(input.disabled, true, '保存过程中应锁住输入，避免成功回调丢掉新输入');
  app.rejectFirstSave(new Error('暂时没连上，请重试'));
  await firstAttempt;

  input = byClass(rows, 'context-window-input')[0];
  assert.equal(input.value, '1m', '失败后保留用户输入');
  assert.equal(input.disabled, false, '失败后重新开放输入');
  assert.match(byClass(rows, 'context-window-error')[0].textContent, /保存失败：暂时没连上，请重试/);

  save = [...rows.querySelectorAll('button')].find((button) => button.textContent === '保存');
  await save.dispatch('click')[0];
  assert.deepEqual(calls, [
    { id: 'opencode/demo', value: 1_000_000 },
    { id: 'opencode/demo', value: 1_000_000 },
  ]);

  const detailRows = byClass(rows, 'detail-grid')[0].children;
  const field = (key) => detailRows.find((cell) => cell.children[0].textContent === key)?.children[1].textContent;
  assert.equal(field('当前生效窗口'), '128,000 tokens', '未确认同步时应显示实际生效的上游值');
  assert.equal(field('上游原值'), '128,000 tokens', '上游原值不能被当前覆盖值冒充');
  assert.match(field('自定义设置'), /等待同步，请重试保存或恢复默认/);
  assert.equal(document.getElementById('notice').textContent, '窗口设置已记录，但还没全部同步；请重试保存或恢复默认');

  const restore = [...rows.querySelectorAll('button')].find((button) => button.textContent === '恢复默认');
  await restore.dispatch('click')[0];
  assert.deepEqual(calls.at(-1), { id: 'opencode/demo', value: null });
  const restoredRows = byClass(rows, 'detail-grid')[0].children;
  const restoredField = (key) => restoredRows.find((cell) => cell.children[0].textContent === key)?.children[1].textContent;
  assert.equal(restoredField('当前生效窗口'), '128,000 tokens');
  assert.equal(restoredField('上游原值'), '128,000 tokens');
  assert.equal(restoredField('自定义设置'), '使用上游默认值', '确认恢复后应移除等待同步提示');
  assert.equal(document.getElementById('notice').textContent, '已恢复上游默认上下文窗口');
});

test('清除另一动作的错误不应取消已有成功提示的自动消失', () => {
  const app = bootRenderer();
  const { testApi, document, runTimers } = app;

  testApi.note('局域网广播已开启', 'ok', testApi.beginAction('lan'));
  testApi.note('', 'ok', testApi.beginAction('lan-config'));
  runTimers();

  assert.equal(document.getElementById('notice').hidden, true);
});

test('目标勾选区：展开、改勾、确认后只把勾中的模型写进去', async () => {
  const app = bootRenderer();
  const { document, installs, testApi } = app;
  const first = { ...app.latestState.models[0] };
  const second = { ...first, id: 'opencode/other', modelID: 'other', name: '另一个' };
  const codexTarget = { id: 'codex', label: 'Codex', detected: true, written: false, models: [], selectsModels: true };
  const zcodeTarget = { ...codexTarget, id: 'zcode', label: 'ZCode', selectsModels: false };
  const state = { phase: 'ready', models: [first, second], targets: [codexTarget, zcodeTarget] };
  app.latestState = state;
  testApi.setSnapshot(state);
  testApi.renderTargets();

  const box = document.getElementById('targets');
  const rows = box.children.filter((node) => node.classList.contains('target-row'));
  assert.equal(rows.length, 2);

  // 不支持勾选的目标：点「写入」直接写，不弹勾选区
  await rows[1].querySelectorAll('button')[0].dispatch('click')[0];
  assert.equal(installs.length, 1);
  assert.equal(installs[0].id, 'zcode');
  assert.equal(installs[0].modelIds, undefined);
  assert.equal(box.querySelector('.target-picker'), null);

  // 支持勾选的目标：先展开，默认全勾
  testApi.setSnapshot(state);
  testApi.renderTargets();
  const codexRow = box.children.filter((node) => node.classList.contains('target-row'))[0];
  await codexRow.querySelectorAll('button')[0].dispatch('click')[0];
  let picker = box.querySelector('.target-picker');
  assert.ok(picker, '勾选区应当展开');
  let checks = picker.querySelectorAll('input');
  assert.equal(checks.length, 2);
  assert.deepEqual(checks.map((node) => node.checked), [true, true]);
  let confirm = picker.querySelector('.target-picker-confirm');
  assert.equal(confirm.disabled, false);

  // 取消第一个勾选 → 确认后只送第二个
  checks[0].checked = false;
  checks[0].dispatch('change');
  assert.equal(confirm.disabled, false, '还剩一个，可以写');
  await confirm.dispatch('click')[0];
  assert.equal(JSON.stringify(installs.at(-1)), JSON.stringify({ id: 'codex', modelIds: ['opencode/other'] }));
  assert.equal(box.querySelector('.target-picker'), null, '写完就收起勾选区');

  // 全不勾 → 确认按钮置灰
  testApi.setSnapshot(state);
  testApi.renderTargets();
  box.children.filter((node) => node.classList.contains('target-row'))[0].querySelectorAll('button')[0].dispatch('click');
  picker = box.querySelector('.target-picker');
  for (const node of picker.querySelectorAll('input')) {
    node.checked = false;
    node.dispatch('change');
  }
  assert.equal(picker.querySelector('.target-picker-confirm').disabled, true);

  // 「取消」收起勾选区，不发起写入
  const cancel = box.querySelector('.target-picker-actions').children.at(-1);
  await cancel.dispatch('click')[0];
  assert.equal(box.querySelector('.target-picker'), null, '取消要收起勾选区');
  assert.notEqual(installs.at(-1).id, undefined);
});

test('目标勾选区：已有保存选择时只默认勾选保存的模型', () => {
  const app = bootRenderer();
  const first = { ...app.latestState.models[0] };
  const second = { ...first, id: 'opencode/other', modelID: 'other', name: '另一个' };
  const target = {
    id: 'codex', label: 'Codex', detected: true, written: true,
    models: ['opencode/other'], selectedModelIds: ['opencode/other'], selectsModels: true,
  };
  const state = { phase: 'ready', models: [first, second], targets: [target] };
  app.testApi.setSnapshot(state);
  app.testApi.renderTargets();
  app.document.getElementById('targets').querySelector('.target-row').querySelectorAll('button')[0].dispatch('click');

  const items = app.document.getElementById('targets').querySelectorAll('.target-picker-item');
  const checkedByName = Object.fromEntries(items.map((item) => [item.children[1].textContent, item.children[0].checked]));
  assert.deepEqual(checkedByName, { '另一个': true, '演示模型': false });
});

test('旧快照缺少 selectedModelIds 时按当前已写入模型勾选，不扩成全部', () => {
  const app = bootRenderer();
  const first = { ...app.latestState.models[0] };
  const second = { ...first, id: 'opencode/other', modelID: 'other', name: '另一个' };
  const target = {
    id: 'codex', label: 'Codex', detected: true, written: true,
    models: ['opencode/other'], selectsModels: true,
  };
  const state = { phase: 'ready', models: [first, second], targets: [target] };
  app.testApi.setSnapshot(state);
  app.testApi.renderTargets();
  app.document.getElementById('targets').querySelector('.target-row').querySelectorAll('button')[0].dispatch('click');

  const items = app.document.getElementById('targets').querySelectorAll('.target-picker-item');
  const checkedByName = Object.fromEntries(items.map((item) => [item.children[1].textContent, item.children[0].checked]));
  assert.deepEqual(checkedByName, { '另一个': true, '演示模型': false });
});

test('目标选择器保留暂不可用的已保存选择，模型恢复后继续勾选并可一同写入', async () => {
  const app = bootRenderer();
  const unavailable = { ...app.latestState.models[0], id: 'opencode/a', name: 'A 模型', verdict: 'failed' };
  const available = { ...app.latestState.models[0], id: 'opencode/b', name: 'B 模型', verdict: 'chat' };
  const target = {
    id: 'codex', label: 'Codex', detected: true, written: true,
    models: ['opencode/a', 'opencode/b'], selectedModelIds: ['opencode/a', 'opencode/b'], selectsModels: true,
  };
  const state = { phase: 'ready', models: [unavailable, available], targets: [target] };
  app.latestState = state;
  app.testApi.setSnapshot(state);
  app.testApi.renderTargets();
  app.document.getElementById('targets').querySelector('.target-row').querySelectorAll('button')[0].dispatch('click');

  let picker = app.document.getElementById('targets').querySelector('.target-picker');
  assert.equal(picker.querySelectorAll('input').length, 1, '不可用模型不显示为可选项');
  assert.equal(picker.querySelector('.target-picker-confirm').disabled, false, '当前仍有一个可用且已勾选的模型');

  const recovered = { ...unavailable, verdict: 'tool', checkedAt: Date.now() + 1 };
  const recoveredState = { ...state, models: [recovered, available] };
  app.latestState = recoveredState;
  app.testApi.setSnapshot(recoveredState);
  app.testApi.renderTargets();
  picker = app.document.getElementById('targets').querySelector('.target-picker');
  const checkedByName = Object.fromEntries(picker.querySelectorAll('.target-picker-item').map((item) => [
    item.children[1].textContent,
    item.children[0].checked,
  ]));
  assert.deepEqual(checkedByName, { 'A 模型': true, 'B 模型': true });

  await picker.querySelector('.target-picker-confirm').dispatch('click')[0];
  assert.equal(JSON.stringify(app.installs.at(-1)), JSON.stringify({ id: 'codex', modelIds: ['opencode/a', 'opencode/b'] }));
});

test('目标勾选区：保存过的模型都暂不可用时不自动勾选其他模型', () => {
  const app = bootRenderer();
  const unavailable = { ...app.latestState.models[0], verdict: 'failed' };
  const unselected = { ...app.latestState.models[0], id: 'opencode/other', modelID: 'other', name: '另一个' };
  const target = {
    id: 'codex', label: 'Codex', detected: true, written: true,
    models: ['opencode/demo'], selectedModelIds: ['opencode/demo'], selectsModels: true,
  };
  const state = { phase: 'ready', models: [unavailable, unselected], targets: [target] };
  app.testApi.setSnapshot(state);
  app.testApi.renderTargets();
  app.document.getElementById('targets').querySelector('.target-row').querySelectorAll('button')[0].dispatch('click');

  const picker = app.document.getElementById('targets').querySelector('.target-picker');
  assert.deepEqual(picker.querySelectorAll('input').map((node) => node.checked), [false]);
  assert.equal(picker.querySelector('.target-picker-confirm').disabled, true, '没有当前可用且勾选的模型时不能确认写入');
  assert.match(picker.textContent, /保存的模型.*暂不可用|已保存.*不可用/);
});

test('运行状态错误在已有模型时也显示下一步与重试入口', () => {
  const app = bootRenderer();
  const model = { ...app.latestState.models[0] };
  app.testApi.setSnapshot({
    phase: 'starting', mode: 'embedded', errorCode: 'runtime_missing',
    error: 'OpenCode 找不到', models: [model],
  });
  app.testApi.renderStatus();

  const help = app.document.getElementById('status-help');
  assert.equal(help.hidden, false);
  assert.match(help.textContent, /OpenCode/);
  assert.match(app.document.getElementById('act-restart').textContent, /重试|启动/);
});

test('启动中的上游尚未就绪不应误报为断开', () => {
  const app = bootRenderer();
  app.testApi.setSnapshot({
    phase: 'starting', mode: 'embedded', error: null, errorCode: null,
    upstream: { ready: false }, models: [],
  });

  app.testApi.render();

  assert.equal(app.document.getElementById('chip').dataset.state, 'busy');
  assert.equal(app.document.getElementById('chip-text').textContent, '正在启动');
});

test('伪装方案的运行组件错误不会误导用户去安装本机 OpenCode', () => {
  const app = bootRenderer();
  app.testApi.setSnapshot({
    phase: 'starting', mode: 'masquerade', errorCode: 'runtime_missing',
    error: '内置运行组件不可用', models: [],
  });
  app.testApi.renderStatus();

  assert.doesNotMatch(app.document.getElementById('status-help').textContent, /OpenCode/);
  assert.match(app.document.getElementById('status-help').textContent, /应用|运行组件|日志/);
});

test('上游运行中断开时显示重试说明，不把旧模型状态当作就绪', () => {
  const app = bootRenderer();
  app.testApi.setSnapshot({
    phase: 'ready', mode: 'embedded', errorCode: 'upstream_disconnected',
    error: '上游进程意外退出', upstream: { ready: false }, models: [app.latestState.models[0]],
  });
  app.testApi.renderStatus();

  assert.equal(app.document.getElementById('statusbar').dataset.state, 'error');
  assert.match(app.document.getElementById('status-help').textContent, /断开|重试|日志/);
});

test('服务未运行时切方案只说明下次启动生效，不声称已切换运行', async () => {
  const app = bootRenderer();
  app.latestState = { phase: 'idle', mode: 'embedded', models: [], targets: [] };
  app.testApi.setSnapshot(app.latestState);
  app.window.oc.setUpstreamMode = async (mode) => ({ mode, requiresStart: true });
  app.window.oc.getState = async () => app.latestState;

  await app.testApi.switchUpstreamMode('masquerade');

  const notice = app.document.getElementById('notice');
  assert.match(notice.textContent, /启动服务|下次启动/);
  assert.doesNotMatch(notice.textContent, /已切到伪装方案/);
});

test('来回更换待启动方案后，服务就绪会清掉两种旧提示', async () => {
  const app = bootRenderer();
  app.latestState = { phase: 'idle', mode: 'embedded', models: [], targets: [] };
  app.testApi.setSnapshot(app.latestState);
  app.window.oc.setUpstreamMode = async (mode) => {
    app.latestState = { ...app.latestState, mode };
    return { mode, requiresStart: true };
  };
  app.window.oc.getState = async () => app.latestState;

  await app.testApi.switchUpstreamMode('masquerade');
  await app.testApi.switchUpstreamMode('embedded');
  assert.match(app.document.getElementById('notice').textContent, /服务未运行/);

  app.testApi.receiveSnapshot({ phase: 'ready', mode: 'embedded', models: [], targets: [], error: null, errorCode: null });
  assert.equal(app.document.getElementById('notice').hidden, true);
});

test('无关动作成功不清除配置写入失败提示', async () => {
  const app = bootRenderer();
  app.window.oc.installTarget = async () => { throw new Error('配置文件只读'); };
  const target = { id: 'codex', label: 'Codex' };

  await app.testApi.installTarget(target);
  assert.match(app.document.getElementById('notice').textContent, /配置文件只读/);
  await app.testApi.readModels();

  assert.match(app.document.getElementById('notice').textContent, /配置文件只读/);
  assert.equal(app.document.getElementById('notice').classList.contains('is-error'), true);
});

test('较早请求晚到的失败不能覆盖较新的成功结果', async () => {
  const app = bootRenderer();
  let rejectOlder;
  let callCount = 0;
  app.window.oc.refresh = () => {
    callCount += 1;
    if (callCount === 1) return new Promise((_resolve, reject) => { rejectOlder = reject; });
    return Promise.resolve({ models: 2 });
  };

  const older = app.testApi.readModels();
  const newer = app.testApi.readModels();
  await newer;
  rejectOlder(new Error('旧请求失败'));
  await older;

  assert.match(app.document.getElementById('notice').textContent, /读到 2 个免费模型/);
  assert.equal(app.document.getElementById('notice').classList.contains('is-error'), false);
});

test('状态轮询发起后若已收到更新快照，旧状态请求失败不再报错', async () => {
  const app = bootRenderer();
  let rejectRead;
  app.window.oc.getState = () => new Promise((_resolve, reject) => { rejectRead = reject; });

  const pendingRead = app.testApi.refreshSnapshot();
  app.testApi.receiveSnapshot({ phase: 'ready', models: [], targets: [], error: null, errorCode: null });
  rejectRead(new Error('过期的连接错误'));
  await pendingRead;

  assert.equal(app.document.getElementById('notice').hidden, true);
});

test('模型旧成功快照不会清掉新重测错误，只有更新的模型判定成功才清除', async () => {
  const app = bootRenderer();
  app.window.oc.panelShell = 'web';
  const checkedAt = Date.now() - 1000;
  const model = { ...app.latestState.models[0], verdict: 'tool', checkedAt };
  app.latestState = { phase: 'ready', models: [model], targets: [] };
  app.testApi.setSnapshot(app.latestState);
  app.window.oc.probeOne = async () => { throw new Error('这次请求超时'); };
  app.testApi.start();

  await app.testApi.retestOne(model.id);
  assert.match(app.document.getElementById('notice').textContent, /这次请求超时/);
  app.stateSubscriptions[0].callback({ ...app.latestState, models: [{ ...model }] });
  assert.match(app.document.getElementById('notice').textContent, /这次请求超时/);

  await new Promise((resolve) => setTimeout(resolve, 5));
  app.stateSubscriptions[0].callback({
    ...app.latestState,
    models: [{ ...model, checkedAt: Date.now() }],
  });
  assert.equal(app.document.getElementById('notice').hidden, true);
});

test('设置输入无效时保留输入并说明原因，不调用保存接口', async () => {
  const app = bootRenderer();
  let saved = false;
  app.window.oc.saveSettings = async () => { saved = true; };
  app.document.getElementById('cfg-concurrency').value = '7';
  app.document.getElementById('cfg-ttl').value = '360';

  await app.testApi.saveSettings();

  assert.equal(saved, false);
  assert.equal(app.document.getElementById('cfg-concurrency').value, '7');
  assert.equal(app.document.getElementById('cfg-concurrency').attributes['aria-invalid'], 'true');
  assert.match(app.document.getElementById('notice').textContent, /并发.*1.*6|1.*6.*整数/);
  assert.equal(app.document.getElementById('notice').classList.contains('is-error'), true);
});

test('设置允许有限小数有效期，并把服务端实际保存值回填', async () => {
  const app = bootRenderer();
  let submitted;
  app.window.oc.saveSettings = async (patch) => {
    submitted = patch;
    return { probeConcurrency: 3, probeTtlMinutes: 60 };
  };
  app.document.getElementById('cfg-concurrency').value = '4';
  app.document.getElementById('cfg-ttl').value = '15.5';

  await app.testApi.saveSettings();

  assert.deepEqual(JSON.parse(JSON.stringify(submitted)), { probeConcurrency: 4, probeTtlMinutes: 15.5 });
  assert.equal(app.document.getElementById('cfg-concurrency').value, 3);
  assert.equal(app.document.getElementById('cfg-ttl').value, 60);
});

test('Web 断线显示连接错误，恢复快照只清连接错误而保留配置失败', async () => {
  const app = bootRenderer();
  app.window.oc.panelShell = 'web';
  app.latestState = { phase: 'ready', models: [], targets: [], upstream: { ready: true } };
  app.testApi.start();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const subscription = app.stateSubscriptions[0];
  subscription.onConnectionError(new Error('网络暂不可达'));
  assert.equal(app.document.getElementById('statusbar').dataset.state, 'error');
  assert.match(app.document.getElementById('notice').textContent, /面板与本机服务断开/);

  app.window.oc.installTarget = async () => { throw new Error('配置写入失败'); };
  await app.testApi.installTarget({ id: 'codex', label: 'Codex' });
  subscription.callback(app.latestState);

  assert.equal(app.document.getElementById('statusbar').dataset.state, 'ready');
  assert.match(app.document.getElementById('notice').textContent, /配置写入失败/);
  assert.equal(app.document.getElementById('notice').classList.contains('is-error'), true);
});

test('全量检测时锁住单条与重复全量，完成后恢复按钮', async () => {
  const app = bootRenderer();
  const model = { ...app.latestState.models[0] };
  app.latestState = { phase: 'ready', models: [model], targets: [] };
  app.testApi.setSnapshot(app.latestState);
  app.testApi.render();
  app.testApi.toggle(model.id);
  let resolveProbe;
  let allCalls = 0;
  let oneCalls = 0;
  app.window.oc.probe = () => {
    allCalls += 1;
    return new Promise((resolve) => { resolveProbe = resolve; });
  };
  app.window.oc.probeOne = async () => { oneCalls += 1; return { verdict: 'tool' }; };

  const first = app.testApi.testAll(false);
  const overlapping = app.testApi.testAll(false);
  await app.testApi.retestOne(model.id);
  assert.equal(allCalls, 1);
  assert.equal(oneCalls, 0);
  assert.equal(app.document.getElementById('act-test').disabled, true);
  assert.equal(app.document.getElementById('rows').querySelector('.detail-actions').children[0].disabled, true);

  resolveProbe({ summary: { tool: 1, chat: 0, failed: 0 }, total: 1 });
  await Promise.all([first, overlapping]);
  assert.equal(app.document.getElementById('act-test').disabled, false);
  assert.equal(app.document.getElementById('rows').querySelector('.detail-actions').children[0].disabled, false);
});

test('同一模型单条重测不能重复，接口报错后锁会释放', async () => {
  const app = bootRenderer();
  const model = { ...app.latestState.models[0] };
  app.latestState = { phase: 'ready', models: [model], targets: [] };
  app.testApi.setSnapshot(app.latestState);
  app.testApi.render();
  app.testApi.toggle(model.id);
  let rejectProbe;
  let calls = 0;
  app.window.oc.probeOne = () => {
    calls += 1;
    return new Promise((_resolve, reject) => { rejectProbe = reject; });
  };

  const first = app.testApi.retestOne(model.id);
  const duplicate = app.testApi.retestOne(model.id);
  await duplicate;
  assert.equal(calls, 1);
  assert.equal(app.document.getElementById('act-test').disabled, true);
  rejectProbe(new Error('体检请求失败'));
  await first;

  assert.equal(app.document.getElementById('act-test').disabled, false);
  assert.equal(app.document.getElementById('rows').querySelector('.detail-actions').children[0].disabled, false);
  assert.match(app.document.getElementById('notice').textContent, /体检请求失败/);
});

test('检测结果按全部成功、部分失败、全部失败区分提示颜色', async () => {
  const cases = [
    [{ tool: 1, chat: 0, failed: 0 }, 1, 'is-ok'],
    [{ tool: 1, chat: 0, failed: 1 }, 2, 'is-warning'],
    [{ tool: 0, chat: 0, failed: 2 }, 2, 'is-error'],
  ];
  for (const [summary, total, kind] of cases) {
    const app = bootRenderer();
    app.testApi.setSnapshot(app.latestState);
    app.window.oc.probe = async () => ({ summary, total });
    await app.testApi.testAll(false);
    assert.equal(app.document.getElementById('notice').classList.contains(kind), true, `summary ${JSON.stringify(summary)} should be ${kind}`);
  }
});

test('全量检测全部只能聊天但没有失败时是成功提示，不留下警告', async () => {
  const app = bootRenderer();
  app.testApi.setSnapshot(app.latestState);
  app.window.oc.probe = async () => ({ summary: { tool: 0, chat: 2, failed: 0 }, total: 2 });

  await app.testApi.testAll(false);

  const notice = app.document.getElementById('notice');
  assert.equal(notice.classList.contains('is-ok'), true);
  assert.match(notice.textContent, /只能聊天 2/);
  assert.equal(notice.classList.contains('is-warning'), false);
});

test('单条模型重测仍失败时用红色提示', async () => {
  const app = bootRenderer();
  const model = { ...app.latestState.models[0] };
  app.latestState = { phase: 'ready', models: [model], targets: [] };
  app.testApi.setSnapshot(app.latestState);
  app.window.oc.probeOne = async () => ({ verdict: 'failed' });

  await app.testApi.retestOne(model.id);

  assert.equal(app.document.getElementById('notice').classList.contains('is-error'), true);
  assert.match(app.document.getElementById('notice').textContent, /仍不可用/);
});

test('全量失败汇总随这批模型的后续成功重测更新并最终清除', async () => {
  const app = bootRenderer();
  const checkedAt = Date.now() - 1000;
  const first = { ...app.latestState.models[0], id: 'opencode/first', verdict: 'tool', checkedAt };
  const second = { ...first, id: 'opencode/second' };
  app.latestState = { phase: 'ready', models: [first, second], targets: [] };
  app.testApi.setSnapshot(app.latestState);
  app.window.oc.probe = async () => {
    const failedAt = Date.now();
    app.latestState = {
      phase: 'ready', targets: [],
      models: [
        { ...first, verdict: 'failed', checkedAt: failedAt },
        { ...second, verdict: 'failed', checkedAt: failedAt },
      ],
    };
    return { summary: { tool: 0, chat: 0, failed: 2 }, total: 2 };
  };

  await app.testApi.testAll(false);
  assert.equal(app.document.getElementById('notice').classList.contains('is-error'), true);

  const firstRecoveredAt = Date.now() + 1;
  app.latestState.models[0] = { ...first, verdict: 'tool', checkedAt: firstRecoveredAt };
  app.testApi.receiveSnapshot(app.latestState);
  assert.equal(app.document.getElementById('notice').classList.contains('is-warning'), true);
  assert.match(app.document.getElementById('notice').textContent, /仍有 1 个/);

  app.latestState.models[1] = { ...second, verdict: 'tool', checkedAt: firstRecoveredAt + 1 };
  app.testApi.receiveSnapshot(app.latestState);
  assert.equal(app.document.getElementById('notice').hidden, true);
});
