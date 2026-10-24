/**
 * qoder 接入目标（src/target-qoder.js）的测试。
 *
 * 打法与 targets.test.js 相同：临时目录 + OCF_QODER_SETTINGS 环境变量把
 * settings.json 路径指过去，断言落盘文件的真实内容，绝不碰真实的 ~/.qoder。
 * 路径是调用时现读的，不需要绕模块缓存。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createQoderTarget, createQoderCnTarget, PROVIDER_KEY } from '../src/target-qoder.js';

/**
 * 每个测试一个临时目录，环境变量指过去，结束后还原并清理。
 * @returns {Promise<{dir:string, file:string}>}
 */
async function withTempQoder(t, initial) {
  const dir = await mkdtemp(join(tmpdir(), 'oc-qoder-'));
  const file = join(dir, 'settings.json');
  if (initial !== undefined) {
    await writeFile(file, typeof initial === 'string' ? initial : JSON.stringify(initial, null, 2));
  }
  const saved = process.env.OCF_QODER_SETTINGS;
  process.env.OCF_QODER_SETTINGS = file;
  t.after(async () => {
    if (saved === undefined) delete process.env.OCF_QODER_SETTINGS;
    else process.env.OCF_QODER_SETTINGS = saved;
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, file };
}

/** 用户手写的另一个供应商：我们的动作一个字段都不许碰它 */
const userProvider = {
  protocol: 'openai',
  authType: 'api-key',
  baseUrl: 'https://api.deepseek.com',
  apiKey: 'sk-user-handwritten',
  displayName: '我自己的 DeepSeek',
  model: 'deepseek-chat',
  models: [{ model: 'deepseek-chat', displayName: 'deepseek-chat' }],
};

/** 一份「用户已经在用 qoder」的设置：顶层默认模型 / mcpServers / hooks / 别家供应商 */
const baseSettings = {
  model: 'qoder-user-default',
  mcpServers: { 'my-mcp': { command: 'npx', args: ['-y', 'some-mcp'] } },
  hooks: { 'pre-tool': ['echo hi'] },
  providers: { 'my-deepseek': userProvider },
};

/** 能力齐全的模型：能看图、有推理档位、带上下文窗口 */
const MODEL_FULL = {
  id: 'opencode/glm-5.3-flash-free',
  providerID: 'opencode',
  modelID: 'glm-5.3-flash-free',
  name: 'GLM-5.3-Flash Free',
  free: true,
  reasoning: true,
  variants: { low: { reasoningEffort: 'low' }, high: { reasoningEffort: 'high' } },
  images: true,
  contextWindow: 200000,
  deprecated: false,
};

/** 朴素模型：不看图、reasoning 但没档位、不知道上下文窗口 */
const MODEL_PLAIN = {
  id: 'opencode/big-pickle',
  providerID: 'opencode',
  modelID: 'big-pickle',
  name: 'Big Pickle',
  free: true,
  reasoning: true,
  variants: {},
  images: false,
  contextWindow: null,
  deprecated: false,
};

/** 非推理模型 */
const MODEL_CHAT = { ...MODEL_PLAIN, id: 'opencode/talker', name: 'Talker', reasoning: false };

/* ------------------------------------------------------------------ */
/* 目标形状与安装检测                                                    */
/* ------------------------------------------------------------------ */

test('目标形状：id/label 符合契约，四个方法齐全', () => {
  const target = createQoderTarget();
  assert.equal(target.id, 'qoder');
  assert.equal(target.label, 'qoder');
  for (const fn of ['detect', 'status', 'install', 'uninstall']) {
    assert.equal(typeof target[fn], 'function', `必须实现 ${fn}()`);
  }
});

test('detect：settings.json 所在目录（~/.qoder）在就算装了，不在就是没装', async (t) => {
  const { dir } = await withTempQoder(t, undefined);
  const target = createQoderTarget();
  assert.equal(target.detect(), true, '配置目录存在');

  process.env.OCF_QODER_SETTINGS = join(dir, 'nope', 'settings.json');
  assert.equal(target.detect(), false, '目录都没了才算没装');
});

/* ------------------------------------------------------------------ */
/* 写入：新建 / 合并保留 / 幂等 / 备份                                    */
/* ------------------------------------------------------------------ */

test('install：没有 settings.json 时新建一个，schema 逐字段对得上', async (t) => {
  const { file } = await withTempQoder(t, undefined);
  const target = createQoderTarget();

  const result = await target.install([MODEL_FULL, MODEL_PLAIN], { port: 41982, apiKey: 'oc-secret' });
  assert.equal(result.changed, true);
  assert.equal(result.added, 2);

  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(saved), ['providers'], '新建的文件里只有我们这一节');
  assert.deepEqual(saved.providers[PROVIDER_KEY], {
    protocol: 'anthropic',
    authType: 'api-key',
    baseUrl: 'http://127.0.0.1:41982',
    apiKey: 'oc-secret',
    displayName: 'OC Faucet',
    model: 'opencode/glm-5.3-flash-free',
    models: [
      {
        model: 'opencode/glm-5.3-flash-free',
        displayName: 'OC · GLM-5.3-Flash Free',
        contextWindow: 200000,
        capabilities: {
          tools: true,
          vision: true,
          thinking: { modes: ['enabled'], requiresBudgetForEnabled: false, supportedEffortLevels: ['low', 'high'], requiredBetasForEffort: [] },
        },
      },
      {
        model: 'opencode/big-pickle',
        displayName: 'OC · Big Pickle',
        capabilities: { tools: true, vision: false },
      },
    ],
  });

  const mode = (await stat(file)).mode & 0o777;
  assert.equal(mode, 0o600, '里面有密钥明文，权限必须只有本人可读写');
});

test('install：合并进已有设置——用户的供应商和顶层字段一个都不动', async (t) => {
  const { file } = await withTempQoder(t, baseSettings);
  const target = createQoderTarget();

  await target.install([MODEL_FULL], { port: 41982, apiKey: 'oc-secret' });
  const saved = JSON.parse(await readFile(file, 'utf8'));

  assert.equal(saved.model, 'qoder-user-default', '顶层默认模型不动');
  assert.deepEqual(saved.mcpServers, baseSettings.mcpServers, 'mcpServers 不动');
  assert.deepEqual(saved.hooks, baseSettings.hooks, 'hooks 不动');
  assert.deepEqual(saved.providers['my-deepseek'], userProvider, '用户手写的供应商逐字保留');
  assert.equal(saved.providers[PROVIDER_KEY].model, MODEL_FULL.id, '默认模型取清单第一个');
});

test('install 幂等：内容没变就不写盘', async (t) => {
  const { file } = await withTempQoder(t, baseSettings);
  const target = createQoderTarget();

  await target.install([MODEL_FULL], { port: 41982, apiKey: 'oc-secret' });
  const first = await readFile(file, 'utf8');
  const second = await target.install([MODEL_FULL], { port: 41982, apiKey: 'oc-secret' });
  assert.equal(second.changed, false, '第二次内容相同，不应该再写盘');
  assert.equal(await readFile(file, 'utf8'), first, '字节级不变');
});

test('install 写前备份：同日一份，内容是改写前的原文', async (t) => {
  const { dir } = await withTempQoder(t, baseSettings);
  const target = createQoderTarget();

  await target.install([MODEL_FULL], { port: 41982, apiKey: 'k1' });
  await target.install([MODEL_FULL], { port: 41983, apiKey: 'k1' });

  const backups = (await readdir(dir)).filter((n) => n.startsWith('settings.json.oc-faucet-backup-'));
  assert.equal(backups.length, 1, '同一天只备份一次');
  const text = await readFile(join(dir, backups[0]), 'utf8');
  assert.ok(text.includes('sk-user-handwritten'), '备份里应该是我们改写之前的内容');
});

test('install：端口/密钥不合法时明确报错，不写坏文件', async (t) => {
  const { file } = await withTempQoder(t, baseSettings);
  const target = createQoderTarget();
  const before = await readFile(file, 'utf8');

  await assert.rejects(() => target.install([MODEL_FULL], { port: 0, apiKey: 'k' }), /端口/);
  await assert.rejects(() => target.install([MODEL_FULL], { port: 41982, apiKey: '' }), /密钥/);
  assert.equal(await readFile(file, 'utf8'), before, '拒绝时不应该动原文件');
});

test('install：模型清单为空也安全——写一节空清单，不带默认模型字段', async (t) => {
  const { file } = await withTempQoder(t, undefined);
  const target = createQoderTarget();

  const result = await target.install([], { port: 41982, apiKey: 'k' });
  assert.equal(result.added, 0);

  const section = JSON.parse(await readFile(file, 'utf8')).providers[PROVIDER_KEY];
  assert.deepEqual(section.models, []);
  assert.equal('model' in section, false, '没有模型就没有默认模型字段');
});

/* ------------------------------------------------------------------ */
/* 默认模型字段：用户改过的要留住                                          */
/* ------------------------------------------------------------------ */

test('install：用户在节里改过的默认模型不被冲掉', async (t) => {
  const { file } = await withTempQoder(t, undefined);
  const target = createQoderTarget();

  await target.install([MODEL_FULL, MODEL_PLAIN], { port: 41982, apiKey: 'k' });
  // 用户在 qoder 里把默认模型从清单第一个换成了另一个（仍在新清单里）
  const data = JSON.parse(await readFile(file, 'utf8'));
  data.providers[PROVIDER_KEY].model = MODEL_PLAIN.id;
  await writeFile(file, JSON.stringify(data, null, 2));

  await target.install([MODEL_FULL, MODEL_PLAIN], { port: 41982, apiKey: 'k' });
  const section = JSON.parse(await readFile(file, 'utf8')).providers[PROVIDER_KEY];
  assert.equal(section.model, MODEL_PLAIN.id, '用户选过的默认模型要留住，不许重置回清单第一个');
});

test('install：旧默认模型不在新清单里才回退清单第一个', async (t) => {
  const { file } = await withTempQoder(t, undefined);
  const target = createQoderTarget();

  await target.install([MODEL_FULL, MODEL_PLAIN], { port: 41982, apiKey: 'k' });
  const data = JSON.parse(await readFile(file, 'utf8'));
  data.providers[PROVIDER_KEY].model = 'opencode/已被下架的模型';
  await writeFile(file, JSON.stringify(data, null, 2));

  await target.install([MODEL_FULL, MODEL_PLAIN], { port: 41982, apiKey: 'k' });
  const section = JSON.parse(await readFile(file, 'utf8')).providers[PROVIDER_KEY];
  assert.equal(section.model, MODEL_FULL.id, '旧值已不在清单里，回退到清单第一个');
});

/* ------------------------------------------------------------------ */
/* 摘除：只摘自己，providers 空了连键一起摘                               */
/* ------------------------------------------------------------------ */

test('uninstall：只摘 oc-faucet 一节，卸完后和用户最初的文件一模一样', async (t) => {
  const { file } = await withTempQoder(t, baseSettings);
  const target = createQoderTarget();

  const noop = await target.uninstall();
  assert.deepEqual(noop, { removed: 0, changed: false }, '没装过是安全空操作');

  await target.install([MODEL_FULL], { port: 41982, apiKey: 'oc-secret' });
  const result = await target.uninstall();
  assert.deepEqual(result, { removed: 1, changed: true });

  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(saved, baseSettings, '用户的供应商、顶层字段全部原样回来');
});

test('uninstall：我们是 providers 里最后一个时，把 providers 键本身也摘掉', async (t) => {
  const { file } = await withTempQoder(t, { model: 'qoder-user-default' });
  const target = createQoderTarget();

  await target.install([MODEL_FULL], { port: 41982, apiKey: 'k' });
  await target.uninstall();

  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(saved, { model: 'qoder-user-default' }, 'providers 键整个没了，其它字段还在');
});

test('uninstall：文件不存在时是安全空操作，不新建文件', async (t) => {
  const { file } = await withTempQoder(t, undefined);
  const target = createQoderTarget();

  const result = await target.uninstall();
  assert.deepEqual(result, { removed: 0, changed: false });
  await assert.rejects(() => stat(file), /ENOENT/);
});

/* ------------------------------------------------------------------ */
/* 状态实读                                                              */
/* ------------------------------------------------------------------ */

test('status：实读 settings.json——没写过 written:false，外部改了就按新的报', async (t) => {
  const { file } = await withTempQoder(t, undefined);
  const target = createQoderTarget();

  assert.deepEqual(await target.status(), { written: false, models: [] });

  await target.install([MODEL_FULL, MODEL_PLAIN], { port: 41982, apiKey: 'k' });
  assert.deepEqual(await target.status(), {
    written: true,
    models: ['opencode/glm-5.3-flash-free', 'opencode/big-pickle'],
  });

  // 外部把文件改了（用户手动、或崩溃后清理），不经过我们，必须如实反映
  await writeFile(file, JSON.stringify({ providers: {} }));
  assert.deepEqual(await target.status(), { written: false, models: [] });
});

/* ------------------------------------------------------------------ */
/* 坏文件与坏字段：报人话，绝不动原文件                                   */
/* ------------------------------------------------------------------ */

test('坏 JSON：install/uninstall/status 都报人话，一个字节都不动', async (t) => {
  const { file } = await withTempQoder(t, '{ 这不是 json');
  const target = createQoderTarget();
  const before = await readFile(file, 'utf8');

  for (const act of [
    () => target.install([MODEL_FULL], { port: 41982, apiKey: 'k' }),
    () => target.uninstall(),
    () => target.status(),
  ]) {
    await assert.rejects(act, (err) => {
      assert.equal(err.name, 'BridgeError');
      assert.match(err.message, /损坏/);
      assert.match(err.message, /该怎么办|再试一次/, '报错要告诉用户怎么办');
      return true;
    });
  }
  assert.equal(await readFile(file, 'utf8'), before, '损坏的文件一个字节都不许动');
});

test('providers 字段不是对象时：报人话，不硬覆盖用户数据', async (t) => {
  const { file } = await withTempQoder(t, { providers: 'user-typed-something-weird' });
  const target = createQoderTarget();
  const before = await readFile(file, 'utf8');

  await assert.rejects(() => target.install([MODEL_FULL], { port: 41982, apiKey: 'k' }), /格式不对/);
  assert.equal(await readFile(file, 'utf8'), before);
});

/* ------------------------------------------------------------------ */
/* 能力声明按模型生成                                                     */
/* ------------------------------------------------------------------ */

test('capabilities 按每个模型的真实能力生成，schema 之外一个字段不多写', async (t) => {
  const { file } = await withTempQoder(t, undefined);
  const target = createQoderTarget();

  await target.install([MODEL_FULL, MODEL_PLAIN, MODEL_CHAT], { port: 41982, apiKey: 'k' });
  const section = JSON.parse(await readFile(file, 'utf8')).providers[PROVIDER_KEY];
  const [full, plain, chat] = section.models;

  assert.deepEqual(full.capabilities, {
    tools: true,
    vision: true,
    thinking: { modes: ['enabled'], requiresBudgetForEnabled: false, supportedEffortLevels: ['low', 'high'], requiredBetasForEffort: [] },
  });
  assert.equal(full.contextWindow, 200000);

  assert.deepEqual(
    plain.capabilities,
    { tools: true, vision: false },
    'reasoning 但没档位 → 不写 thinking 键，不谎报',
  );
  assert.equal('thinking' in plain.capabilities, false);
  assert.equal('contextWindow' in plain, false, '不知道上下文窗口就不写');

  assert.deepEqual(chat.capabilities, { tools: true, vision: false });

  assert.equal('type' in section, false, 'type 省略：protocol 已是 anthropic');
  for (const entry of section.models) {
    assert.equal('maxOutputTokens' in entry, false, '数据不可靠，宁可缺省');
  }
});

test('capabilities.thinking：含 none 档则 modes 带 disabled；qoder 不认识的档（minimal）要丢掉', async (t) => {
  const { file } = await withTempQoder(t, undefined);
  const target = createQoderTarget();
  // 有 none/minimal/low 三档的模型：none → modes 加 disabled；minimal 不在 qoder 词表（none/low/medium/high/xhigh/max）里
  const model = {
    ...MODEL_FULL,
    id: 'opencode/thinker',
    variants: {
      off: { reasoningEffort: 'none' },
      tiny: { reasoningEffort: 'minimal' },
      low: { reasoningEffort: 'low' },
    },
  };

  await target.install([model], { port: 41982, apiKey: 'k' });
  const [entry] = JSON.parse(await readFile(file, 'utf8')).providers[PROVIDER_KEY].models;

  assert.deepEqual(entry.capabilities.thinking, {
    modes: ['enabled', 'disabled'],
    requiresBudgetForEnabled: false,
    supportedEffortLevels: ['low'],
    requiredBetasForEffort: [],
  });
});

/* ------------------------------------------------------------------ */
/* 路径注入的另一条缝                                                     */
/* ------------------------------------------------------------------ */

test('createQoderTarget({settingsPath})：直接指路径，优先于环境变量', async (t) => {
  const { dir } = await withTempQoder(t, undefined); // 环境变量指向 dir/settings.json
  const other = join(dir, 'elsewhere.json');
  const target = createQoderTarget({ settingsPath: other });

  await target.install([MODEL_PLAIN], { port: 41982, apiKey: 'k' });

  const saved = JSON.parse(await readFile(other, 'utf8'));
  assert.equal(saved.providers[PROVIDER_KEY].apiKey, 'k');
  assert.deepEqual(await target.status(), { written: true, models: [MODEL_PLAIN.id] });
});

/* ------------------------------------------------------------------ */
/* 中国版 qoderclicn：同一套写入器，另一个目录                              */
/* ------------------------------------------------------------------ */

/** 同 withTempQoder，走 OCF_QODERCN_SETTINGS 指到中国版的 settings.json */
async function withTempQoderCn(t, initial) {
  const dir = await mkdtemp(join(tmpdir(), 'oc-qodercn-'));
  const file = join(dir, 'settings.json');
  if (initial !== undefined) {
    await writeFile(file, typeof initial === 'string' ? initial : JSON.stringify(initial, null, 2));
  }
  const saved = process.env.OCF_QODERCN_SETTINGS;
  process.env.OCF_QODERCN_SETTINGS = file;
  t.after(async () => {
    if (saved === undefined) delete process.env.OCF_QODERCN_SETTINGS;
    else process.env.OCF_QODERCN_SETTINGS = saved;
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, file };
}

test('qoder CN：目标形状是 qoder-cn / qoder CN，四个方法齐全', () => {
  const target = createQoderCnTarget();
  assert.equal(target.id, 'qoder-cn');
  assert.equal(target.label, 'qoder CN');
  for (const fn of ['detect', 'status', 'install', 'uninstall']) {
    assert.equal(typeof target[fn], 'function', `必须实现 ${fn}()`);
  }
});

test('qoder CN：写进自己的 settings.json，schema 与国际版一致', async (t) => {
  const { file } = await withTempQoderCn(t, undefined);
  const target = createQoderCnTarget();

  const result = await target.install([MODEL_FULL], { port: 41982, apiKey: 'oc-secret' });
  assert.equal(result.changed, true);

  const saved = JSON.parse(await readFile(file, 'utf8'));
  const section = saved.providers[PROVIDER_KEY];
  assert.equal(section.protocol, 'anthropic');
  assert.equal(section.baseUrl, 'http://127.0.0.1:41982');
  assert.equal(section.model, MODEL_FULL.id);
  assert.deepEqual(
    section.models.map((m) => m.model),
    [MODEL_FULL.id],
  );
  assert.deepEqual(await target.status(), { written: true, models: [MODEL_FULL.id] });

  await target.uninstall();
  assert.deepEqual(await target.status(), { written: false, models: [] });
});

test('qoder CN 与国际版互不影响：写 CN 不碰国际版的文件', async (t) => {
  const { file: cnFile } = await withTempQoderCn(t, undefined);
  const { file: globalFile } = await withTempQoder(t, undefined);

  await createQoderCnTarget().install([MODEL_CHAT], { port: 41982, apiKey: 'k' });

  assert.equal(JSON.parse(await readFile(cnFile, 'utf8')).providers[PROVIDER_KEY].model, MODEL_CHAT.id);
  await assert.rejects(() => stat(globalFile), { code: 'ENOENT' }, '国际版文件不该被建出来');
});

test('qoder CN：$QODERCN_CONFIG_DIR 指向自定义目录时写到那里', async (t) => {
  const { dir } = await withTempQoderCn(t, undefined);
  delete process.env.OCF_QODERCN_SETTINGS; // 让官方目录变量生效
  const saved = process.env.QODERCN_CONFIG_DIR;
  process.env.QODERCN_CONFIG_DIR = dir;
  t.after(() => {
    if (saved === undefined) delete process.env.QODERCN_CONFIG_DIR;
    else process.env.QODERCN_CONFIG_DIR = saved;
  });

  await createQoderCnTarget().install([MODEL_PLAIN], { port: 41982, apiKey: 'k' });
  const saved2 = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'));
  assert.equal(saved2.providers[PROVIDER_KEY].apiKey, 'k');
});

test('detect：settings.json 只含 enabledPlugins 是 JetBrains 插件留下的，不算装了 CLI', async (t) => {
  const { file } = await withTempQoder(t, { enabledPlugins: ['qoder-context'] });
  assert.equal(createQoderTarget().detect(), false, '纯 enabledPlugins 是插件的文件');

  await writeFile(file, JSON.stringify({ enabledPlugins: ['qoder-context'], model: 'x' }));
  assert.equal(createQoderTarget().detect(), true, '带别的键就是 CLI 在用的文件');

  const cn = await withTempQoderCn(t, { enabledPlugins: [] });
  assert.equal(createQoderCnTarget().detect(), false, '中国版同样规则');
  assert.ok(cn.file.endsWith('settings.json'));
});
