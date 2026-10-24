/**
 * WorkBuddy 接入目标（src/target-workbuddy.js）的测试。
 *
 * 接缝沿用 targets.test.js 的打法：临时目录 + OCF_WORKBUDDY_MODELS 环境变量
 * 把 models.json 路径指过去，断言落盘文件的真实内容，绝不碰真实的 ~/.workbuddy。
 * 模块里所有路径都是调用时现读环境变量，所以不用查询串绕模块缓存。
 *
 * 不联网、不起进程；并发写场景用 createWorkbuddyTarget({ _beforeReread }) 这个
 * 测试缝模拟（它在我们写前重读校验之前改文件）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWorkbuddyTarget, OWNER } from '../src/target-workbuddy.js';

const PORT = 41982;
const KEY = 'oc-test-key';

/**
 * 每个测试一个临时目录，环境变量指过去，结束后还原并清理。
 * @returns {Promise<{dir:string, file:string}>}
 */
async function withTempModels(t, initial) {
  const dir = await mkdtemp(join(tmpdir(), 'oc-workbuddy-'));
  const file = join(dir, 'models.json');
  if (initial !== undefined) {
    await writeFile(file, typeof initial === 'string' ? initial : JSON.stringify(initial, null, 2));
  }
  const saved = process.env.OCF_WORKBUDDY_MODELS;
  process.env.OCF_WORKBUDDY_MODELS = file;
  t.after(async () => {
    if (saved === undefined) delete process.env.OCF_WORKBUDDY_MODELS;
    else process.env.OCF_WORKBUDDY_MODELS = saved;
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, file };
}

/** 用户手写的条目（仿本机真实的 MiniMax 条目）：我们的动作一个字段都不许碰它 */
const userEntry = {
  id: 'MiniMax-M3.1-Flash-Preview',
  name: 'MiniMax-M3.1-Flash-Preview',
  vendor: 'Custom',
  url: 'https://api.minimaxi.com/v1',
  apiKey: 'sk-user-handwritten',
  supportsToolCall: true,
  supportsImages: true,
  supportsReasoning: true,
  useCustomProtocol: false,
  reasoning: { defaultEffort: 'max', supportedEfforts: ['low', 'high', 'xhigh', 'medium', 'max'] },
};

/** 推理模型，有 low/high 两档 */
const MODEL_REASONING = {
  id: 'opencode/deepseek-v4.1-flash-free',
  name: 'DeepSeek V4.1 Flash Free',
  reasoning: true,
  variants: { low: { reasoningEffort: 'low' }, high: { reasoningEffort: 'high' } },
  images: false,
  contextWindow: 200000,
};

/** 推理模型，含 none 档 → canDisableThinking 应为 true */
const MODEL_WITH_NONE = {
  id: 'opencode/glm-5.3-flash-free',
  name: 'GLM-5.3-Flash Free',
  reasoning: true,
  variants: {
    none: { reasoningEffort: 'none' },
    medium: { reasoningEffort: 'medium' },
    high: { reasoningEffort: 'high' },
  },
  images: true,
  contextWindow: 131072,
};

/** 推理模型但 OpenCode 没给任何档位 → onlyReasoning（关不掉思考） */
const MODEL_PLAIN_REASONING = {
  id: 'opencode/big-pickle',
  name: 'Big Pickle',
  reasoning: true,
  variants: {},
  images: false,
  contextWindow: null,
};

/** 非推理模型 */
const MODEL_CHAT = {
  id: 'opencode/chatty',
  name: 'Chatty',
  reasoning: false,
  variants: {},
  images: false,
  contextWindow: 64000,
};

/* ------------------------------------------------------------------ */
/* 目标形状 / detect / status                                          */
/* ------------------------------------------------------------------ */

test('目标形状：严格符合「接入目标」接口约定（§14）', () => {
  const target = createWorkbuddyTarget();
  assert.equal(target.id, 'workbuddy');
  assert.equal(target.label, 'WorkBuddy');
  for (const fn of ['detect', 'status', 'install', 'uninstall']) {
    assert.equal(typeof target[fn], 'function', `目标必须实现 ${fn}()`);
  }
});

test('detect：配置目录在就算装了 WorkBuddy，目录都没有才算没装', async (t) => {
  const { dir } = await withTempModels(t, undefined);
  const target = createWorkbuddyTarget();
  assert.equal(target.detect(), true, '目录在（文件还没建也算）');
  process.env.OCF_WORKBUDDY_MODELS = join(dir, 'nope', 'models.json');
  assert.equal(target.detect(), false, '目录都没有才算没装');
});

test('status：实读文件，只认带归属标记的条目，外部改动立刻反映', async (t) => {
  const { file } = await withTempModels(t, [userEntry]);
  const target = createWorkbuddyTarget();

  assert.deepEqual(await target.status(), { written: false, models: [] }, '用户条目不算我们的');

  await target.install([MODEL_CHAT, MODEL_REASONING], { port: PORT, apiKey: KEY });
  assert.deepEqual(await target.status(), { written: true, models: [MODEL_CHAT.id, MODEL_REASONING.id] });

  // 外部把文件改了（比如用户自己清理了），status 必须如实反映
  await writeFile(file, JSON.stringify([userEntry], null, 2));
  assert.deepEqual(await target.status(), { written: false, models: [] });

  // 文件坏掉也不许炸
  await writeFile(file, '{ not json');
  assert.deepEqual(await target.status(), { written: false, models: [] });
});

/* ------------------------------------------------------------------ */
/* install：条目形状与两种文件形态                                       */
/* ------------------------------------------------------------------ */

test('install：文件不存在时新建裸数组，条目字段与推理声明三分支都对', async (t) => {
  const { file } = await withTempModels(t, undefined);
  const target = createWorkbuddyTarget();

  const result = await target.install([MODEL_REASONING, MODEL_WITH_NONE, MODEL_PLAIN_REASONING, MODEL_CHAT], {
    port: PORT,
    apiKey: KEY,
  });
  assert.deepEqual(result, { added: 4, skipped: 0, changed: true });

  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(Array.isArray(saved), '新文件必须是裸数组形态');
  assert.equal(saved.length, 4);

  for (const entry of saved) {
    assert.equal(entry.vendor, 'Custom');
    assert.equal(entry.url, `http://127.0.0.1:${PORT}/v1/chat/completions`, 'url 必须是完整端点路径，不是 base URL');
    assert.equal(entry.apiKey, KEY, '密钥明文写入');
    assert.equal(entry.supportsToolCall, true, '写入的都是体检通过能用工具的模型');
    assert.equal(entry.ocFaucetOwner, OWNER, '归属标记必须带上');
    assert.equal('maxOutputTokens' in entry, false, '不写 maxOutputTokens');
  }

  const [r, n, p, c] = saved;
  assert.equal(r.id, 'opencode/deepseek-v4.1-flash-free');
  assert.equal(r.name, 'OC · DeepSeek V4.1 Flash Free');
  assert.equal(r.maxInputTokens, 200000);
  assert.equal(r.supportsImages, false);
  assert.equal(r.supportsReasoning, true);
  assert.equal('onlyReasoning' in r, false, '有档位的推理模型不写 onlyReasoning');
  assert.deepEqual(r.reasoning, { supportedEfforts: ['low', 'high'], defaultEffort: 'low', canDisableThinking: false });

  assert.equal(n.supportsImages, true, 'supportsImages 跟模型 images 走');
  assert.equal(n.maxInputTokens, 131072);
  assert.deepEqual(n.reasoning, { supportedEfforts: ['medium', 'high'], defaultEffort: 'medium', canDisableThinking: true });

  assert.equal(p.supportsReasoning, true);
  assert.equal(p.onlyReasoning, true, '推理模型但没档位：声明关不掉思考');
  assert.deepEqual(p.reasoning, { supportedEfforts: [], defaultEffort: null, canDisableThinking: false });
  assert.equal('maxInputTokens' in p, false, 'contextWindow 不是正数就不写');

  assert.equal(c.supportsReasoning, false, '非推理模型明确说不支持');
  assert.equal('reasoning' in c, false);
  assert.equal('onlyReasoning' in c, false);
});

test('install：裸数组里的用户手写条目逐字保留，我们的加在后面', async (t) => {
  const { file } = await withTempModels(t, [userEntry]);
  const target = createWorkbuddyTarget();

  await target.install([MODEL_CHAT], { port: PORT, apiKey: KEY });
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(Array.isArray(saved), '裸数组写回仍是裸数组');
  assert.equal(saved.length, 2);
  assert.deepEqual(saved[0], userEntry, '用户手写的 MiniMax 条目一个字段都不许动');
  assert.equal(saved[1].ocFaucetOwner, OWNER);
});

test('install：对象形态写回仍是对象，不认识的顶层字段原样保留', async (t) => {
  const initial = { models: [userEntry], availableModels: [userEntry.id], someOtherTopField: { keep: 'me' } };
  const { file } = await withTempModels(t, initial);
  const target = createWorkbuddyTarget();

  await target.install([MODEL_CHAT], { port: PORT, apiKey: KEY });
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(!Array.isArray(saved) && typeof saved === 'object', '对象形态写回仍是对象');
  assert.deepEqual(saved.someOtherTopField, { keep: 'me' }, '其它顶层字段不许动');
  assert.equal(saved.models.length, 2);
  assert.deepEqual(saved.models[0], userEntry);
  assert.equal(saved.models[1].ocFaucetOwner, OWNER);
});

test('install：id 撞了用户手写条目时让位，该模型跳过不写', async (t) => {
  const clash = { ...userEntry, id: MODEL_CHAT.id, name: '用户自己加的同名条目' };
  const { file } = await withTempModels(t, [clash]);
  const target = createWorkbuddyTarget();

  const result = await target.install([MODEL_CHAT, MODEL_REASONING], { port: PORT, apiKey: KEY });
  assert.equal(result.skipped, 1, '撞 id 的模型要让位');
  assert.equal(result.added, 1);

  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.length, 2);
  assert.deepEqual(saved[0], clash, '用户条目原样保留，绝不能被我们覆盖');
  assert.equal(saved[1].id, MODEL_REASONING.id);
  assert.deepEqual((await target.status()).models, [MODEL_REASONING.id], '让位的模型不算我们的');
});

test('install：端口、密钥、模型清单不合法时人话报错，不动文件', async (t) => {
  const { file } = await withTempModels(t, [userEntry]);
  const before = await readFile(file, 'utf8');
  const target = createWorkbuddyTarget();

  await assert.rejects(() => target.install([MODEL_CHAT], { port: 0, apiKey: KEY }), /端口/);
  await assert.rejects(() => target.install([MODEL_CHAT], { port: PORT, apiKey: '' }), /密钥/);
  await assert.rejects(() => target.install('nope', { port: PORT, apiKey: KEY }), /模型/);
  await assert.rejects(() => target.install([{ name: '没 id' }], { port: PORT, apiKey: KEY }), /模型/);
  assert.equal(await readFile(file, 'utf8'), before, '拒绝时不应该动原文件');
});

/* ------------------------------------------------------------------ */
/* 幂等（含 WorkBuddy 规范化容忍）                                       */
/* ------------------------------------------------------------------ */

test('幂等：重复 install 内容没变就不写盘', async (t) => {
  const { file } = await withTempModels(t, [userEntry]);
  const target = createWorkbuddyTarget();

  await target.install([MODEL_REASONING], { port: PORT, apiKey: KEY });
  const text = await readFile(file, 'utf8');
  const again = await target.install([MODEL_REASONING], { port: PORT, apiKey: KEY });
  assert.equal(again.changed, false, '第二次内容相同，不应该再写盘');
  assert.equal(await readFile(file, 'utf8'), text, '一个字节都不许动');
});

test('幂等：WorkBuddy 规范化（补字段、调键序）后不会误判内容变了', async (t) => {
  const { file } = await withTempModels(t, [userEntry]);
  const target = createWorkbuddyTarget();
  await target.install([MODEL_REASONING, MODEL_CHAT], { port: PORT, apiKey: KEY });

  // 模拟 WorkBuddy 的规范化改写：给我们的条目补 useCustomProtocol、
  // 把条目键序整个倒过来、往 reasoning 里塞它自己的字段。
  const saved = JSON.parse(await readFile(file, 'utf8'));
  const normalized = saved.map((entry) => {
    if (entry?.ocFaucetOwner !== OWNER) return entry;
    const shuffled = {};
    for (const key of Object.keys(entry).reverse()) shuffled[key] = entry[key];
    shuffled.useCustomProtocol = false;
    if (shuffled.reasoning && typeof shuffled.reasoning === 'object') {
      shuffled.reasoning = {
        canDisableThinking: shuffled.reasoning.canDisableThinking,
        defaultEffort: shuffled.reasoning.defaultEffort,
        supportedEfforts: shuffled.reasoning.supportedEfforts,
        extraByWorkbuddy: true,
      };
    }
    return shuffled;
  });
  await writeFile(file, JSON.stringify(normalized, null, 2));
  const text = await readFile(file, 'utf8');

  const again = await target.install([MODEL_REASONING, MODEL_CHAT], { port: PORT, apiKey: KEY });
  assert.equal(again.changed, false, '规范化不该被误判成「内容变了」');
  assert.equal(await readFile(file, 'utf8'), text, '不该写盘，文件保持 WorkBuddy 规范化后的样子');
});

/* ------------------------------------------------------------------ */
/* 锁文件                                                                */
/* ------------------------------------------------------------------ */

test('锁文件：install / uninstall 结束后锁一定放掉', async (t) => {
  const { file } = await withTempModels(t, []);
  const target = createWorkbuddyTarget();
  const lock = `${file}.oc-faucet.lock`;

  await target.install([MODEL_CHAT], { port: PORT, apiKey: KEY });
  assert.equal(existsSync(lock), false, 'install 后要放锁');
  await target.uninstall();
  assert.equal(existsSync(lock), false, 'uninstall 后要放锁');
});

test('锁文件：别人持着新鲜锁时直接报错，文件一个字不动', async (t) => {
  const { file } = await withTempModels(t, [userEntry]);
  const lock = `${file}.oc-faucet.lock`;
  await writeFile(lock, String(Date.now()), 'utf8');
  const before = await readFile(file, 'utf8');

  const target = createWorkbuddyTarget();
  await assert.rejects(() => target.install([MODEL_CHAT], { port: PORT, apiKey: KEY }), /占用|稍后再试/);
  assert.equal(await readFile(file, 'utf8'), before, '被拒时不许动文件');
  assert.equal(existsSync(lock), true, '别人的锁不许顺手删掉');
});

test('锁文件：超过 5 分钟的死锁可以强占', async (t) => {
  const { file } = await withTempModels(t, [userEntry]);
  const lock = `${file}.oc-faucet.lock`;
  await writeFile(lock, String(Date.now() - 10 * 60 * 1000), 'utf8');

  const target = createWorkbuddyTarget();
  const result = await target.install([MODEL_CHAT], { port: PORT, apiKey: KEY });
  assert.equal(result.changed, true, '死锁强占后照常写入');
  assert.equal(existsSync(lock), false, '干完活锁要放掉');
});

/* ------------------------------------------------------------------ */
/* 写前重读校验（并发写防护）                                            */
/* ------------------------------------------------------------------ */

test('写前重读：合并期间文件被改过一次，重新合并保住对方的新内容', async (t) => {
  const { file } = await withTempModels(t, [userEntry]);
  const lateEntry = { id: 'late-comer', name: '并发写进来的', vendor: 'Custom', url: 'https://example.com/v1', apiKey: 'x' };
  let fired = false;
  const target = createWorkbuddyTarget({
    // 测试缝：在我们「写前再读一次」之前改文件，模拟 WorkBuddy 并发改写
    _beforeReread: async () => {
      if (fired) return;
      fired = true;
      const current = JSON.parse(await readFile(file, 'utf8'));
      current.push(lateEntry);
      await writeFile(file, JSON.stringify(current, null, 2));
    },
  });

  const result = await target.install([MODEL_CHAT], { port: PORT, apiKey: KEY });
  assert.equal(result.changed, true);

  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(saved[0], userEntry);
  assert.deepEqual(saved[1], lateEntry, '对方并发写进来的条目必须保住，不能按旧读盖回去');
  assert.equal(saved[2].ocFaucetOwner, OWNER);
});

test('写前重读：文件一直被改就放弃报错，绝不破坏对方内容', async (t) => {
  const { file } = await withTempModels(t, [userEntry]);
  let n = 0;
  const target = createWorkbuddyTarget({
    _beforeReread: async () => {
      n += 1;
      await writeFile(file, JSON.stringify([userEntry, { id: `churn-${n}` }], null, 2));
    },
  });

  await assert.rejects(() => target.install([MODEL_CHAT], { port: PORT, apiKey: KEY }), /放弃|重试/);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.some((e) => e?.ocFaucetOwner === OWNER), false, '我们的条目一行都没写进去');
  assert.equal(existsSync(`${file}.oc-faucet.lock`), false, '放弃也要放锁');
});

/* ------------------------------------------------------------------ */
/* 备份                                                                  */
/* ------------------------------------------------------------------ */

test('备份：每次真写盘前留一份，最多保留最近 5 份', async (t) => {
  const { dir, file } = await withTempModels(t, [userEntry]);
  const target = createWorkbuddyTarget();

  for (let i = 0; i < 7; i++) {
    const r = await target.install([MODEL_CHAT], { port: PORT + i, apiKey: KEY });
    assert.equal(r.changed, true, `端口变了，第 ${i + 1} 次必须真写`);
  }

  const backups = (await readdir(dir))
    .filter((n) => /^models\.json\.oc-faucet-\d+\.bak$/.test(n))
    .sort();
  assert.equal(backups.length, 5, '旧的备份要被清掉，只留最近 5 份');

  const newest = await readFile(join(dir, backups[4]), 'utf8');
  assert.ok(newest.includes(String(PORT + 5)), '最新的备份是上一次写盘前的内容');
  const oldest = await readFile(join(dir, backups[0]), 'utf8');
  assert.ok(oldest.includes(String(PORT + 1)), '最早那份备份已经滚掉了');
});

test('备份：内容没变（幂等不写盘）就不会堆备份', async (t) => {
  const { dir } = await withTempModels(t, [userEntry]);
  const target = createWorkbuddyTarget();

  await target.install([MODEL_CHAT], { port: PORT, apiKey: KEY });
  await target.install([MODEL_CHAT], { port: PORT, apiKey: KEY });
  await target.install([MODEL_CHAT], { port: PORT, apiKey: KEY });

  const backups = (await readdir(dir)).filter((n) => n.includes('.oc-faucet-') && n.endsWith('.bak'));
  assert.equal(backups.length, 1, '只有第一次真写盘那次有备份');
  const text = await readFile(join(dir, backups[0]), 'utf8');
  assert.ok(text.includes('sk-user-handwritten'), '备份里应该是我们改写之前的内容');
});

/* ------------------------------------------------------------------ */
/* uninstall                                                             */
/* ------------------------------------------------------------------ */

test('uninstall：只摘带归属标记的条目，用户手写的逐字保留', async (t) => {
  const { file } = await withTempModels(t, [userEntry]);
  const target = createWorkbuddyTarget();

  await target.install([MODEL_REASONING, MODEL_CHAT], { port: PORT, apiKey: KEY });
  const result = await target.uninstall();
  assert.equal(result.removed, 2);
  assert.equal(result.changed, true);

  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(saved, [userEntry], '文件必须回到只有用户条目的样子');
  assert.deepEqual(await target.status(), { written: false, models: [] });
});

test('uninstall：没装过是安全空操作，文件不存在也不会被新建', async (t) => {
  const { file } = await withTempModels(t, undefined);
  const target = createWorkbuddyTarget();

  assert.deepEqual(await target.uninstall(), { removed: 0, changed: false });
  assert.equal(existsSync(file), false, '不该凭空造出 models.json');

  await target.install([MODEL_CHAT], { port: PORT, apiKey: KEY });
  await target.uninstall();
  assert.deepEqual(await target.uninstall(), { removed: 0, changed: false }, '摘过一次再摘是空操作');
});

/* ------------------------------------------------------------------ */
/* availableModels 同步（仅对象形态、且本来就有这个字段时）               */
/* ------------------------------------------------------------------ */

test('availableModels：对象形态有这个字段时，我们的 id 装时加、卸时摘', async (t) => {
  const initial = { models: [userEntry], availableModels: [userEntry.id] };
  const { file } = await withTempModels(t, initial);
  const target = createWorkbuddyTarget();

  await target.install([MODEL_CHAT, MODEL_REASONING], { port: PORT, apiKey: KEY });
  let saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(saved.availableModels, [userEntry.id, MODEL_CHAT.id, MODEL_REASONING.id], '我们的 id 追加在后面');

  await target.uninstall();
  saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(saved.availableModels, [userEntry.id], '摘除后用户的不动，我们的清干净');
});

test('availableModels：对象形态没有这个字段时不新建', async (t) => {
  const { file } = await withTempModels(t, { models: [userEntry] });
  const target = createWorkbuddyTarget();

  await target.install([MODEL_CHAT], { port: PORT, apiKey: KEY });
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal('availableModels' in saved, false, '本来没有就不新建这个字段');
});

/* ------------------------------------------------------------------ */
/* 坏文件                                                                */
/* ------------------------------------------------------------------ */

test('坏文件：models.json 不是合法 JSON 时报人话，绝不动它', async (t) => {
  const { file } = await withTempModels(t, '{ broken json');
  const before = await readFile(file, 'utf8');
  const target = createWorkbuddyTarget();

  await assert.rejects(() => target.install([MODEL_CHAT], { port: PORT, apiKey: KEY }), /JSON/);
  await assert.rejects(() => target.uninstall(), /JSON/);
  assert.equal(await readFile(file, 'utf8'), before, '坏文件一个字节都不许动');
});
