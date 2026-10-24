/**
 * CodeBuddy 接入目标（src/target-codebuddy.js）的测试。
 *
 * 打法同 targets.test.js：每个测试一个临时目录，用 OCF_CODEBUDDY_MODELS
 * 把 models.json 指过去（模块内部调用时现读环境变量，不用绕模块缓存），
 * detect 的两个目录用 createCodebuddyTarget({ detectDirs }) 注入。
 * 断言全部落在临时目录的真实文件上，绝不碰用户真实的 ~/.codebuddy。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCodebuddyTarget, CODEBUDDY_OWNER } from '../src/target-codebuddy.js';

/**
 * 每个测试一个临时目录；initial 给定则先落一份 models.json。
 * @returns {Promise<{dir:string, file:string, target:object}>}
 */
async function withTempCodebuddy(t, initial) {
  const dir = await mkdtemp(join(tmpdir(), 'oc-codebuddy-'));
  const file = join(dir, 'models.json');
  if (initial !== undefined) {
    await writeFile(file, typeof initial === 'string' ? initial : JSON.stringify(initial, null, 2));
  }
  const saved = process.env.OCF_CODEBUDDY_MODELS;
  process.env.OCF_CODEBUDDY_MODELS = file;
  t.after(async () => {
    if (saved === undefined) delete process.env.OCF_CODEBUDDY_MODELS;
    else process.env.OCF_CODEBUDDY_MODELS = saved;
    await rm(dir, { recursive: true, force: true });
  });
  const target = createCodebuddyTarget({ detectDirs: [join(dir, 'cli-home'), join(dir, 'cli-share')] });
  return { dir, file, target };
}

/** 一条形状完整的模型（对齐接口约定 §2 的 Model） */
const MODEL_A = {
  id: 'opencode/deepseek-v4.1-flash-free',
  providerID: 'opencode',
  modelID: 'deepseek-v4.1-flash-free',
  name: 'DeepSeek V4.1 Flash',
  free: true,
  reasoning: false,
  variants: {},
  images: false,
  contextWindow: 200000,
  deprecated: false,
};

/** 第二条：能看图、没有 contextWindow */
const MODEL_B = {
  id: 'opencode/glm-5.3-flash-free',
  providerID: 'opencode',
  modelID: 'glm-5.3-flash-free',
  name: 'GLM 5.3 Flash',
  free: true,
  reasoning: true,
  variants: {},
  images: true,
  contextWindow: null,
  deprecated: false,
};

/** 用户手写的条目：没有归属标记，我们的动作一个字段都不许碰它 */
const userEntry = {
  id: 'my-own-model',
  name: '我自己的模型',
  url: 'https://api.example.com/v1/chat/completions',
  apiKey: 'sk-user-handwritten',
  supportsToolCall: false,
  supportsImages: false,
};

const baseFile = { models: [userEntry] };

const OPTS = { port: 41982, apiKey: 'oc-secret' };

/* ------------------------------------------------------------------ */
/* 接口形状与 detect                                                    */
/* ------------------------------------------------------------------ */

test('形状：id/label 固定，四个方法齐全', () => {
  const target = createCodebuddyTarget();
  assert.equal(target.id, 'codebuddy');
  assert.equal(target.label, 'CodeBuddy');
  for (const fn of ['detect', 'status', 'install', 'uninstall']) {
    assert.equal(typeof target[fn], 'function', `目标必须实现 ${fn}()`);
  }
});

test('detect：两个候选目录有一个在就算装过 CodeBuddy', async (t) => {
  const { dir } = await withTempCodebuddy(t, undefined);
  const a = join(dir, 'a');
  const b = join(dir, 'b');
  const target = createCodebuddyTarget({ detectDirs: [a, b] });
  assert.equal(target.detect(), false, '都不在 → 没装');
  await mkdir(b);
  assert.equal(target.detect(), true, 'CLI 安装目录在 → 装过');
  await rm(b, { recursive: true });
  await mkdir(a);
  assert.equal(target.detect(), true, '配置目录在 → 装过');
});

/* ------------------------------------------------------------------ */
/* install：新建 / 合并 / 让位 / 白名单                                 */
/* ------------------------------------------------------------------ */

test('install：文件不存在时新建 {models:[...]}，条目形状逐字段核对', async (t) => {
  const { file, target } = await withTempCodebuddy(t, undefined);

  const result = await target.install([MODEL_A], OPTS);
  assert.equal(result.changed, true);
  assert.equal(result.added, 1);
  assert.deepEqual(result.skipped, []);

  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(Array.isArray(saved.models), true);
  assert.equal(saved.models.length, 1);
  assert.deepEqual(saved.models[0], {
    id: 'opencode/deepseek-v4.1-flash-free',
    name: 'OC · DeepSeek V4.1 Flash',
    url: 'http://127.0.0.1:41982/v1/chat/completions',
    apiKey: 'oc-secret',
    maxInputTokens: 200000,
    supportsToolCall: true,
    supportsImages: false,
    ocFaucetOwner: 'oc-faucet-v1',
  });
  assert.equal('availableModels' in saved, false, '白名单不存在时不新建');
});

test('install：url 必须是完整 /v1/chat/completions 路径，密钥明文写入', async (t) => {
  const { file, target } = await withTempCodebuddy(t, undefined);
  await target.install([MODEL_A], OPTS);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.match(saved.models[0].url, /^http:\/\/127\.0\.0\.1:41982\/v1\/chat\/completions$/);
  assert.equal(saved.models[0].apiKey, 'oc-secret');
});

test('install：落盘文件权限是 0600（里面有明文密钥）', async (t) => {
  const { file, target } = await withTempCodebuddy(t, undefined);
  await target.install([MODEL_A], OPTS);
  const mode = (await stat(file)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('install：字段纪律——contextWindow 不是正数就不写 maxInputTokens，推理/relatedModels/maxOutputTokens 一律不写', async (t) => {
  const { file, target } = await withTempCodebuddy(t, undefined);
  await target.install([MODEL_A, MODEL_B], OPTS);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  const [a, b] = saved.models;
  assert.equal(a.maxInputTokens, 200000);
  assert.equal('maxInputTokens' in b, false, 'contextWindow 为 null 时不写');
  assert.equal(b.supportsImages, true, 'supportsImages 跟随模型 images');
  for (const entry of saved.models) {
    assert.equal('maxOutputTokens' in entry, false);
    assert.equal('relatedModels' in entry, false);
    for (const key of Object.keys(entry)) {
      assert.doesNotMatch(key, /reason|effort|thinking/i, `不许出现推理字段：${key}`);
    }
  }
});

test('install：合并保留——用户手写的条目逐字不动，我们的追加在后面', async (t) => {
  const { file, target } = await withTempCodebuddy(t, baseFile);
  await target.install([MODEL_A], OPTS);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.models.length, 2);
  assert.deepEqual(saved.models[0], userEntry, '用户手写条目必须逐字保持原样');
  assert.equal(saved.models[1].ocFaucetOwner, CODEBUDDY_OWNER);
});

test('install：id 与用户手写条目冲突时让位（跳过该模型，如实报告）', async (t) => {
  // 模型 id 现在必须带斜杠（assertInstallArgs 的收紧），所以用户条目也用两段式 id 来演撞名
  const userClash = { ...userEntry, id: 'user/handwritten' };
  const clash = { ...MODEL_A, id: userClash.id };
  const { file, target } = await withTempCodebuddy(t, { models: [userClash] });
  const result = await target.install([clash, MODEL_B], OPTS);
  assert.equal(result.added, 1, '只写进不冲突的那条');
  assert.deepEqual(result.skipped, [userClash.id]);

  const saved = JSON.parse(await readFile(file, 'utf8'));
  const kept = saved.models.find((m) => m.id === userClash.id);
  assert.deepEqual(kept, userClash, '用户那条原样保留，不许被覆盖');
  assert.equal(saved.models.filter((m) => m.ocFaucetOwner === CODEBUDDY_OWNER).length, 1);
});

test('install：availableModels 已存在时追加我们的 id，不重复堆', async (t) => {
  const initial = { models: [userEntry], availableModels: ['my-own-model'] };
  const { file, target } = await withTempCodebuddy(t, initial);
  await target.install([MODEL_A, MODEL_B], OPTS);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(saved.availableModels, ['my-own-model', MODEL_A.id, MODEL_B.id]);

  // 再装一次（摘掉一个模型）：白名单跟着换，不堆重复、不留 stale id
  await target.install([MODEL_B], OPTS);
  const again = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(again.availableModels, ['my-own-model', MODEL_B.id]);
});

test('install：availableModels 不存在时不新建（新建白名单会把用户其它模型藏掉）', async (t) => {
  const { file, target } = await withTempCodebuddy(t, baseFile);
  await target.install([MODEL_A], OPTS);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal('availableModels' in saved, false);
});

test('install：文件里的其它顶层字段原样保留', async (t) => {
  const initial = { models: [userEntry], theme: 'dark', custom: { nested: [1, 2, 3] } };
  const { file, target } = await withTempCodebuddy(t, initial);
  await target.install([MODEL_A], OPTS);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.theme, 'dark');
  assert.deepEqual(saved.custom, { nested: [1, 2, 3] });
});

test('install：重复安装幂等——内容没变就不写盘', async (t) => {
  const { file, target } = await withTempCodebuddy(t, baseFile);
  await target.install([MODEL_A], OPTS);
  const first = await stat(file);
  const second = await target.install([MODEL_A], OPTS);
  assert.equal(second.changed, false, '内容相同不该再写盘');
  assert.equal((await stat(file)).mtimeMs, first.mtimeMs);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.models.filter((m) => m.ocFaucetOwner === CODEBUDDY_OWNER).length, 1, '不堆重复条目');
});

test('install：写前备份，同一天只备一份，备份里是改写前的内容', async (t) => {
  const { dir, target } = await withTempCodebuddy(t, baseFile);
  await target.install([MODEL_A], OPTS);
  await target.install([MODEL_A, MODEL_B], { port: 41983, apiKey: 'oc-secret' });
  const backups = (await readdir(dir)).filter((n) => n.includes('oc-faucet-backup-'));
  assert.equal(backups.length, 1, '同一天只备份一次');
  const text = await readFile(join(dir, backups[0]), 'utf8');
  assert.ok(text.includes('sk-user-handwritten'), '备份里应该是我们改写之前的内容');
  assert.equal(JSON.parse(text).models.length, 1);
});

test('install：写入的任何字符串值都不许含 $（CLI 会做 ${VAR} 展开）', async (t) => {
  const evil = { ...MODEL_A, id: 'opencode/${HOME}' };
  const { file, target } = await withTempCodebuddy(t, baseFile);
  const before = await readFile(file, 'utf8');
  await assert.rejects(() => target.install([evil], OPTS), /\$/);
  await assert.rejects(() => target.install([MODEL_A], { port: 41982, apiKey: 'key-$PATH' }), /\$/);
  assert.equal(await readFile(file, 'utf8'), before, '防护触发时一个字段都不许写');
});

test('install：端口或密钥不合法时明确报错，不写坏文件', async (t) => {
  const { file, target } = await withTempCodebuddy(t, baseFile);
  const before = await readFile(file, 'utf8');
  await assert.rejects(() => target.install([MODEL_A], { port: 0, apiKey: 'x' }), /端口/);
  await assert.rejects(() => target.install([MODEL_A], { port: 41982, apiKey: '' }), /密钥/);
  assert.equal(await readFile(file, 'utf8'), before);
});

test('install：models.json 是坏 JSON 时报小白能懂的话，不静默覆盖', async (t) => {
  const { file, target } = await withTempCodebuddy(t, '{ 这不是 json');
  await assert.rejects(
    () => target.install([MODEL_A], OPTS),
    (error) => {
      assert.equal(error.name, 'BridgeError');
      assert.match(error.message, /CodeBuddy/);
      assert.match(error.message, /损坏|无法读取/);
      return true;
    },
  );
  assert.equal(await readFile(file, 'utf8'), '{ 这不是 json', '坏文件不许被覆盖');
});

/* ------------------------------------------------------------------ */
/* status / uninstall                                                  */
/* ------------------------------------------------------------------ */

test('status：实读文件，只收集带归属标记的条目 id', async (t) => {
  const { file, target } = await withTempCodebuddy(t, baseFile);
  assert.deepEqual(await target.status(), { written: false, models: [] });

  await target.install([MODEL_A, MODEL_B], OPTS);
  assert.deepEqual(await target.status(), { written: true, models: [MODEL_A.id, MODEL_B.id] });

  // 外部（用户手动）把文件改了，status 必须如实反映，不许信内存缓存
  await writeFile(file, JSON.stringify(baseFile, null, 2));
  assert.deepEqual(await target.status(), { written: false, models: [] });
});

test('status：文件不存在时如实报没写', async (t) => {
  const { target } = await withTempCodebuddy(t, undefined);
  assert.deepEqual(await target.status(), { written: false, models: [] });
});

test('uninstall：只摘带归属标记的条目，用户手写的与其它字段原样不动', async (t) => {
  const initial = { models: [userEntry], availableModels: ['my-own-model'], theme: 'dark' };
  const { file, target } = await withTempCodebuddy(t, initial);
  await target.install([MODEL_A, MODEL_B], OPTS);

  const result = await target.uninstall();
  assert.equal(result.removed, 2);
  assert.equal(result.changed, true);

  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(saved.models, [userEntry], '只剩用户手写那条，逐字原样');
  assert.deepEqual(saved.availableModels, ['my-own-model'], '白名单同步摘除我们的 id');
  assert.equal(saved.theme, 'dark', '无关顶层字段不动');
  assert.deepEqual(await target.status(), { written: false, models: [] });
});

test('uninstall：没装过是安全空操作；availableModels 不存在时不新建', async (t) => {
  const { file, target } = await withTempCodebuddy(t, baseFile);
  const result = await target.uninstall();
  assert.deepEqual(result, { removed: 0, changed: false });
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(saved, baseFile);
  assert.equal('availableModels' in saved, false);
});
