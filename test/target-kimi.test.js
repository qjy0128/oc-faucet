/** Kimi Code 接入目标测试：所有配置均写入临时目录，不碰 ~/.kimi-code。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createKimiTarget } from '../src/target-kimi.js';

const MODEL_A = {
  id: 'opencode/model-a',
  name: '模型 A',
  reasoning: true,
  images: true,
  contextWindow: 200000,
  variants: {
    low: { reasoningEffort: 'low' },
    high: { reasoningEffort: 'high' },
  },
};
const MODEL_B = { id: 'opencode/model-b', name: '模型 B', reasoning: false, images: false, contextWindow: null };
const OPTS = { port: 41982, apiKey: 'oc-fake-secret' };

async function withTempKimi(t, initial) {
  const dir = await mkdtemp(join(tmpdir(), 'oc-kimi-'));
  const file = join(dir, 'config.toml');
  if (initial !== undefined) await writeFile(file, initial);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, file, target: createKimiTarget({ configPath: file }) };
}

test('目标形状与显式路径注入', async (t) => {
  const { file, target } = await withTempKimi(t);
  assert.equal(target.id, 'kimi');
  assert.equal(target.label, 'Kimi Code');
  for (const method of ['detect', 'status', 'install', 'uninstall']) assert.equal(typeof target[method], 'function');
  assert.equal(target.detect(), true);
  await target.install([MODEL_A], OPTS);
  assert.ok((await readFile(file, 'utf8')).includes('[providers."oc-faucet"]'));
});

test('OCF_KIMI_CONFIG 可指向临时配置文件', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-kimi-env-'));
  const file = join(dir, 'config.toml');
  const saved = process.env.OCF_KIMI_CONFIG;
  process.env.OCF_KIMI_CONFIG = file;
  t.after(async () => {
    if (saved === undefined) delete process.env.OCF_KIMI_CONFIG;
    else process.env.OCF_KIMI_CONFIG = saved;
    await rm(dir, { recursive: true, force: true });
  });
  await createKimiTarget().install([MODEL_A], OPTS);
  assert.ok((await readFile(file, 'utf8')).includes('[providers."oc-faucet"]'));
});

test('KIMI_CODE_HOME 下固定读取 config.toml', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-kimi-home-'));
  const configDir = join(dir, 'kimi-home');
  const file = join(configDir, 'config.toml');
  const savedHome = process.env.KIMI_CODE_HOME;
  const savedOverride = process.env.OCF_KIMI_CONFIG;
  process.env.KIMI_CODE_HOME = configDir;
  delete process.env.OCF_KIMI_CONFIG;
  t.after(async () => {
    if (savedHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = savedHome;
    if (savedOverride === undefined) delete process.env.OCF_KIMI_CONFIG;
    else process.env.OCF_KIMI_CONFIG = savedOverride;
    await rm(dir, { recursive: true, force: true });
  });
  await createKimiTarget().install([MODEL_A], OPTS);
  assert.ok((await readFile(file, 'utf8')).includes('[providers."oc-faucet"]'));
});

test('install：使用 OpenAI Chat Completions、模型上下文窗口和 128000 兜底', async (t) => {
  const prefix = 'default_model = "user/default"\n\n[thinking]\nenabled = true\n';
  const { file, target } = await withTempKimi(t, prefix);
  const result = await target.install([MODEL_A, MODEL_B], { ...OPTS, apiKey: 'fake-"quoted"-\\key' });
  assert.deepEqual(result, { added: 2, skipped: [], changed: true });
  const saved = await readFile(file, 'utf8');
  assert.ok(saved.startsWith(`${prefix}\n`), '块外前缀应逐字保留');
  assert.ok(saved.includes('[providers."oc-faucet"]\ntype = "openai"'));
  assert.ok(saved.includes('base_url = "http://127.0.0.1:41982/v1"'));
  assert.ok(saved.includes('api_key = "fake-\\"quoted\\"-\\\\key"'));
  assert.ok(saved.includes('[models."oc-faucet/opencode/model-a"]'));
  assert.ok(saved.includes('max_context_size = 200000'));
  assert.ok(saved.includes('capabilities = ["tool_use", "thinking", "image_in"]'));
  assert.ok(saved.includes('support_efforts = ["low", "high"]'));
  assert.ok(saved.includes('[models."oc-faucet/opencode/model-b"]'));
  assert.ok(saved.includes('max_context_size = 128000'));
  assert.deepEqual(await target.status(), { written: true, models: [MODEL_A.id, MODEL_B.id] });
});

test('install：相同模型列表再次安装不增空白，卸载只移除受管块', async (t) => {
  const prefix = '# 用户说明保持原文\r\ndefault_model = "user/default"\r\n';
  const { file, target } = await withTempKimi(t, prefix);
  await target.install([MODEL_A], OPTS);
  const first = await readFile(file, 'utf8');
  const repeat = await target.install([MODEL_A], OPTS);
  const second = await readFile(file, 'utf8');
  assert.deepEqual(repeat, { added: 1, skipped: [], changed: false });
  assert.equal(second, first);
  assert.equal(second.slice(0, prefix.length), prefix);
  assert.deepEqual(await target.uninstall(), { removed: 1, changed: true });
  assert.equal(await readFile(file, 'utf8'), prefix);
  assert.deepEqual(await target.status(), { written: false, models: [] });
});

test('install：替换中间的受管块时前后所有原文逐字保留', async (t) => {
  const prefix = 'default_model = "user/default"\n\n';
  const oldBlock = [
    '# >>> oc-faucet >>>',
    '[providers."oc-faucet"]',
    'type = "openai"',
    'base_url = "http://127.0.0.1:1/v1"',
    'api_key = "old-fake-key"',
    '',
    '[models."oc-faucet/old-model"]',
    'provider = "oc-faucet"',
    'model = "old-model"',
    'max_context_size = 1',
    '# <<< oc-faucet <<<',
  ].join('\n');
  const suffix = '\n\n# 这段用户配置必须原样保留\n[thinking]\neffort = "high"\n';
  const { file, target } = await withTempKimi(t, `${prefix}${oldBlock}${suffix}`);
  await target.install([MODEL_A], OPTS);
  const saved = await readFile(file, 'utf8');
  assert.ok(saved.startsWith(prefix));
  assert.ok(saved.endsWith(suffix));
  assert.ok(saved.includes('[models."oc-faucet/opencode/model-a"]'));
  assert.ok(!saved.includes('old-fake-key'));
});

test('install：用户已占用全部模型别名时不创建空供应商块', async (t) => {
  const initial = '[models."oc-faucet/opencode/model-a"]\nprovider = "user-provider"\nmodel = "user-model"\n';
  const { file, target } = await withTempKimi(t, initial);
  const result = await target.install([MODEL_A], OPTS);
  assert.deepEqual(result, { added: 0, skipped: [MODEL_A.id], changed: false });
  assert.equal(await readFile(file, 'utf8'), initial);
});

test('install：字符串中的假表头和标记不会被当成配置，块外原文保留', async (t) => {
  const prefix = `description = """说明开始
# >>> oc-faucet >>>
[providers.oc-faucet]
说明结束"""
`;
  const { file, target } = await withTempKimi(t, prefix);
  await target.install([MODEL_A], OPTS);
  const saved = await readFile(file, 'utf8');
  assert.ok(saved.startsWith(`${prefix}\n`));
  assert.ok(saved.includes('type = "openai"'));
  assert.deepEqual(await target.status(), { written: true, models: [MODEL_A.id] });
});

test('install：重复、缺失或损坏的受管标记一律拒绝写入', async (t) => {
  const invalid = [
    '# >>> oc-faucet >>>\n',
    '# <<< oc-faucet <<<\n',
    '# >>> oc-faucet >>>\n# >>> oc-faucet >>>\n# <<< oc-faucet <<<\n',
    '# >>> oc-faucet >>> extra\n# <<< oc-faucet <<<\n',
  ];
  for (const initial of invalid) {
    const { file, target } = await withTempKimi(t, initial);
    await assert.rejects(() => target.install([MODEL_A], OPTS));
    assert.equal(await readFile(file, 'utf8'), initial);
  }
});

test('install：TOML 表头、根级内联表和点号配置冲突时拒绝写入', async (t) => {
  const conflicts = [
    '[providers.oc-faucet]\ntype = "openai"\n',
    'providers = { "oc-faucet" = { type = "openai" } }\n',
    'providers.oc-faucet.type = "openai"\n',
    '[providers]\noc-faucet = { type = "openai" }\n',
    'models."oc-faucet/opencode/model-a".provider = "other"\n',
    'models = { "oc-faucet/opencode/model-a" = { provider = "other" } }\n',
  ];
  for (const initial of conflicts) {
    const { file, target } = await withTempKimi(t, initial);
    await assert.rejects(() => target.install([MODEL_A], OPTS));
    assert.equal(await readFile(file, 'utf8'), initial);
  }
});

test('install：未闭合的单行或多行字符串拒绝写入且保留原文件', async (t) => {
  const invalid = ['name = "未结束\n', 'description = """多行未结束\nstill open\n'];
  for (const initial of invalid) {
    const { file, target } = await withTempKimi(t, initial);
    await assert.rejects(() => target.install([MODEL_A], OPTS));
    assert.equal(await readFile(file, 'utf8'), initial);
  }
});
