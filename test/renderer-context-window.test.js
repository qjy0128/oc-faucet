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
  let rejectFirstSave;
  const window = {
    oc: {
      panelShell: 'desktop',
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
      async installTarget(id, modelIds) {
        installs.push({ id, modelIds });
        return { added: modelIds ? modelIds.length : 2, changed: true };
      },
      async uninstallTarget(id) {
        installs.push({ id, uninstalled: true });
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
    setTimeout: () => 1,
    clearTimeout() {},
    globalThis: null,
  });
  context.globalThis = context;
  vm.runInContext(`${renderer}\nglobalThis.__contextWindowTest = {
    renderList,
    renderTargets,
    toggle,
    setSnapshot(next) { snapshot = next; },
    useListAsRender() { render = renderList; },
  };`, context, { filename: 'desktop/renderer.js' });

  return {
    document,
    calls,
    installs,
    get latestState() { return latestState; },
    set latestState(value) { latestState = value; },
    rejectFirstSave(error) { rejectFirstSave(error); },
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
