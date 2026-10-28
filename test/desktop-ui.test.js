import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const renderer = readFileSync(new URL('../desktop/renderer.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../desktop/style.css', import.meta.url), 'utf8');

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
