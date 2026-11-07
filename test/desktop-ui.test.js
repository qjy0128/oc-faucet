import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const renderer = readFileSync(new URL('../desktop/renderer.js', import.meta.url), 'utf8');
const index = readFileSync(new URL('../desktop/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../desktop/style.css', import.meta.url), 'utf8');
const main = readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8');
const preload = readFileSync(new URL('../desktop/preload.cjs', import.meta.url), 'utf8');

function declarations(selector, source = css) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `缺少样式规则：${selector}`);
  return match[1];
}

test('重启与关闭服务的通用确认文案不再单独指向 ZCode', () => {
  const start = renderer.indexOf('async function restartService()');
  const end = renderer.indexOf('async function whereIs(', start);
  assert.ok(start >= 0 && end > start, '要能找到完整的服务控制函数');
  const serviceControls = renderer.slice(start, end);

  assert.doesNotMatch(serviceControls, /ZCode/i);
  assert.match(serviceControls, /各接入工具里已写入的配置不会被改动/);
  assert.match(serviceControls, /写入各接入工具的 OC Faucet 配置会被一并摘除/);
});

test('伪装模式的界面说明明确使用内置 Bun 侧车', () => {
  assert.match(renderer, /正在切换到伪装方案（启动 Bun 侧车）/);
  assert.match(renderer, /已切到伪装方案（内置 Bun 侧车直连 zen 免费池）/);
  assert.match(index, /伪装由随应用打包的 Bun 侧车直连 zen/);
  assert.match(index, /启动应用内置 Bun 侧车直连 zen/);
  assert.doesNotMatch(index, /伪装直连 zen/);
});

test('状态栏允许整组换行，地址、密钥、方案和按钮不会被压成竖排', () => {
  assert.match(declarations('.statusbar'), /flex-wrap:\s*wrap/);
  assert.match(declarations('.statusbar .lead'), /min-width:\s*0/);
  assert.match(declarations('.statusbar #status-text'), /overflow-wrap:\s*anywhere/);

  for (const selector of ['.statusbar .fact-copy', '.statusbar .svc-actions', '.statusbar .fact-mode']) {
    const rule = declarations(selector);
    assert.match(rule, /flex:\s*none/, selector);
    assert.match(rule, /white-space:\s*nowrap/, selector);
  }
  assert.match(declarations('.statusbar .mini'), /white-space:\s*nowrap/);

  const narrow = css.match(/@media\s*\(max-width:\s*1200px\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(narrow, '默认窗口宽度下要有状态栏响应式规则');
  assert.match(declarations('.statusbar .lead', narrow[1]), /flex-basis:\s*100%/);
});

test('应用更新的 IPC 通道全部登记在白名单里，preload 不让界面传 URL 或路径', () => {
  const channels = [
    'oc:update-state',
    'oc:check-update',
    'oc:download-update',
    'oc:cancel-update',
    'oc:open-release-page',
    'oc:show-downloaded-file',
  ];
  for (const channel of channels) {
    assert.ok(main.includes(`'${channel}'`), `主进程缺少通道：${channel}`);
    assert.ok(main.includes(`ipcMain.handle('${channel}'`), `通道没有注册处理器：${channel}`);
  }
  // 发布页与文件定位只由主进程自己取状态里的地址/路径，界面侧两个接口不接收参数
  assert.match(main, /const \{ releaseUrl \} = updater\.getState\(\)/);
  assert.match(main, /const \{ filePath \} = updater\.getState\(\)/);
  assert.match(preload, /openReleasePage: \(\) =>/);
  assert.match(preload, /showDownloadedFile: \(\) =>/);
});

test('更新弹窗有确认、取消、重试、发布说明与定位文件入口，下载有进度条', () => {
  for (const id of ['update-dialog', 'update-title', 'update-lead', 'update-notes', 'update-progress', 'update-error']) {
    assert.ok(index.includes(`id="${id}"`), `缺少元素：${id}`);
  }
  for (const id of ['update-later', 'update-confirm', 'update-cancel', 'update-retry', 'update-open-notes', 'update-show-file']) {
    assert.ok(index.includes(`id="${id}"`), `缺少按钮：${id}`);
  }
  assert.match(renderer, /openUpdateDialog\(\)/);
  assert.match(renderer, /closeUpdateDialog\(\)/);
  assert.match(declarations('.update-progress-bar span'), /width:\s*0%/);
  assert.match(css, /\.update-error\s*\{[^}]*--bad|color:\s*var\(--bad\)/);
});

test('设置区有版本号与手动检查入口，Web 壳不带更新接口时入口保持隐藏', () => {
  assert.ok(index.includes('id="app-version"'));
  assert.ok(index.includes('id="act-check-update"'));
  // 两个入口默认 hidden，由渲染进程检测到桌面接口后再亮出来
  assert.match(index, /id="app-version" class="hint" hidden/);
  assert.match(index, /id="act-check-update" class="mini" type="button" hidden/);
  assert.match(renderer, /const updateSupported = typeof window\.oc\.getUpdateState === 'function';/);
  assert.match(renderer, /if \(!updateSupported\) return;/);
});
