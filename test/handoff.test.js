/**
 * handoff.js 的测试：转交映射全部是纯函数，这里直接对着表跑。
 *
 * 口径来自真机实测：
 *   - 只映射到客户端本次申报了的工具；
 *   - 只填目标 schema 里存在的字段；
 *   - 必填项凑不齐就不转交（返回 null）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildHandoff, handoffInput, rejectFeedback } from '../src/handoff.js';

/** 造一个 OpenAI 形状的工具定义（protocol.js 归一后的形状） */
function tool(name, { properties = {}, required } = {}) {
  return { type: 'function', function: { name, description: '', parameters: { type: 'object', properties, ...(required ? { required } : {}) } } };
}

const READ = tool('Read', {
  properties: { file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } },
  required: ['file_path'],
});
const BASH = tool('Bash', {
  properties: { command: { type: 'string' }, description: { type: 'string' }, timeout: { type: 'number' } },
  required: ['command'],
});
const GREP = tool('Grep', {
  properties: { pattern: { type: 'string' }, path: { type: 'string' }, output_mode: { type: 'string' } },
  required: ['pattern'],
});

/* ------------------------------------------------------------------ */
/* buildHandoff                                                        */
/* ------------------------------------------------------------------ */

test('buildHandoff：read（filePath 写法）→ Read，字段名翻译成 file_path', () => {
  const call = buildHandoff({ native: 'read', input: { filePath: '/tmp/a.txt' }, tools: [READ] });
  assert.deepEqual(call, { name: 'Read', arguments: { file_path: '/tmp/a.txt' } });
});

test('buildHandoff：read 的 path 写法也认，可选字段一起带走', () => {
  const call = buildHandoff({ native: 'read', input: { path: '/tmp/a.txt', offset: 10, limit: 5 }, tools: [READ] });
  assert.deepEqual(call, { name: 'Read', arguments: { file_path: '/tmp/a.txt', offset: 10, limit: 5 } });
});

test('buildHandoff：bash → Bash，command 必填齐了才转交', () => {
  const call = buildHandoff({ native: 'bash', input: { command: 'ls -la', description: '列目录' }, tools: [BASH] });
  assert.deepEqual(call, { name: 'Bash', arguments: { command: 'ls -la', description: '列目录' } });
});

test('buildHandoff：必填项缺失 → null（半截参数比没有参数更危险）', () => {
  assert.equal(buildHandoff({ native: 'bash', input: { description: '忘了写命令' }, tools: [BASH] }), null);
  assert.equal(buildHandoff({ native: 'read', input: { offset: 1 }, tools: [READ] }), null);
});

test('buildHandoff：目标工具客户端没申报 → 换下一个候选，都没有就 null', () => {
  // 客户端只申报了 Grep：glob 的候选 Glob/LS 都不在，转不了
  assert.equal(buildHandoff({ native: 'glob', input: { pattern: '*.js' }, tools: [GREP] }), null);
  // grep 的候选顺序是 Grep、Search：申报了哪个就用哪个的名字
  const search = tool('Search', { properties: { pattern: { type: 'string' } }, required: ['pattern'] });
  assert.deepEqual(
    buildHandoff({ native: 'grep', input: { pattern: 'handoff' }, tools: [search] }),
    { name: 'Search', arguments: { pattern: 'handoff' } },
  );
});

test('buildHandoff：目标 schema 里不存在的字段直接丢弃，不会塞给客户端', () => {
  const call = buildHandoff({ native: 'read', input: { filePath: '/tmp/a.txt', nonsense: 'x' }, tools: [READ] });
  assert.deepEqual(call, { name: 'Read', arguments: { file_path: '/tmp/a.txt' } });
});

test('buildHandoff：多候选目标字段按序试，客户端申报哪个写法就落哪个', () => {
  // glob 的 path 字段候选 ['path','directory']：LS 只认 directory 时要落到 directory
  const ls = tool('LS', { properties: { pattern: { type: 'string' }, directory: { type: 'string' } }, required: ['pattern'] });
  assert.deepEqual(
    buildHandoff({ native: 'glob', input: { pattern: '*.js', path: '/tmp' }, tools: [ls] }),
    { name: 'LS', arguments: { pattern: '*.js', directory: '/tmp' } },
  );
});

test('buildHandoff：原生名不认识 / 空工具表 / 空参数 → 一律 null', () => {
  assert.equal(buildHandoff({ native: 'webfetch', input: { url: 'x' }, tools: [READ] }), null);
  assert.equal(buildHandoff({ native: 'read', input: { filePath: '/tmp/a' }, tools: [] }), null);
  assert.equal(buildHandoff({ native: 'read', input: {}, tools: [READ] }), null);
  assert.equal(buildHandoff({ native: undefined, input: {}, tools: [READ] }), null);
});

test('buildHandoff：edit 的别名（multiedit/patch）也认，oldString 译成 old_string', () => {
  const edit = tool('Edit', {
    properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } },
    required: ['file_path', 'old_string', 'new_string'],
  });
  for (const native of ['edit', 'multiedit', 'patch']) {
    assert.deepEqual(
      buildHandoff({ native, input: { filePath: '/tmp/a', oldString: 'x', newString: 'y' }, tools: [edit] }),
      { name: 'Edit', arguments: { file_path: '/tmp/a', old_string: 'x', new_string: 'y' } },
      `别名 ${native} 也要能翻译`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* handoffInput                                                        */
/* ------------------------------------------------------------------ */

test('handoffInput：part 的 input 为主，审批 metadata 只补缺', () => {
  // 同一个键 part 里有值时以 part 为准（filepath 不会覆盖 filePath）；
  // part 里没有的键（command）由 metadata 独立补上——兜底是按键各自补缺，不挑动作类别
  const input = handoffInput(
    { tool: 'read', input: { filePath: '/from-part.txt' } },
    { metadata: { command: 'cat x', filepath: '/from-permission.txt' } },
  );
  assert.deepEqual(input, { filePath: '/from-part.txt', command: 'cat x' });
});

test('handoffInput：part 还在等审批、input 为空时，从 metadata 兜底', () => {
  const bash = handoffInput({ tool: 'bash', input: {} }, { metadata: { command: 'ls' } });
  assert.deepEqual(bash, { command: 'ls' });

  const read = handoffInput(null, { metadata: { filepath: '/tmp/x' } });
  assert.deepEqual(read, { filePath: '/tmp/x' });

  const grep = handoffInput(null, { metadata: { patterns: ['foo', 'bar'] } });
  assert.deepEqual(grep, { pattern: 'foo' });
});

test('handoffInput：两边都没有 → 空对象', () => {
  assert.deepEqual(handoffInput(null, null), {});
  assert.deepEqual(handoffInput({ tool: 'read' }, { metadata: {} }), {});
});

/* ------------------------------------------------------------------ */
/* rejectFeedback                                                      */
/* ------------------------------------------------------------------ */

test('rejectFeedback：点名工具并说明原因，指回信封格式', () => {
  const text = rejectFeedback('read', '参数对不上外部工具的 schema');
  assert.match(text, /read/);
  assert.match(text, /参数对不上/);
  assert.match(text, /calls/);
  // 拿不到工具名时也不能是空指针式的文案
  assert.match(rejectFeedback(null, '原因'), /本机工具/);
});
