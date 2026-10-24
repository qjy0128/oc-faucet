/**
 * DSH（DeepSeek Harness）接入目标的测试。
 *
 * DSH 的自定义供应商配置在 ~/.dsh/profiles/desktop/cordis.patch.yml，
 * 测试用 OCF_DSH_PATCH 把它指到临时目录，绝不碰真实 HOME。
 * 路径是调用时现读环境变量的，不需要查询串绕模块缓存。
 * 全程不联网、不起进程。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDshTarget } from '../src/target-dsh.js';

/**
 * 每个测试一个临时目录；makeDir=false 用来模拟「DSH 根本没装」。
 * @returns {Promise<{dir:string, confDir:string, file:string}>}
 */
async function withTempDsh(t, { initial, makeDir = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'oc-dsh-'));
  const confDir = join(dir, 'desktop');
  if (makeDir) await mkdir(confDir, { recursive: true });
  const file = join(confDir, 'cordis.patch.yml');
  if (initial !== undefined) await writeFile(file, initial);
  const saved = process.env.OCF_DSH_PATCH;
  process.env.OCF_DSH_PATCH = file;
  t.after(async () => {
    if (saved === undefined) delete process.env.OCF_DSH_PATCH;
    else process.env.OCF_DSH_PATCH = saved;
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, confDir, file };
}

/** 推理模型：有 none/low/high 三档、能看图、200k 上下文 */
const REASONING = {
  id: 'opencode/big-pickle',
  name: 'big-pickle',
  reasoning: true,
  images: true,
  contextWindow: 200000,
  variants: {
    none: { reasoningEffort: 'none' },
    low: { reasoningEffort: 'low' },
    high: { reasoningEffort: 'high' },
  },
};

/** 纯聊天模型：不推理、不看图、没上下文数 */
const CHAT = {
  id: 'opencode/quick-chat',
  name: 'quick-chat',
  reasoning: false,
  images: false,
  contextWindow: null,
  variants: {},
};

/** 推理但关不掉思考（没有 none 档），档位 minimal/medium */
const NO_OFF = {
  id: 'opencode/thinker',
  name: 'thinker',
  reasoning: true,
  images: false,
  contextWindow: 131072,
  variants: {
    minimal: { reasoningEffort: 'minimal' },
    medium: { reasoningEffort: 'medium' },
  },
};

/** 只有 none 档的推理模型：能关思考，但没有任何可调档位 */
const NONE_ONLY = {
  id: 'opencode/on-or-off',
  name: 'on-or-off',
  reasoning: true,
  images: false,
  contextWindow: null,
  variants: {
    none: { reasoningEffort: 'none' },
  },
};

/** 用户或别的工具手写的 llm-pi-ai 节：我们的动作一行都不许碰它 */
const USER_LLM_PI_AI = [
  '- id: llm-pi-ai',
  "  name: '@deepseek-ai/dsh-llm-pi-ai'",
  '  config:',
  '    providers:',
  '      my-own:',
  '        displayName: 我自己手写的供应商',
  '        api: openai-completions',
  '        baseURL: https://example.com/v1',
].join('\n');

/* ------------------------------------------------------------------ */
/* detect                                                              */
/* ------------------------------------------------------------------ */

test('detect：配置目录存在即视为已安装（补丁文件在不在都行）', async (t) => {
  const { file } = await withTempDsh(t);
  const target = createDshTarget();
  assert.equal(target.detect(), true, '目录在、文件还没生成，也算装过');
  await writeFile(file, '# hi\n');
  assert.equal(target.detect(), true);
});

test('detect：连配置目录都没有才算没安装', async (t) => {
  await withTempDsh(t, { makeDir: false });
  assert.equal(createDshTarget().detect(), false);
});

/* ------------------------------------------------------------------ */
/* status                                                              */
/* ------------------------------------------------------------------ */

test('status：三态以文件真实内容为准，不信内存缓存', async (t) => {
  const { file } = await withTempDsh(t);
  const target = createDshTarget();

  assert.deepEqual(await target.status(), { written: false, models: [] }, '文件不存在');

  await writeFile(file, `${USER_LLM_PI_AI}\n`);
  assert.deepEqual(await target.status(), { written: false, models: [] }, '有别人的 llm-pi-ai 节但没有我们的标记块');

  await target.install([REASONING, CHAT], { port: 41982, apiKey: 'oc-secret' });
  assert.deepEqual(
    await target.status(),
    { written: true, models: ['opencode/big-pickle', 'opencode/quick-chat'] },
    '装上后如实读出模型 id 列表',
  );

  // 外部（DSH 自己或用户）把文件改了：status 必须如实反映
  await writeFile(file, `${USER_LLM_PI_AI}\n`);
  assert.deepEqual(await target.status(), { written: false, models: [] }, '外部清掉块后要如实反映');
});

/* ------------------------------------------------------------------ */
/* install                                                             */
/* ------------------------------------------------------------------ */

test('install：文件不存在时新建，内容逐字节符合约定形状，权限 0600', async (t) => {
  const { file } = await withTempDsh(t);
  const target = createDshTarget();
  const result = await target.install([REASONING], { port: 41982, apiKey: 'oc-secret' });
  assert.deepEqual(result, { added: 1, changed: true });

  const expected = [
    '# >>> oc-faucet >>>',
    '- id: "llm-pi-ai"',
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    '  config:',
    '    providers:',
    '      oc-faucet:',
    '        displayName: "OC Faucet"',
    '        api: anthropic-messages',
    '        baseURL: "http://127.0.0.1:41982"',
    '        headers:',
    '          x-api-key: "oc-secret"',
    '        compat:',
    '          forceAdaptiveThinking: true',
    '        models:',
    '          - id: "opencode/big-pickle"',
    '            name: "OC · big-pickle"',
    '            contextWindow: 200000',
    '            input: [text, image]',
    '            reasoningEfforts:',
    '              off:',
    '              low: low',
    '              high: high',
    '# <<< oc-faucet <<<',
    '',
  ].join('\n');
  assert.equal(await readFile(file, 'utf8'), expected);
  assert.equal((await stat(file)).mode & 0o777, 0o600, '补丁文件必须保持 0600');
});

test('install：reasoningEfforts 按各模型真实档位生成，非推理模型不写', async (t) => {
  const { file } = await withTempDsh(t);
  await createDshTarget().install([REASONING, NO_OFF, CHAT], { port: 41982, apiKey: 'k' });
  const text = await readFile(file, 'utf8');

  // 有 none 档的模型：off（值留空 = 发 thinking:{type:disabled}）+ 其余档位原样
  assert.match(text, /reasoningEfforts:\n {14}off:\n {14}low: low\n {14}high: high\n/);
  // 没有 none 档的推理模型：不写 off，其余档位原样
  assert.match(text, /reasoningEfforts:\n {14}minimal: minimal\n {14}medium: medium\n/);

  // 非推理模型那一节：完全没有 reasoningEfforts，没有 contextWindow，input 只有 text
  const chatSection = text.split('- id: "opencode/quick-chat"')[1];
  assert.ok(chatSection, '聊天模型那一节得在');
  assert.ok(!chatSection.includes('reasoningEfforts'), '非推理模型不写 reasoningEfforts');
  assert.ok(!chatSection.includes('contextWindow'), '没有正数 contextWindow 就不写这一行');
  assert.ok(chatSection.includes('input: [text]'), '不看图的模型只声明 text');
  // 不看图也不许出现 image
  assert.ok(!chatSection.includes('image'), '不看图的模型不许出现 image');
});

test('install：只有 none 档的模型整个 reasoningEfforts 节不写（只写 off 的表在 DSH schema 里非法）', async (t) => {
  const { file } = await withTempDsh(t);
  await createDshTarget().install([NONE_ONLY, REASONING], { port: 41982, apiKey: 'k' });
  const text = await readFile(file, 'utf8');

  // 只有 none 档：没有任何非 none 档可写，整张表都不能出现
  // （llm-pi-ai 的 schema 里「只有 off 一个键」的 reasoningEfforts 是非法的）
  const noneOnlySection = text.split('- id: "opencode/on-or-off"')[1]?.split('- id:')[0];
  assert.ok(noneOnlySection, 'none-only 模型那一节得在');
  assert.ok(!noneOnlySection.includes('reasoningEfforts'), 'none-only 模型不写 reasoningEfforts');
  assert.ok(!noneOnlySection.includes('off:'), '也不许只写一个 off 键');

  // none + 其它档：off 照样写（值留空），其它档位原样在
  const reasoningSection = text.split('- id: "opencode/big-pickle"')[1];
  assert.match(reasoningSection, /reasoningEfforts:\n {14}off:\n {14}low: low\n {14}high: high\n/);
});

test('install：已有内容（含别人手写的 llm-pi-ai 节）逐字节保留，我们的块独立追加', async (t) => {
  const original = `${USER_LLM_PI_AI}\n- id: some-other-plugin\n  name: 'some-package'\n  config: {}\n`;
  const { file } = await withTempDsh(t, { initial: original });
  const target = createDshTarget();

  await target.install([CHAT], { port: 41982, apiKey: 'k' });
  const text = await readFile(file, 'utf8');
  assert.ok(text.startsWith(original), '原有内容必须逐字节保留在最前面');
  assert.ok(text.includes('# >>> oc-faucet >>>'), '我们的块独立追加在文件尾');
  assert.ok(
    text.indexOf('- id: llm-pi-ai') < text.indexOf('# >>> oc-faucet >>>'),
    '手写的 llm-pi-ai 节在前、我们的块在后，互不干扰',
  );
  // status 只认我们标记块里的模型，手写的节不算
  assert.deepEqual(await target.status(), { written: true, models: ['opencode/quick-chat'] });
});

test('install：原文件末尾没有换行也能正确接续，不与我们的块粘连', async (t) => {
  const original = '- id: other-plugin\n  name: x';
  const { file } = await withTempDsh(t, { initial: original });
  await createDshTarget().install([CHAT], { port: 41982, apiKey: 'k' });
  const text = await readFile(file, 'utf8');
  assert.ok(text.startsWith(`${original}\n# >>> oc-faucet >>>\n`), '先补换行再追加，标记从行首开始');
});

test('install：幂等——同样的内容再装一次不写盘、不重复备份', async (t) => {
  const { file, confDir } = await withTempDsh(t, { initial: '- id: other\n  name: x\n' });
  const target = createDshTarget();

  const first = await target.install([REASONING], { port: 41982, apiKey: 'k' });
  assert.equal(first.changed, true);
  const content1 = await readFile(file, 'utf8');
  const mtime1 = (await stat(file)).mtimeMs;

  const second = await target.install([REASONING], { port: 41982, apiKey: 'k' });
  assert.equal(second.changed, false, '同样的内容再装一次不算改动');
  assert.equal(second.added, 1);
  assert.equal(await readFile(file, 'utf8'), content1, '内容一个字节都不变');
  assert.equal((await stat(file)).mtimeMs, mtime1, '根本没写盘');

  const backups = (await readdir(confDir)).filter((n) => n.includes('oc-faucet-backup-'));
  assert.equal(backups.length, 1, '同一天只备一份，幂等重装不堆备份');
});

test('install：换一批模型时整块替换，不留旧模型的残迹', async (t) => {
  const { file } = await withTempDsh(t);
  const target = createDshTarget();
  await target.install([REASONING, CHAT], { port: 41982, apiKey: 'k' });
  await target.install([NO_OFF], { port: 41982, apiKey: 'k' });

  const text = await readFile(file, 'utf8');
  assert.ok(!text.includes('big-pickle'), '旧模型要被清掉');
  assert.ok(!text.includes('quick-chat'), '旧模型要被清掉');
  assert.ok(text.includes('thinker'));
  assert.equal(text.match(/# >>> oc-faucet >>>/g).length, 1, '标记块只能有一份');
  assert.deepEqual(await target.status(), { written: true, models: ['opencode/thinker'] });
});

test('install：空模型清单也合法（写 models: []）', async (t) => {
  const { file } = await withTempDsh(t);
  const result = await createDshTarget().install([], { port: 41982, apiKey: 'k' });
  assert.deepEqual(result, { added: 0, changed: true });
  const text = await readFile(file, 'utf8');
  assert.ok(text.includes('models: []'), '空清单写成 models: []，不留一个悬空的 null 键');
  assert.deepEqual(await createDshTarget().status(), { written: true, models: [] });
});

test('install：密钥/模型名带冒号、井号、空格、引号时，YAML 值一律双引号转义，不写坏文件', async (t) => {
  const { file } = await withTempDsh(t);
  const target = createDshTarget();
  // 这种密钥在裸 YAML 里会直接写坏：「: 」是键值分隔、「 #」会吃掉后半截、首尾空格会被吞
  const trickyKey = 'sk: live #key ';
  const model = { ...CHAT, id: 'opencode/weird: model', name: '带"引号"的名字' };

  await target.install([model], { port: 41982, apiKey: trickyKey });
  const text = await readFile(file, 'utf8');

  // 所有插值字符串都必须是 JSON 风格的双引号标量
  assert.ok(text.includes(`x-api-key: ${JSON.stringify(trickyKey)}`), '密钥必须加引号转义');
  assert.ok(text.includes('baseURL: "http://127.0.0.1:41982"'), 'baseURL 也要加引号');
  assert.ok(text.includes(`- id: ${JSON.stringify(model.id)}`), '模型 id 必须加引号转义');
  assert.ok(text.includes(`name: ${JSON.stringify(`OC · ${model.name}`)}`), '模型名必须加引号转义');
  assert.ok(!text.includes(`x-api-key: ${trickyKey}`), '不许再出现裸写的密钥');

  // 写出去还得能读回来：status 认得出带引号的模型 id
  assert.deepEqual(await target.status(), { written: true, models: [model.id] }, '引号形态也要能实读回来');
});

test('install：写前备份，一天一份，内容是写入前的原文', async (t) => {
  const original = `${USER_LLM_PI_AI}\n`;
  const { confDir } = await withTempDsh(t, { initial: original });
  const target = createDshTarget();

  await target.install([CHAT], { port: 41982, apiKey: 'k' });
  const stamp = new Date().toISOString().slice(0, 10);
  const backup = join(confDir, `cordis.patch.yml.oc-faucet-backup-${stamp}`);
  assert.equal(await readFile(backup, 'utf8'), original, '备份的是写入前的原文');

  // 同一天再写（端口变了、内容确实变了），不许覆盖已有的备份
  const r = await target.install([CHAT], { port: 10000, apiKey: 'k' });
  assert.equal(r.changed, true);
  assert.equal(await readFile(backup, 'utf8'), original, '同一天不重复备份');
});

test('install：参数不合法要报人话，且不碰文件', async (t) => {
  const { file } = await withTempDsh(t);
  const target = createDshTarget();
  await assert.rejects(() => target.install([CHAT], { port: 0, apiKey: 'k' }), /端口/);
  await assert.rejects(() => target.install([CHAT], { port: 41982, apiKey: '' }), /密钥/);
  await assert.rejects(() => target.install('not-array', { port: 41982, apiKey: 'k' }), /模型/);
  assert.equal(existsSync(file), false, '校验失败不许创建文件');
});

test('install：标记块损坏（只有头没有尾）时报错，而不是瞎改', async (t) => {
  await withTempDsh(t, { initial: `- id: a\n  name: x\n# >>> oc-faucet >>>\n- id: llm-pi-ai\n` });
  await assert.rejects(() => createDshTarget().install([CHAT], { port: 41982, apiKey: 'k' }), /标记块/);
});

/* ------------------------------------------------------------------ */
/* uninstall                                                           */
/* ------------------------------------------------------------------ */

test('uninstall：只删标记块，其余内容逐字节保留', async (t) => {
  const original = `${USER_LLM_PI_AI}\n- id: another\n  name: y\n`;
  const { file } = await withTempDsh(t, { initial: original });
  const target = createDshTarget();

  await target.install([REASONING, CHAT], { port: 41982, apiKey: 'k' });
  const result = await target.uninstall();
  assert.deepEqual(result, { removed: 1, changed: true });
  assert.equal(await readFile(file, 'utf8'), original, '摘除后应回到安装前的原文，别人手写的一行不动');
  assert.deepEqual(await target.status(), { written: false, models: [] });
});

test('uninstall：没装过是安全空操作，不动文件也不创建文件', async (t) => {
  const original = `${USER_LLM_PI_AI}\n`;
  const { file } = await withTempDsh(t, { initial: original });
  const target = createDshTarget();

  const noop = await target.uninstall();
  assert.deepEqual(noop, { removed: 0, changed: false });
  assert.equal(await readFile(file, 'utf8'), original, '空操作不许动文件');

  // 文件压根不存在的情况
  await rm(file);
  const noop2 = await target.uninstall();
  assert.deepEqual(noop2, { removed: 0, changed: false });
  assert.equal(existsSync(file), false, '不许凭空创建文件');
});
