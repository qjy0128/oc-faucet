/**
 * 控制面板的前端逻辑。
 *
 * 同一份代码跑在两个壳子里：
 *   - 浏览器（npm run web）：window.oc 由 web/web-client.js 用 fetch 实现
 *   - Electron（npm run desktop）：window.oc 由 preload 用 IPC 实现
 *
 * 这里没有任何 Node 能力，也拿不到密钥，只能通过 window.oc 那组方法干活。
 */

const byId = (id) => document.getElementById(id);

let snapshot = { models: [], phase: 'starting', progress: null };
/** 方案切换进行中：两个按钮都先禁用，免得连点 */
let switchingMode = false;
let openRowId = null;
const testingIds = new Set();
const contextWindowDrafts = new Map();
// 目标勾选区：当前展开的是哪个目标、勾了哪些模型（轮询重画时要保住）
let openTargetPickerId = null;
const targetPickerDraft = new Map();

/* ------------------------------------------------------------------ */
/* 极小的 DOM 工具                                                     */
/* ------------------------------------------------------------------ */

/** 建一个元素，顺手设好类名和文本 */
function h(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className || '';
  if (arguments.length > 2 && text !== undefined) node.textContent = text;
  return node;
}

const NS = 'http://www.w3.org/2000/svg';

/** 画一个小图标：只支持本项目用到的那几个形状 */
function glyph(name) {
  const svg = document.createElementNS(NS, 'svg');
  for (const [key, value] of Object.entries({
    viewBox: '0 0 20 20',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.6',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  })) {
    svg.setAttribute(key, value);
  }

  const shapes = {
    // 展开箭头
    chevron: ['M8 5l5 5-5 5'],
    // 单条重测：一个回旋箭头
    again: ['M16 10a6 6 0 1 1-1.8-4.3', 'M16 3v4h-4'],
    // 复制：两个叠着的圆角方块
    copy: [
      'M8 7.5h5.5A1.5 1.5 0 0 1 15 9v5.5a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 14.5V9A1.5 1.5 0 0 1 8 7.5z',
      'M11 7.5V5A1.5 1.5 0 0 0 9.5 3.5H5A1.5 1.5 0 0 0 3.5 5v4.5A1.5 1.5 0 0 0 5 11h1.5',
    ],
    // 空状态：一艘小船的轮廓
    boat: ['M3 12h14l-2.5 4.5h-9z', 'M6 12V6.5h8V12', 'M10 6.5V3.5'],
  };

  for (const d of shapes[name] ?? []) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

/* ------------------------------------------------------------------ */
/* 文案                                                                */
/* ------------------------------------------------------------------ */

function verdictKey(model) {
  if (model.verdict === 'tool') return 'ok';
  if (model.verdict === 'chat') return 'chat';
  if (model.verdict === 'failed') return 'fail';
  return 'wait';
}

function verdictText(model) {
  switch (verdictKey(model)) {
    case 'ok':
      return '可用';
    case 'chat':
      return '只能聊天';
    case 'fail':
      return '不可用';
    default:
      return '待检测';
  }
}

const usable = (model) => model.verdict === 'tool' || model.verdict === 'chat';

function humanMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  return `${(ms / 1000).toFixed(1)} 秒`;
}

function humanAgo(ts) {
  if (!Number.isFinite(ts)) return '';
  const gap = Date.now() - ts;
  if (gap < 60_000) return '刚刚';
  if (gap < 3_600_000) return `${Math.round(gap / 60_000)} 分钟前`;
  if (gap < 86_400_000) return `${Math.round(gap / 3_600_000)} 小时前`;
  return `${Math.round(gap / 86_400_000)} 天前`;
}

/** 耗时列：这次真测过就给耗时，只是从缓存恢复就给判定时间 */
function timingText(model) {
  if (verdictKey(model) === 'wait') return '—';
  const prefix = model.cached ? '缓存判定' : '最近检测';
  const duration = humanMs(model.elapsedMs);
  if (duration) return `${prefix} · ${duration}`;
  const ago = humanAgo(model.checkedAt);
  return ago ? `${prefix} · ${ago}` : '—';
}

/** 推理档位名 → 界面上的中文名（请求体里填的还是英文原名） */
const EFFORT_NAMES = {
  none: '关闭',
  minimal: '最小',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最高',
};

/**
 * 模型能调的推理档位（排除「关闭」档）。
 * 快照里的 supportedEfforts 本来就是按强度从低到高排好的；老快照没这个字段就当没有。
 */
function effortLevels(model) {
  return (model.supportedEfforts ?? []).filter((e) => e !== 'none');
}

/* ------------------------------------------------------------------ */
/* 主题                                                                */
/* ------------------------------------------------------------------ */

const THEME_KEY = 'oc-faucet-theme';
const THEMES = ['system', 'light', 'dark'];

function setTheme(choice) {
  const picked = THEMES.includes(choice) ? choice : 'system';
  if (picked === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = picked;

  for (const name of THEMES) {
    const button = byId(`theme-${name}`);
    if (button) button.setAttribute('aria-pressed', String(name === picked));
  }
  try {
    localStorage.setItem(THEME_KEY, picked);
  } catch {
    /* 隐私模式写不进去，不影响使用 */
  }
}

function initTheme() {
  let saved = 'system';
  try {
    saved = localStorage.getItem(THEME_KEY) || 'system';
  } catch {
    /* 读不到就跟随系统 */
  }
  setTheme(saved);
  for (const name of THEMES) {
    byId(`theme-${name}`)?.addEventListener('click', () => setTheme(name));
  }
}

/* ------------------------------------------------------------------ */
/* 提示条                                                              */
/* ------------------------------------------------------------------ */

let noteTimer = null;

function note(message, kind = '') {
  const node = byId('notice');
  if (!message) {
    node.hidden = true;
    return;
  }
  node.textContent = message;
  node.className = `notice${kind ? ` is-${kind}` : ''}`;
  node.hidden = false;
  clearTimeout(noteTimer);
  if (kind !== 'error') noteTimer = setTimeout(() => (node.hidden = true), 6000);
}

/* ------------------------------------------------------------------ */
/* 剪贴板                                                              */
/* ------------------------------------------------------------------ */

/**
 * 复制一段文本，返回到底复制上没有。
 * 优先走剪贴板 API；不可用或被拒绝时退回老办法：
 * 藏一个只读 textarea，全选后 execCommand('copy')。
 */
async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* 权限被拒之类，落去下面的老办法再试一次 */
    }
  }
  const area = h('textarea', 'visually-hidden');
  area.value = text;
  area.readOnly = true;
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

/** 复制完在按钮上闪一下结果：成功变绿「已复制」、失败变红「复制失败」，1.4 秒后还原 */
function flashCopied(btn, ok) {
  const label = btn.querySelector('span') ?? btn;
  // 原始文案只记第一次，连点时别被「已复制」覆盖掉
  btn._label ??= label.textContent;
  clearTimeout(btn._timer);
  btn.classList.toggle('is-copied', ok);
  btn.classList.toggle('is-failed', !ok);
  label.textContent = ok ? '已复制' : '复制失败';
  btn._timer = setTimeout(() => {
    btn.classList.remove('is-copied', 'is-failed');
    label.textContent = btn._label;
  }, 1400);
}

/** 一个小号「复制」按钮；拦住点击事件，别触发所在行的展开/收起 */
function copyButton(text) {
  const btn = h('button', 'copy-btn');
  btn.type = 'button';
  btn.append(glyph('copy'), h('span', '', '复制'));
  btn.addEventListener('click', async (event) => {
    event.stopPropagation();
    flashCopied(btn, await copyText(text));
  });
  return btn;
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

function isBusy() {
  return snapshot.phase === 'starting' || snapshot.phase === 'probing';
}

function renderTop() {
  const chip = byId('chip');
  const text = byId('chip-text');
  const total = snapshot.models.length;
  const good = snapshot.models.filter(usable).length;

  let state = 'busy';
  let label = '正在启动';
  if (snapshot.error) {
    state = 'error';
    label = '出错了';
  } else if (snapshot.phase === 'probing') {
    label = snapshot.progress?.total
      ? `检测中 ${snapshot.progress.done}/${snapshot.progress.total}`
      : '检测中';
  } else if (snapshot.phase === 'ready') {
    state = good ? 'ready' : 'ready';
    label = good ? `可用 ${good} 个` : '还没可用模型';
  } else if (snapshot.phase === 'idle') {
    state = 'error';
    label = '已停止';
  }

  chip.dataset.state = state;
  text.textContent = label;
  byId('n-total').textContent = String(total);
  byId('n-usable').textContent = String(good);
  byId('n-pending').textContent = String(snapshot.models.filter((m) => verdictKey(m) === 'wait').length);
}

function renderActions() {
  const locked = isBusy();
  byId('act-read').disabled = locked;
  byId('act-test').disabled = locked || !snapshot.models.length;
  byId('act-retest').disabled = locked || !snapshot.models.length;

  // 服务控制：忙的时候不许动；已经停了就只剩「重启服务」（等于再拉起来）
  const stopped = snapshot.phase === 'idle';
  byId('act-restart').disabled = locked;
  byId('act-stop').disabled = locked || stopped;
}

function renderStatus() {
  const bar = byId('statusbar');
  const lead = byId('status-text');
  const progress = byId('status-progress');

  let state = 'busy';
  let text = '正在启动隔离的 OpenCode';
  if (snapshot.error) {
    state = 'error';
    text = `出错了：${snapshot.error}`;
  } else if (snapshot.phase === 'probing') {
    text = '正在逐个检测模型';
  } else if (snapshot.phase === 'ready') {
    state = 'ready';
    text = '已就绪';
  } else if (snapshot.phase === 'idle') {
    state = 'error';
    text = '已停止';
  }

  bar.dataset.state = state;
  lead.textContent = text;

  if (snapshot.phase === 'probing' && snapshot.progress?.total) {
    progress.hidden = false;
    progress.textContent = `${snapshot.progress.done} / ${snapshot.progress.total}`;
  } else {
    progress.hidden = true;
  }

  byId('fact-endpoint').textContent = snapshot.port ? `127.0.0.1:${snapshot.port}` : '尚未启动';
  // 转发口没起来时没有地址可复制
  byId('act-copy-endpoint').disabled = !snapshot.port;
}

/** 状态栏的方案切换（内嵌/伪装）：选中态跟快照走，切换期间禁用 */
function renderMode() {
  const mode = snapshot.mode === 'masquerade' ? 'masquerade' : 'embedded';
  byId('mode-embedded').setAttribute('aria-pressed', String(mode === 'embedded'));
  byId('mode-masquerade').setAttribute('aria-pressed', String(mode === 'masquerade'));
  const busy = switchingMode || isBusy();
  byId('mode-embedded').disabled = busy;
  byId('mode-masquerade').disabled = busy;
}

/** 状态栏的「路由器广播 / 局域网配置」：状态跟快照走 */
function renderLan() {
  const on = snapshot.lanAccess === true;
  byId('act-lan').setAttribute('aria-pressed', String(on));
  byId('act-lan').textContent = on ? '路由器广播 · 开' : '路由器广播';
  // 配置入口只在开着时有意义（关着的时候本机地址就够了）
  byId('act-lan-info').hidden = !on;
}

const ORDER = { ok: 0, chat: 1, wait: 2, fail: 3 };

function renderList() {
  const scroller = byId('list');
  const keep = scroller.scrollTop;
  const focusedInput = document.activeElement?.classList?.contains('context-window-input')
    ? document.activeElement
    : null;
  const focusedModelId = focusedInput?.dataset.modelId;
  const selection = focusedInput
    ? [focusedInput.selectionStart, focusedInput.selectionEnd, focusedInput.selectionDirection]
    : null;
  const box = byId('rows');
  const frag = document.createDocumentFragment();

  const models = [...snapshot.models].sort(
    (a, b) => ORDER[verdictKey(a)] - ORDER[verdictKey(b)] || a.name.localeCompare(b.name),
  );

  for (const model of models) {
    const open = openRowId === model.id;
    const row = h('div', 'row' + (open ? ' is-open' : ''));
    const main = h('div', 'row-main');

    // 单独重测
    const retest = h('button', 'icon-btn');
    retest.type = 'button';
    retest.title = '只重测这一个';
    retest.setAttribute('aria-label', `只重测 ${model.name}`);
    const spinning = testingIds.has(model.id);
    if (spinning) retest.classList.add('is-spinning');
    retest.disabled = isBusy() || spinning;
    retest.append(glyph('again'));
    retest.addEventListener('click', (event) => {
      event.stopPropagation();
      retestOne(model.id);
    });

    // 名字 + 展开箭头
    const nameBox = h('button', 'model-name');
    nameBox.type = 'button';
    nameBox.setAttribute('aria-expanded', String(open));
    const chevron = glyph('chevron');
    chevron.classList.add('chevron');
    nameBox.append(chevron, h('span', 'label', model.name));
    nameBox.addEventListener('click', (event) => {
      event.stopPropagation();
      toggle(model.id);
    });

    // 模型列两行：上面显示名（点开详情），下面完整 Model ID 小字 + 复制按钮
    const cell = h('div', 'model-cell');
    const idLine = h('div', 'model-id-line');
    idLine.append(h('span', 'model-id', model.id), copyButton(model.id));
    cell.append(nameBox, idLine);

    // 能力标签
    const tags = h('div', 'tags');
    if (model.reasoning) tags.append(h('span', 'tag', '推理'));
    // 推理档位：排除「关闭」档后的中文名用 · 连起来（如「低·高」）；没档位的模型不显示
    const levels = effortLevels(model);
    if (levels.length) {
      const tag = h('span', 'tag', levels.map((e) => EFFORT_NAMES[e] ?? e).join('·'));
      tag.dataset.kind = 'effort';
      tag.title = `推理档位，请求里填英文名：${levels.join(' / ')}`;
      tags.append(tag);
    }
    if (model.images) {
      const t = h('span', 'tag', '图片');
      t.dataset.kind = 'vision';
      tags.append(t);
    }
    if (!tags.childElementCount) tags.append(h('span', 'tag-none', '仅文本'));

    // 状态
    const state = h('span', 'state');
    state.dataset.state = spinning ? 'wait' : verdictKey(model);
    state.append(h('span', 'dot'), h('span', '', spinning ? '检测中…' : verdictText(model)));

    // 耗时
    const timing = h('span', 'timing', timingText(model));

    main.append(retest, cell, tags, state, timing);
    row.append(main);

    if (open) row.append(detailBlock(model));

    main.addEventListener('click', () => toggle(model.id));
    frag.append(row);
  }

  if (!models.length) frag.append(emptyBlock());

  box.replaceChildren(frag);
  scroller.scrollTop = keep;

  // 轮询会重画模型列表；正在输入时恢复焦点和光标，避免每 1.5 秒打断一次。
  if (focusedModelId) {
    const replacement = [...box.querySelectorAll('.context-window-input')]
      .find((input) => input.dataset.modelId === focusedModelId);
    if (replacement) {
      replacement.focus({ preventScroll: true });
      if (selection?.[0] !== null && selection?.[1] !== null) {
        replacement.setSelectionRange(selection[0], selection[1], selection[2] ?? 'none');
      }
    }
  }
}

function toggle(id) {
  openRowId = openRowId === id ? null : id;
  renderList();
}

function detailBlock(model) {
  const wrap = h('div', 'row-detail');

  const grid = h('div', 'detail-grid');
  const field = (key, value) => {
    const cell = h('div');
    cell.append(h('span', 'k', key), h('span', 'v', value));
    grid.append(cell);
  };

  field('完整 ID', model.id);
  field('供应商', model.providerID);
  field('当前生效窗口', contextWindowText(model.contextWindow));
  field('上游原值', upstreamContextWindowText(model.upstreamContextWindow));
  const customWindow = Number.isSafeInteger(model.contextWindowOverride)
    ? `已设置 ${contextWindowText(model.contextWindowOverride)}`
    : '使用上游默认值';
  field(
    '自定义设置',
    model.contextWindowPending ? `${customWindow} · 等待同步，请重试保存或恢复默认` : customWindow,
  );
  const inputs = [model.images && '图片', model.video && '视频', model.pdf && 'PDF'].filter(Boolean);
  field('输入能力', inputs.join('、') || '仅文本');
  field('判定来源', model.cached ? '上次检测留下的缓存' : '本次实际检测');
  if (model.checkedAt) field('判定时间', new Date(model.checkedAt).toLocaleString('zh-CN'));

  wrap.append(grid);

  wrap.append(contextWindowEditor(model));

  // 推理参数片段：两种请求格式各一段可复制；没档位的模型整块不显示
  const efforts = effortBlock(model);
  if (efforts) wrap.append(efforts);

  if (model.note) wrap.append(h('p', 'detail-note', `上游说明：${model.note}`));

  const tools = h('div', 'detail-actions');
  const again = h('button', '', '只重测这一个');
  again.type = 'button';
  again.addEventListener('click', (event) => {
    event.stopPropagation();
    retestOne(model.id);
  });
  tools.append(again);
  wrap.append(tools);

  return wrap;
}

function contextWindowText(value) {
  return Number.isSafeInteger(value) && value > 0 ? `${value.toLocaleString()} tokens` : '未声明';
}

function upstreamContextWindowText(value) {
  if (value === null || value === undefined) return '未声明';
  if (Number.isSafeInteger(value) && value > 0) return `${value.toLocaleString()} tokens`;
  if (typeof value === 'string') return value ? `上游原值：${value}` : '上游给了空值';
  if (typeof value === 'number' && Number.isFinite(value)) return `上游原值：${value}`;
  try {
    return `上游原值：${JSON.stringify(value)}`;
  } catch {
    return '上游原值无法显示';
  }
}

/** 展开详情里的上下文窗口编辑器；草稿单独保存，轮询快照不会覆盖用户输入。 */
function contextWindowEditor(model) {
  let draft = contextWindowDrafts.get(model.id);
  if (!draft) {
    draft = {
      value: Number.isSafeInteger(model.contextWindowOverride) ? String(model.contextWindowOverride) : '',
      error: '',
      saving: false,
      dirty: false,
    };
    contextWindowDrafts.set(model.id, draft);
  }
  if (!draft.dirty && !draft.saving) {
    draft.value = Number.isSafeInteger(model.contextWindowOverride) ? String(model.contextWindowOverride) : '';
  }

  const editor = h('section', 'context-window-editor');
  editor.append(h('div', 'context-window-title', '调整上下文窗口'));

  const label = h('label', 'context-window-label');
  const inputId = `context-window-${encodeURIComponent(model.id)}`;
  const input = h('input', 'context-window-input');
  input.id = inputId;
  input.dataset.modelId = model.id;
  input.type = 'text';
  input.inputMode = 'decimal';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.disabled = draft.saving;
  input.value = draft.value;
  input.placeholder = '例如 200k 或 1m';
  input.setAttribute('aria-describedby', `${inputId}-hint ${inputId}-error`);
  label.htmlFor = inputId;
  label.append(h('span', '', '上下文窗口大小'), input);

  const hint = h('p', 'context-window-hint', '输入 token 数，可写整数、200k 或 1m；1m = 1,000,000 tokens。');
  hint.id = `${inputId}-hint`;
  const error = h('p', 'context-window-error', draft.error);
  error.id = `${inputId}-error`;
  error.setAttribute('role', 'alert');
  error.hidden = !draft.error;

  const actions = h('div', 'context-window-actions');
  const save = h('button', 'mini', draft.saving ? '正在保存…' : '保存');
  save.type = 'button';
  save.disabled = draft.saving || isBusy() || !parseContextWindow(draft.value);
  save.addEventListener('click', () => saveContextWindow(model.id));
  const restore = h('button', 'mini', draft.saving ? '正在保存…' : '恢复默认');
  restore.type = 'button';
  restore.disabled = draft.saving || isBusy() || model.contextWindowOverride == null;
  restore.addEventListener('click', () => saveContextWindow(model.id, null));
  actions.append(save, restore);

  input.addEventListener('input', () => {
    draft.value = input.value;
    draft.error = '';
    draft.dirty = true;
    error.hidden = true;
    save.disabled = draft.saving || isBusy() || !parseContextWindow(draft.value);
  });

  editor.append(label, hint, error, actions);
  return editor;
}

/** 解析 1m / 200k / 整数，并确保最终是正的安全整数。 */
function parseContextWindow(raw) {
  const match = String(raw).trim().match(/^(\d+(?:\.\d+)?)\s*([kKmM])?$/);
  if (!match) return null;
  const unit = match[2]?.toLowerCase();
  const multiplier = unit === 'm' ? 1_000_000 : unit === 'k' ? 1_000 : 1;
  const value = Number(match[1]) * multiplier;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

async function saveContextWindow(id, value) {
  const draft = contextWindowDrafts.get(id);
  if (!draft || draft.saving) return;

  let nextValue = value;
  if (value !== null) {
    nextValue = parseContextWindow(draft.value);
    if (nextValue === null) {
      draft.error = '请输入大于 0 的整数 token 数，例如 200k 或 1m（1m = 1,000,000）。';
      renderList();
      return;
    }
  }

  draft.saving = true;
  draft.error = '';
  renderList();
  try {
    await window.oc.setModelContextWindow(id, nextValue);
  } catch (error) {
    draft.saving = false;
    draft.error = `保存失败：${error?.message ?? error}`;
    renderList();
    return;
  }

  contextWindowDrafts.delete(id);
  let next;
  try {
    next = await window.oc.getState();
    if (!next) throw new Error('没有读到更新后的状态');
    snapshot = next;
  } catch (error) {
    render();
    note(`已保存，但暂时没能读取新状态：${error?.message ?? error}；稍后会自动刷新`, 'error');
    return;
  }
  render();
  const updatedModel = snapshot.models?.find((model) => model.id === id);
  if (updatedModel?.contextWindowPending) {
    note('窗口设置已记录，但还没全部同步；请重试保存或恢复默认', 'error');
  } else {
    note(value === null ? '已恢复上游默认上下文窗口' : '上下文窗口已保存', 'ok');
  }
}

/**
 * 展开详情里的「推理参数」区：Anthropic 与 OpenAI 两种请求格式的可复制片段。
 * 片段里示范的档位取该模型的默认档，默认档为空时用第一个非「关闭」档；
 * 没有档位的模型（不支持推理，或只有「关闭」档）返回 null，整块不显示。
 */
function effortBlock(model) {
  const levels = effortLevels(model);
  if (!levels.length) return null;
  const effort = model.defaultEffort && model.defaultEffort !== 'none' ? model.defaultEffort : levels[0];

  const block = h('div', 'effort-block');
  block.append(h('div', 'effort-title', '推理参数'));
  block.append(
    h('p', 'effort-hint', `片段粘进请求体即可；示范档位是 ${effort}，可换成：${levels.join(' / ')}`),
  );

  const snippet = (label, code) => {
    const box = h('div', 'snippet');
    const head = h('div', 'snippet-head');
    head.append(h('span', 'snippet-label', label), copyButton(code));
    box.append(head, h('code', 'snippet-code', code));
    block.append(box);
  };

  snippet('Anthropic 格式', `"thinking": {"type": "enabled"}, "output_config": {"effort": "${effort}"}`);
  // 模型支持关掉思考时才附关闭写法
  if (model.canDisableThinking) snippet('Anthropic 格式 · 关闭思考', `"thinking": {"type": "disabled"}`);
  snippet('OpenAI 格式', `"reasoning_effort": "${effort}"`);
  return block;
}

function emptyBlock() {
  const box = h('div', 'empty');
  box.append(glyph('boat'));

  if (snapshot.error) {
    box.append(h('h3', '', '模型服务没起来'), h('p', '', '看底部的错误信息，处理完再刷新这个页面。'));
  } else if (snapshot.phase === 'ready') {
    box.append(h('h3', '', '没找到免费模型'), h('p', '', '点上面的「读取模型」重新拉一次目录。'));
  } else {
    box.append(h('h3', '', '正在准备模型服务'), h('p', '', '隔离的 OpenCode 起来后，模型会出现在这里。'));
  }
  return box;
}

/* ------------------------------------------------------------------ */
/* 密钥位：打码/显示/复制/编辑。密钥只经显式请求拿到，快照里永远没有。      */
/* ------------------------------------------------------------------ */

const KEY_MASK = '●●●●●●';
let apiKey = null; // 显式拉来的明文密钥；null = 还没拉到
let keyShown = false; // true = 明文显示
let keyEditing = false; // true = 编辑态（输入框 + 保存/取消）

function renderKey() {
  const loaded = typeof apiKey === 'string' && apiKey.length > 0;
  const text = byId('fact-key');
  const input = byId('key-input');

  text.hidden = keyEditing;
  text.textContent = keyShown && loaded ? apiKey : KEY_MASK;
  input.hidden = !keyEditing;
  if (keyEditing) input.value = apiKey ?? '';

  const show = byId('act-key-show');
  show.hidden = keyEditing;
  show.disabled = !loaded;
  (show.querySelector('span') ?? show).textContent = keyShown ? '隐藏' : '显示';

  const copy = byId('act-key-copy');
  copy.hidden = keyEditing;
  copy.disabled = !loaded;
  const edit = byId('act-key-edit');
  edit.hidden = keyEditing;
  edit.disabled = !loaded;
  byId('act-key-save').hidden = !keyEditing;
  byId('act-key-cancel').hidden = !keyEditing;
}

/** 密钥不进快照，页面起来后显式拉一次 */
async function loadApiKey() {
  const res = await call('读取密钥', () => window.oc.getApiKey());
  if (res && typeof res.key === 'string') {
    apiKey = res.key;
    renderKey();
  }
}

async function saveApiKey() {
  const key = byId('key-input').value;
  const result = await call('保存密钥', () => window.oc.setApiKey(key));
  // 失败也可能是「密钥已保存、同步目标失败」（500），所以成败都回拉一次真实值
  const fresh = await call('读取密钥', () => window.oc.getApiKey());
  if (fresh && typeof fresh.key === 'string') apiKey = fresh.key;
  if (!result) {
    // 错误文案刚才已弹出（含重试指引）；留在编辑态，改完再点保存即可
    renderKey();
    return;
  }
  keyEditing = false;
  keyShown = false;
  renderKey();
  note('已保存，已写入的目标已同步新密钥', 'ok');
  await refreshSnapshot();
}

/* ------------------------------------------------------------------ */
/* 「一键接入」目标区：注册表里每个目标一行，状态来自快照的目标缓存实读      */
/* ------------------------------------------------------------------ */

function renderTargets() {
  const box = byId('targets');
  const frag = document.createDocumentFragment();
  // 快照刚起来时 targets 可能是空数组（状态缓存还没实读过），属正常，先不画行
  const targets = Array.isArray(snapshot.targets) ? snapshot.targets : [];
  const usableCount = snapshot.models.filter(usable).length;
  const locked = isBusy();

  for (const target of targets) {
    const row = h('div', 'target-row');

    const name = h('div', 'target-name');
    name.append(h('span', 'target-label', target.label));

    // 状态文字：没安装 > 已写入 > 未写入
    const status = h('span', 'target-status');
    if (!target.detected) {
      status.textContent = '未检测到安装';
    } else if (target.written) {
      status.textContent = `已写入 ${target.models?.length ?? 0} 个`;
      status.classList.add('is-written');
    } else {
      status.textContent = '未写入';
    }

    const actions = h('div', 'target-actions');
    // 写入：沿用原大按钮的可用性逻辑——没可用模型或服务忙时置灰；已写入也允许重写（幂等）
    const install = h('button', 'mini', '写入');
    install.type = 'button';
    install.disabled = locked || !target.detected || !usableCount;
    install.title = !target.detected
      ? '没检测到这个工具的安装'
      : !usableCount
        ? '还没有可用模型，先点上面「检测全部」'
        : '';
    install.addEventListener('click', () => {
      // 支持选模型的目标：先展开勾选区，不直接写
      if (target.selectsModels) toggleTargetPicker(target);
      else installTarget(target);
    });
    // 移除：只有「当前已写入」才有东西可摘
    const uninstall = h('button', 'mini', '移除');
    uninstall.type = 'button';
    uninstall.disabled = locked || !target.detected || !target.written;
    uninstall.title = !target.detected ? '没检测到这个工具的安装' : '';
    uninstall.addEventListener('click', () => uninstallTarget(target));
    actions.append(install, uninstall);

    row.append(name, status, actions);
    frag.append(row);
    if (openTargetPickerId === target.id) frag.append(targetPicker(target, usableCount, locked));
  }

  box.replaceChildren(frag);
}

/** 这个目标当前可勾选的模型（体检能用的那几个） */
function pickableModels(target) {
  const usableModels = (snapshot.models ?? []).filter(usable);
  const written = Array.isArray(target.models) ? target.models : [];
  // 已写入的按原顺序排前面，没写过的排在后面——重开勾选区时看得见现状
  const writtenFirst = written.map((id) => usableModels.find((model) => model.id === id)).filter(Boolean);
  const rest = usableModels.filter((model) => !written.includes(model.id));
  return [...writtenFirst, ...rest];
}

function toggleTargetPicker(target) {
  if (openTargetPickerId === target.id) {
    openTargetPickerId = null;
    renderTargets();
    return;
  }
  const models = pickableModels(target);
  targetPickerDraft.set(target.id, new Set(models.map((model) => model.id)));
  openTargetPickerId = target.id;
  renderTargets();
}

/** 勾选区：列出可用模型，确认后才写入 */
function targetPicker(target, usableCount, locked) {
  const box = h('div', 'target-picker');
  const models = pickableModels(target);
  const checked = targetPickerDraft.get(target.id) ?? new Set(models.map((model) => model.id));
  box.append(h('div', 'target-picker-title', `选哪几个模型写进 ${target.label}（共 ${models.length} 个可勾）`));

  if (!usableCount) box.append(h('p', 'target-picker-note', '还没有可用模型，先点上面「检测全部」。'));

  const list = h('div', 'target-picker-list');
  for (const model of models) {
    const label = h('label', 'target-picker-item');
    const box2 = h('input', 'target-picker-check');
    box2.type = 'checkbox';
    box2.checked = checked.has(model.id);
    box2.addEventListener('change', () => {
      if (box2.checked) checked.add(model.id);
      else checked.delete(model.id);
      targetPickerDraft.set(target.id, checked);
      const confirm = box.querySelector('.target-picker-confirm');
      if (confirm) confirm.disabled = locked || checked.size === 0;
    });
    const window = Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0
      ? `${model.contextWindow.toLocaleString()} tokens`
      : '窗口未申报';
    label.append(box2, h('span', 'target-picker-name', model.name || model.id), h('span', 'target-picker-window', window));
    list.append(label);
  }
  box.append(list);

  const actions = h('div', 'target-picker-actions');
  const confirm = h('button', 'mini target-picker-confirm', '确认写入');
  confirm.type = 'button';
  confirm.disabled = locked || checked.size === 0;
  confirm.addEventListener('click', () => installTarget(target, [...checked]));
  const cancel = h('button', 'mini', '取消');
  cancel.type = 'button';
  cancel.addEventListener('click', () => {
    openTargetPickerId = null;
    renderTargets();
  });
  actions.append(confirm, cancel);
  box.append(actions);
  return box;
}

function render() {
  renderTop();
  renderActions();
  renderList();
  renderTargets();
  renderStatus();
  renderMode();
  renderLan();
}

/* ------------------------------------------------------------------ */
/* 动作                                                                */
/* ------------------------------------------------------------------ */

async function call(label, fn) {
  try {
    return await fn();
  } catch (error) {
    note(`${label}失败：${error?.message ?? error}`, 'error');
    return null;
  }
}

/** 做完动作立刻回读一次状态，不用等下一轮轮询 */
async function refreshSnapshot() {
  const next = await call('刷新状态', () => window.oc.getState());
  if (next) {
    snapshot = next;
    render();
  }
}

async function readModels() {
  note('正在读取模型目录…');
  const result = await call('读取', () => window.oc.refresh());
  if (!result) return;
  note(`读到 ${result.models} 个免费模型`, 'ok');
  await refreshSnapshot();
}

async function testAll(force) {
  note(force ? '正在强制重测，会消耗多一些免费额度…' : '正在检测，会消耗少量免费额度…');
  const result = await call('检测', () => window.oc.probe({ force: Boolean(force) }));
  if (!result) return;
  const s = result.summary ?? {};
  const bits = [];
  if (s.tool) bits.push(`能用工具 ${s.tool}`);
  if (s.chat) bits.push(`只能聊天 ${s.chat}`);
  if (s.failed) bits.push(`不可用 ${s.failed}`);
  note(`检测完成：${bits.join('、') || '一个都没通过'}`, 'ok');
  await refreshSnapshot();
}

async function retestOne(id) {
  testingIds.add(id);
  renderList();
  const result = await call('重测', () => window.oc.probeOne(id));
  if (result) note(`重测完成：${verdictText(result)}`, 'ok');
  testingIds.delete(id);
  await refreshSnapshot();
}

/** 写入提示：写入了几个、有让位的（撞了用户手写条目）要说一声 */
async function installTarget(target, modelIds) {
  const result = await call('写入', () => window.oc.installTarget(target.id, modelIds));
  if (!result) return;
  openTargetPickerId = null;
  const added = result.added ?? 0;
  // skipped 各目标形状不一（个数或 id 数组），统一成个数
  const skipped = Array.isArray(result.skipped) ? result.skipped.length : (result.skipped ?? 0);
  const bits = [];
  bits.push(
    result.changed === false
      ? `${target.label} 里已经是最新的（${added} 个模型）`
      : `已把 ${added} 个模型写进 ${target.label}`,
  );
  if (skipped > 0) bits.push(`${skipped} 个模型和你手写的条目重名，已让位、没动你的`);
  if (result.disabledBuiltins) bits.push(`顺手摘掉了 ${result.disabledBuiltins} 个借来的模型名`);
  if (target.id === 'zcode' && result.changed !== false) bits.push('重启 ZCode 生效');
  note(bits.join('，'), 'ok');
  await refreshSnapshot();
}

async function uninstallTarget(target) {
  const yes = window.confirm(
    `确定把 OC Faucet 从 ${target.label} 里移除吗？\n\n只会删掉 OC Faucet 自己写入的内容，你手动加的其它配置不受影响。`,
  );
  if (!yes) return;
  const result = await call('移除', () => window.oc.uninstallTarget(target.id));
  if (!result) return;
  note(`已从 ${target.label} 移除 ${result.removed ?? 0} 个模型`, 'ok');
  await refreshSnapshot();
}

/** 切换上游方案（内嵌 ⇄ 伪装）：转发口、密钥、已写入的工具配置都不动 */
async function switchUpstreamMode(mode) {
  if (switchingMode) return;
  if ((snapshot.mode === 'masquerade' ? 'masquerade' : 'embedded') === mode) return;
  switchingMode = true;
  renderMode();
  note(mode === 'masquerade' ? '正在切换到伪装方案（启动 Bun 侧车）…' : '正在切换到内嵌方案…');
  const result = await call('切换方案', () => window.oc.setUpstreamMode(mode));
  switchingMode = false;
  await refreshSnapshot();
  if (result) {
    note(mode === 'masquerade' ? '已切到伪装方案（内置 Bun 侧车直连 zen 免费池）' : '已切到内嵌方案（隔离 OpenCode）', 'ok');
  }
}

/** 路由器广播：开 = 转发口对局域网开放（热重绑，端口/密钥不变） */
async function toggleLanAccess() {
  const enable = !(snapshot.lanAccess === true);
  note(enable ? '正在开启路由器广播…' : '正在关闭路由器广播…');
  const result = await call('切换局域网访问', () => window.oc.setLanAccess(enable));
  await refreshSnapshot();
  if (!result) return;
  note(enable ? '路由器广播已开启：局域网设备可凭密钥接入' : '路由器广播已关闭：转发口回到只听本机', 'ok');
  if (enable) showLanConfig();
}

/** 局域网配置弹窗：地址、密钥、教程（模型 id 点一下就复制） */
async function showLanConfig() {
  const info = await call('局域网配置', () => window.oc.lanInfo());
  if (!info) return;
  const box = byId('lan-addresses');
  box.replaceChildren();
  const addresses = info.addresses?.length ? info.addresses : [];
  if (!addresses.length) {
    box.append(h('span', 'hint', '（没找到局域网地址——设备可能没联网）'));
  }
  for (const entry of addresses) {
    const item = h('button', 'lan-url', `http://${entry.address}:${info.port}`);
    item.type = 'button';
    item.title = '点一下复制';
    item.addEventListener('click', () => {
      navigator.clipboard?.writeText(`http://${entry.address}:${info.port}`).catch(() => {});
      item.classList.add('is-copied');
      setTimeout(() => item.classList.remove('is-copied'), 1200);
    });
    box.append(item);
  }
  byId('lan-key').textContent = info.apiKey ?? '（读不到）';

  const models = byId('lan-models');
  models.replaceChildren();
  for (const id of (info.modelIds ?? []).slice(0, 8)) {
    const chip = h('code', 'lan-model-id', id);
    chip.title = '点一下复制模型 ID';
    chip.addEventListener('click', () => {
      navigator.clipboard?.writeText(id).catch(() => {});
      chip.classList.add('is-copied');
      setTimeout(() => chip.classList.remove('is-copied'), 1200);
    });
    models.append(chip);
  }
  if ((info.modelIds ?? []).length > 8) {
    models.append(h('span', 'hint', ` 等共 ${info.modelIds.length} 个（其余见模型清单）`));
  }

  const dialog = byId('lan-dialog');
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

/** 重启服务：只重启转发口和 OpenCode，控制面板不关；各接入工具的配置不动 */
async function restartService() {
  const yes = window.confirm(
    '重启会把转发口和隔离的 OpenCode 先关掉再拉起来，正在进行的请求会中断。\n\n各接入工具里已写入的配置不会被改动。继续吗？',
  );
  if (!yes) return;
  note('正在重启服务…');
  const next = await call('重启', () => window.oc.restart());
  if (!next) {
    await refreshSnapshot();
    return;
  }
  snapshot = next;
  render();
  note(next.port ? `服务已重启，转发口 127.0.0.1:${next.port}` : '服务已重启', 'ok');
}

/** 关闭服务：停掉转发口和 OpenCode；关停前会把写入各接入工具的配置一并摘除 */
async function stopService() {
  // Web 版关的是整个进程（面板也一起没），桌面版只停服务、窗口还留着
  const where =
    window.oc.panelShell === 'web'
      ? '\n\n这个 Web 面板也会跟着退出，之后要回终端重新启动。'
      : '\n\n窗口会留着，随时可以点「重启服务」再拉起来。';
  const yes = window.confirm(
    `关闭后转发口会停掉，写入各接入工具的 OC Faucet 配置会被一并摘除。${where}\n\n之后重新启动，在「一键接入」区按需再写入即可。继续吗？`,
  );
  if (!yes) return;
  note('正在关闭服务…');
  const result = await call('关闭', () => window.oc.stop());
  if (!result) return;

  if (result.stopping) {
    // Web 版：服务连面板一起退出，这个页面不会再收到状态了
    snapshot = { ...snapshot, phase: 'idle', error: null, progress: null, port: null, upstream: { ready: false, baseUrl: null } };
    render();
    note('服务已关闭，这个面板也停了，可以直接关掉页面。', 'ok');
    return;
  }

  // 桌面版：窗口留着，转发口停了，随时可以点「重启服务」再拉起来
  snapshot = result;
  render();
  note('服务已关闭。点「重启服务」可以再拉起来。', 'ok');
}

async function whereIs(which) {
  const result = await call('查看路径', () =>
    which === 'config' ? window.oc.openZcodeConfig() : window.oc.openLog(),
  );
  if (!result) return;
  // opened === false 表示这个壳子打不开访达（浏览器版），那就把路径给人自己复制
  note(result.opened === false ? `路径：${result.file}` : `已打开：${result.file}`, 'ok');
}

async function loadSettings() {
  const s = await call('读取设置', () => window.oc.getSettings());
  if (!s) return;
  byId('cfg-concurrency').value = s.probeConcurrency;
  byId('cfg-ttl').value = s.probeTtlMinutes;
}

async function saveSettings() {
  const saved = await call('保存设置', () =>
    window.oc.saveSettings({
      probeConcurrency: Number(byId('cfg-concurrency').value),
      probeTtlMinutes: Number(byId('cfg-ttl').value),
    }),
  );
  if (saved) note('设置已保存', 'ok');
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

function wire() {
  byId('act-read').addEventListener('click', readModels);
  byId('act-test').addEventListener('click', () => testAll(false));
  byId('act-retest').addEventListener('click', () => testAll(true));
  byId('act-config-path').addEventListener('click', () => whereIs('config'));
  byId('act-log-path').addEventListener('click', () => whereIs('log'));
  byId('act-restart').addEventListener('click', restartService);
  byId('act-stop').addEventListener('click', stopService);
  byId('mode-embedded').addEventListener('click', () => switchUpstreamMode('embedded'));
  byId('mode-masquerade').addEventListener('click', () => switchUpstreamMode('masquerade'));
  byId('act-lan').addEventListener('click', toggleLanAccess);
  byId('act-lan-info').addEventListener('click', showLanConfig);
  byId('lan-close').addEventListener('click', () => {
    const dialog = byId('lan-dialog');
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  });
  byId('cfg-save').addEventListener('click', saveSettings);

  // 状态栏的 BaseURL 复制；转发口没起来时按钮是灰的，走不到这里
  byId('act-copy-endpoint').addEventListener('click', async (event) => {
    if (!snapshot.port) return;
    flashCopied(event.currentTarget, await copyText(`http://127.0.0.1:${snapshot.port}`));
  });

  // 密钥位：显示/打码切换、复制明文、编辑保存
  byId('act-key-show').addEventListener('click', () => {
    keyShown = !keyShown;
    renderKey();
  });
  byId('act-key-copy').addEventListener('click', async (event) => {
    if (!apiKey) return;
    flashCopied(event.currentTarget, await copyText(apiKey));
  });
  byId('act-key-edit').addEventListener('click', () => {
    keyEditing = true;
    renderKey();
    byId('key-input').focus?.();
  });
  byId('act-key-save').addEventListener('click', saveApiKey);
  byId('act-key-cancel').addEventListener('click', () => {
    keyEditing = false;
    renderKey();
  });
  byId('key-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') saveApiKey();
    if (event.key === 'Escape') {
      keyEditing = false;
      renderKey();
    }
  });
}

function start() {
  initTheme();
  wire();
  renderKey(); // 密钥还没拉到：先画打码态，按钮置灰

  window.oc.onState((next) => {
    if (!next) return;
    snapshot = next;
    render();
  });

  // 桌面壳的 onState 只是被动收主进程推送（动作后才发），闲置时外部手改目标配置
  // 不会反映上来；Web 壳的 onState 自己就在 1.5s 轮询（web/web-client.js），不用补。
  // 所以只有非 Web 壳在这里起同样的轮询；页面藏起来就停表，回前台再续，别在后台空转。
  if (window.oc.panelShell !== 'web') {
    let pollTimer = null;
    const startPolling = () => {
      if (pollTimer === null) pollTimer = setInterval(refreshSnapshot, 1500);
    };
    const stopPolling = () => {
      clearInterval(pollTimer);
      pollTimer = null;
    };
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopPolling();
      else startPolling();
    });
    startPolling();
  }

  refreshSnapshot().then(loadSettings).then(loadApiKey);
}

document.addEventListener('DOMContentLoaded', start);
