import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 这些测试全部在临时目录里跑，靠 OCF_ZCODE_CONFIG 把配置路径指过去，
 * 绝不碰用户真实的 ~/.zcode/v2/provider_config.json。
 */


/**
 * 我们在 providerModelRules 里会写两类东西：
 *   - 禁用规则：把模板自带的模型禁掉，config 只有 {enabled:false}
 *   - 能力声明：逐模型声明视觉/档位，config 里带 properties
 * 数条目时必须分开数，否则两类混在一起，断言全都会飘。
 */
const onlyDisable = (rules) =>
  (rules ?? []).filter((r) => r?.providerId === 'oc-faucet' && r?.config?.enabled === false);
const onlyCapability = (rules) =>
  (rules ?? []).filter((r) => r?.providerId === 'oc-faucet' && r?.config?.enabled === true && r?.config?.properties);

async function withTempConfig(initial, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'oc-zcode-'));
  const file = join(dir, 'provider_config.json');
  if (initial !== undefined) {
    await writeFile(file, typeof initial === 'string' ? initial : JSON.stringify(initial, null, 2));
  }
  // 假的内置清单：必须指过去，否则测试会去读用户真实的 ZCode 安装，结果随环境变。
  const builtin = join(dir, 'zcode-builtin.json');
  await writeFile(builtin, JSON.stringify(fakeBuiltinConfig, null, 2));
  const prev = process.env.OCF_ZCODE_CONFIG;
  const prevBuiltin = process.env.OCF_ZCODE_BUILTIN;
  const prevRuntime = process.env.OCF_ZCODE_RUNTIME;
  process.env.OCF_ZCODE_CONFIG = file;
  process.env.OCF_ZCODE_BUILTIN = builtin;
  process.env.OCF_ZCODE_RUNTIME = join(dir, 'no-such-runtime');
  try {
    // 每次都要重新 import 才能拿到新的环境变量——所以这里用查询串绕开模块缓存。
    const mod = await import(`../src/zcode-config.js?t=${Date.now()}-${Math.random()}`);
    return await fn(mod, file, dir);
  } finally {
    if (prev === undefined) delete process.env.OCF_ZCODE_CONFIG;
    else process.env.OCF_ZCODE_CONFIG = prev;
    if (prevBuiltin === undefined) delete process.env.OCF_ZCODE_BUILTIN;
    else process.env.OCF_ZCODE_BUILTIN = prevBuiltin;
    if (prevRuntime === undefined) delete process.env.OCF_ZCODE_RUNTIME;
    else process.env.OCF_ZCODE_RUNTIME = prevRuntime;
  }
}

/** ZCode 官方内置清单的简化版：只保留我们关心的 anthropic 模板 */
const fakeBuiltinConfig = {
  schemaVersion: 1,
  revision: 31,
  config: {
    providerConfigRules: {
      templateRules: [
        { templateId: 'deepseek', templateNameMap: { 'zh-CN': 'DeepSeek' }, config: { builtinModelIds: ['deepseek-flash'] } },
        {
          templateId: 'anthropic',
          templateNameMap: { 'zh-CN': 'Anthropic' },
          config: {
            builtinModelIds: ['claude-fable-5-1', 'claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
          },
        },
      ],
    },
  },
};

const userProvider = {
  providerId: 'deepseek',
  templateId: 'deepseek',
  providerName: 'DeepSeek',
  config: { group: 'standard-personal', access: { type: 'api-key', apiKey: 'sk-user-handwritten' } },
};

const baseConfig = {
  schemaVersion: 1,
  config: {
    providerOrder: ['deepseek'],
    providerConfigRules: { providerRules: [userProvider] },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
  },
};

const models = [
  { id: 'opencode/deepseek-v4.1-flash-free', name: 'deepseek-v4.1-flash-free' },
  { id: 'opencode/glm-5.3-flash-free', name: 'glm-5.3-flash-free' },
];

test('没有配置文件时读出一个空骨架，不抛异常', async () => {
  await withTempConfig(undefined, async (mod) => {
    const config = await mod.readConfig();
    assert.equal(config.schemaVersion, 1);
    assert.deepEqual(config.config.providerConfigRules.providerRules, []);
    const s = await mod.status();
    assert.equal(s.installed, false);
  });
});

test('配置文件是坏 JSON 时不炸，返回空骨架', async () => {
  await withTempConfig('{ this is not json', async (mod) => {
    const config = await mod.readConfig();
    assert.deepEqual(config.config.providerConfigRules.providerRules, []);
  });
});

test('install 之后我们能读回来，端口和密钥都对', async () => {
  await withTempConfig(baseConfig, async (mod) => {
    const r = await mod.install({ port: 41982, apiKey: 'oc-secret', models });
    assert.equal(r.changed, true);
    assert.equal(r.added, 2);

    const s = await mod.status();
    assert.equal(s.installed, true);
    assert.equal(s.port, 41982);
    assert.equal(s.models, 2);
  });
});

test('install 只增删自己那一条，用户手写的一条都不动', async () => {
  await withTempConfig(baseConfig, async (mod) => {
    await mod.install({ port: 41982, apiKey: 'oc-secret', models });
    const config = await mod.readConfig();
    const rules = config.config.providerConfigRules.providerRules;

    const mine = rules.find((x) => x.providerId === 'oc-faucet');
    const theirs = rules.find((x) => x.providerId === 'deepseek');
    assert.ok(mine, '我们那条应该在');
    assert.deepEqual(theirs, userProvider, '用户手写的必须逐字保持原样');

    await mod.uninstall();
    const after = await mod.readConfig();
    assert.equal(after.config.providerConfigRules.providerRules.length, 1);
    assert.deepEqual(after.config.providerConfigRules.providerRules[0], userProvider);
  });
});

test('重复 install 幂等：内容没变就不写盘', async () => {
  await withTempConfig(baseConfig, async (mod) => {
    await mod.install({ port: 41982, apiKey: 'oc-secret', models });
    const second = await mod.install({ port: 41982, apiKey: 'oc-secret', models });
    assert.equal(second.changed, false, '第二次内容相同，不应该再写盘');

    const config = await mod.readConfig();
    assert.equal(config.config.providerConfigRules.providerRules.filter((x) => x.providerId === 'oc-faucet').length, 1);
  });
});

test('install 会写一份备份，且不重复堆同一天的备份', async () => {
  await withTempConfig(baseConfig, async (mod, file, dir) => {
    await mod.install({ port: 41982, apiKey: 'oc-secret', models });
    await mod.install({ port: 41983, apiKey: 'oc-secret', models });
    const backups = (await readdir(dir)).filter((n) => n.includes('oc-faucet-backup-'));
    assert.equal(backups.length, 1, '同一天只备份一次');
    const text = await readFile(join(dir, backups[0]), 'utf8');
    assert.ok(text.includes('sk-user-handwritten'), '备份里应该是我们改写之前的内容');
    assert.ok(file.endsWith('provider_config.json'));
  });
});

test('我们那一条不能带 builtinModelIds（ZCode 对 standard-personal 严格校验）', async () => {
  await withTempConfig(baseConfig, async (mod) => {
    await mod.install({ port: 41982, apiKey: 'oc-secret', models });
    const config = await mod.readConfig();
    const mine = config.config.providerConfigRules.providerRules.find((x) => x.providerId === 'oc-faucet');
    assert.equal('builtinModelIds' in mine.config, false);
    assert.equal(mine.config.group, 'standard-personal');
    assert.equal(mine.config.api.type, 'anthropic-messages');
    assert.equal(mine.config.api.baseUrl, 'http://127.0.0.1:41982');
    assert.deepEqual(mine.config.personalModelIds, models.map((m) => m.id));
  });
});

test('uninstall 在没装过时是安全的空操作', async () => {
  await withTempConfig(baseConfig, async (mod) => {
    const r = await mod.uninstall();
    assert.equal(r.removed, 0);
    assert.equal(r.changed, false);
  });
});

test('端口或密钥不合法时明确报错，不写坏文件', async () => {
  await withTempConfig(baseConfig, async (mod, file) => {
    const before = await readFile(file, 'utf8');
    await assert.rejects(() => mod.install({ port: 0, apiKey: 'x', models }), /端口/);
    await assert.rejects(() => mod.install({ port: 41982, apiKey: '', models }), /密钥/);
    assert.equal(await readFile(file, 'utf8'), before, '拒绝时不应该动原文件');
  });
});

test('模型清单为空时直接报错，一个字节都不写（空条目面板显示未写入，等于残留密钥）', async () => {
  await withTempConfig(baseConfig, async (mod, file) => {
    const before = await readFile(file, 'utf8');
    await assert.rejects(() => mod.install({ port: 41982, apiKey: 'oc-secret', models: [] }), /没有可写入的模型|先体检/);
    assert.equal(await readFile(file, 'utf8'), before, '空清单不许动原文件');
    assert.deepEqual(await mod.readOurModelIds(), [], '也不许留下空条目');
  });
});

test('还原备份时只认自己产生的备份文件', async () => {
  await withTempConfig(baseConfig, async (mod) => {
    await mod.install({ port: 41982, apiKey: 'oc-secret', models });
    const backups = await mod.listBackups();
    assert.equal(backups.length, 1);
    await mod.restoreBackup(backups[0]);
    const s = await mod.status();
    assert.equal(s.installed, false, '还原后我们那条应该没了');
    await assert.rejects(() => mod.restoreBackup('/etc/passwd'), /拒绝/);
  });
});

test('装的时候会把模板自带的模型逐条禁掉（本机口并不提供它们）', async () => {
  await withTempConfig(baseConfig, async (mod) => {
    const r = await mod.install({ port: 41982, apiKey: 'oc-secret', models });
    assert.equal(r.disabledBuiltins, 5, 'anthropic 模板自带 5 个，应该全禁');

    const config = await mod.readConfig();
    const mine = onlyDisable(config.config.modelConfigRules.providerModelRules);
    assert.deepEqual(
      mine.map((x) => x.modelId).sort(),
      ['claude-fable-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001', 'claude-opus-5', 'claude-sonnet-5'],
    );
    assert.ok(mine.every((x) => x.config.enabled === false), '必须都是 enabled:false');
  });
});

test('禁用规则只写我们自己的 providerId，别人的模型规则一条不动', async () => {
  const otherRule = { providerId: 'deepseek', modelId: 'deepseek-flash', config: { enabled: true } };
  const config = structuredClone(baseConfig);
  config.config.modelConfigRules.providerModelRules = [otherRule];

  await withTempConfig(config, async (mod) => {
    await mod.install({ port: 41982, apiKey: 'oc-secret', models });
    const after = await mod.readConfig();
    const kept = after.config.modelConfigRules.providerModelRules.find(
      (x) => x.providerId === 'deepseek' && x.modelId === 'deepseek-flash',
    );
    assert.deepEqual(kept, otherRule, '别人手写的模型规则必须逐字保持原样');
  });
});

test('重复 install 不重复堆禁用规则：清单变了要能跟着换', async () => {
  await withTempConfig(baseConfig, async (mod) => {
    await mod.install({ port: 41982, apiKey: 'oc-secret', models });
    const first = onlyDisable((await mod.readConfig()).config.modelConfigRules.providerModelRules).filter(
      (x) => x.providerId === 'oc-faucet',
    );
    assert.equal(first.length, 5);

    await mod.install({ port: 41982, apiKey: 'oc-secret', models });
    const second = onlyDisable((await mod.readConfig()).config.modelConfigRules.providerModelRules).filter(
      (x) => x.providerId === 'oc-faucet',
    );
    assert.equal(second.length, 5, '第二次装不应该变成 10 条');
  });
});

test('读不到 ZCode 内置清单时，跳过禁用而不是写死一份猜的', async () => {
  await withTempConfig(baseConfig, async (mod) => {
    process.env.OCF_ZCODE_BUILTIN = '/no/such/zcode-builtin.json';
    const r = await mod.install({ port: 41982, apiKey: 'oc-secret', models });
    assert.equal(r.disabledBuiltins, 0, '读不到就一条都别禁');
    const config = await mod.readConfig();
    // 禁用规则一条都不该有（读不到内置清单就没法判断哪些是模板自带的）
    assert.equal(onlyDisable(config.config.modelConfigRules.providerModelRules).length, 0);
    // 但能力声明不依赖内置清单，照常要写
    assert.equal(onlyCapability(config.config.modelConfigRules.providerModelRules).length, models.length);
  });
});

test('install 时若模型名和模板自带的撞了，不能把自己的模型禁掉', async () => {
  const clashing = [{ id: 'claude-opus-5', name: 'claude-opus-5' }];
  await withTempConfig(baseConfig, async (mod) => {
    const r = await mod.install({ port: 41982, apiKey: 'oc-secret', models: clashing });
    assert.equal(r.disabledBuiltins, 4, '撞名那一个要留给我们自己');
    const config = await mod.readConfig();
    const mine = onlyDisable(config.config.modelConfigRules.providerModelRules);
    assert.equal(mine.some((x) => x.modelId === 'claude-opus-5'), false, '自己的模型不能被自己禁掉');
  });
});

test('uninstall 会连带清掉我们写的禁用规则', async () => {
  await withTempConfig(baseConfig, async (mod) => {
    await mod.install({ port: 41982, apiKey: 'oc-secret', models });
    assert.equal(
      onlyDisable((await mod.readConfig()).config.modelConfigRules.providerModelRules).length,
      5,
    );
    await mod.uninstall();
    const after = await mod.readConfig();
    assert.equal(after.config.modelConfigRules.providerModelRules.length, 0, '不该留下无主的禁用规则');
    assert.equal(after.config.providerConfigRules.providerRules.length, 1);
  });
});

/* ------------------------------------------------------------------ */
/* 能力声明：视觉 / 视频 / PDF / 推理档位                                */
/* 不声明的话，ZCode 界面上这些能力是空的，用户会以为接入的模型缺斤少两。 */
/* ------------------------------------------------------------------ */

/** 一条形状完整的模型：能看图、支持 low/high/max 三档推理 */
const MODEL_WITH_VISION = {
  id: 'opencode/glm-5.3-flash-free',
  providerID: 'opencode',
  modelID: 'glm-5.3-flash-free',
  name: 'GLM-5.3-Flash Free',
  free: true,
  reasoning: true,
  variants: {
    low: { reasoningEffort: 'low' },
    high: { reasoningEffort: 'high' },
    max: { reasoningEffort: 'max' },
  },
  images: true,
  video: true,
  pdf: true,
  contextWindow: 200000,
  deprecated: false,
};

/** 一条没视觉、没档位的模型 */
const MODEL_PLAIN = {
  id: 'opencode/big-pickle',
  providerID: 'opencode',
  modelID: 'big-pickle',
  name: 'Big Pickle',
  free: true,
  reasoning: true,
  variants: {},
  images: false,
  video: false,
  pdf: false,
  contextWindow: null,
  deprecated: false,
};

test('buildCapabilityRules：每条都带 providerId 和 modelId', async () => {
  await withTempConfig({}, async (mod) => {
    const rules = mod.buildCapabilityRules([MODEL_WITH_VISION, MODEL_PLAIN]);
    assert.equal(rules.length, 2);
    assert.deepEqual(
      rules.map((r) => [r.providerId, r.modelId]),
      [
        [mod.PROVIDER_ID, 'opencode/glm-5.3-flash-free'],
        [mod.PROVIDER_ID, 'opencode/big-pickle'],
      ],
    );
  });
});

test('buildCapabilityRules：视觉能力按模态分别声明，不混成一个布尔值', async () => {
  await withTempConfig({}, async (mod) => {
    const [glm, pickle] = mod.buildCapabilityRules([MODEL_WITH_VISION, MODEL_PLAIN]);
    assert.deepEqual(glm.config.properties.inputFormat, {
      supportsText: true,
      supportsImage: true,
      supportsVideo: true,
      supportsAudio: false,
      supportsPdf: true,
    });
    assert.deepEqual(pickle.config.properties.inputFormat, {
      supportsText: true,
      supportsImage: false,
      supportsVideo: false,
      supportsAudio: false,
      supportsPdf: false,
    });
  });
});

test('buildCapabilityRules：上下文窗口有就写上，没有就不写', async () => {
  await withTempConfig({}, async (mod) => {
    const [glm, pickle] = mod.buildCapabilityRules([MODEL_WITH_VISION, MODEL_PLAIN]);
    assert.equal(glm.config.properties.contextWindow, 200000);
    assert.equal(pickle.config.properties.contextWindow, undefined, '不知道就别瞎写');
  });
});

test('buildCapabilityRules：推理档位按模型实际有的申报', async () => {
  await withTempConfig({}, async (mod) => {
    const [glm] = mod.buildCapabilityRules([MODEL_WITH_VISION]);
    const spec = glm.config.optionSpecs.reasoningLevel;
    assert.deepEqual(spec.values, ['low', 'high', 'max']);
    // map 用 ZCode 内置配置里那份原样写法（thinking + output_config.effort）
    assert.match(spec.map, /output_config/);
    assert.match(spec.map, /thinking/);
  });
});

test('buildCapabilityRules：没有档位的模型不写 reasoningLevel（否则界面上是个空框）', async () => {
  await withTempConfig({}, async (mod) => {
    const [, pickle] = mod.buildCapabilityRules([MODEL_WITH_VISION, MODEL_PLAIN]);
    assert.equal(pickle.config.optionSpecs, undefined);
  });
});

test('buildCapabilityRules：none 档在界面上显示为 disabled（ZCode 只认这个字面量）', async () => {
  await withTempConfig({}, async (mod) => {
    const model = {
      ...MODEL_WITH_VISION,
      variants: { none: { reasoningEffort: 'none' }, high: { reasoningEffort: 'high' } },
    };
    const [rule] = mod.buildCapabilityRules([model]);
    assert.deepEqual(rule.config.optionSpecs.reasoningLevel.values, ['disabled', 'high']);
  });
});

test('install 会写入能力声明，uninstall 会连它一起摘干净', async () => {
  await withTempConfig({}, async (mod, file) => {
    await mod.install({ port: 41982, apiKey: 'k', models: [MODEL_WITH_VISION] });
    let saved = JSON.parse(await readFile(file, 'utf8'));
    // 能力声明写在 providerModelRules 里（和禁用规则同一个数组，靠 providerId 区分归属）
    const mine = saved.config.modelConfigRules.providerModelRules.filter(
      (r) => r.modelId === 'opencode/glm-5.3-flash-free',
    );
    assert.equal(mine.length, 1);
    assert.equal(mine[0].providerId, mod.PROVIDER_ID);
    assert.equal(mine[0].config.properties.inputFormat.supportsImage, true);
    // 可见性是 providerModelRules 才有的完整字段
    assert.equal(mine[0].config.properties.supportsToolCall, true);

    await mod.uninstall();
    saved = JSON.parse(await readFile(file, 'utf8'));
    const left = saved.config.modelConfigRules.providerModelRules.filter(
      (r) => r.providerId === mod.PROVIDER_ID,
    );
    assert.deepEqual(left, [], '不能留下指向不存在供应商的孤儿规则');
  });
});

test('install 会如实报告写了几条能力声明', async () => {
  await withTempConfig({}, async (mod) => {
    const result = await mod.install({ port: 41982, apiKey: 'k', models: [MODEL_WITH_VISION, MODEL_PLAIN] });
    assert.equal(result.capabilities, 2);
  });
});
