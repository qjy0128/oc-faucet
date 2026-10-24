/** Codex 接入目标测试：config.toml 与模型目录都落在临时目录，绝不碰真实 ~/.codex。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCodexTarget } from '../src/target-codex.js';

const MODEL_TOOL = {
  id: 'opencode/big-pickle',
  name: 'big-pickle',
  images: true,
  reasoning: true,
  variants: { low: { reasoningEffort: 'low' }, high: { reasoningEffort: 'high' } },
  contextWindow: 1_000_000,
  upstreamContextWindow: 1_000_000,
};
const MODEL_PLAIN = {
  id: 'opencode/plain-free',
  name: 'plain-free',
  images: false,
  reasoning: false,
  variants: {},
  contextWindow: null,
  upstreamContextWindow: null,
};
const MODELS = [MODEL_TOOL, MODEL_PLAIN];
const OPTS = { port: 41982, apiKey: 'ocf-test-key' };

async function withDir(t, initial) {
  const dir = await mkdtemp(join(tmpdir(), 'oc-codex-'));
  const file = join(dir, 'config.toml');
  const catalogPath = join(dir, 'models.json');
  const ownerFile = join(dir, 'owner.json');
  if (initial !== undefined) await writeFile(file, initial);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return {
    dir,
    file,
    catalogPath,
    ownerFile,
    target: createCodexTarget({ configPath: file, catalogPath, ownerFile }),
  };
}

const text = (file) => readFile(file, 'utf8');

test('目标形状：id / label / 走 Responses / 需要选模型', async (t) => {
  const { target } = await withDir(t);
  assert.equal(target.id, 'codex');
  assert.equal(target.label, 'Codex');
  assert.equal(target.protocol, 'responses');
  assert.equal(target.selectsModels, true);
  assert.deepEqual(await target.status(), { written: false, models: [] });
});

test('写入：provider 表用 wire_api=responses，顶层三行落在第一个表头之前', async (t) => {
  const { file, target } = await withDir(t, '[sandbox]\nmode = "read-only"\n');
  const result = await target.install(MODELS, OPTS);
  assert.equal(result.changed, true);
  const written = await text(file);

  const top = written.indexOf('[model_providers.oc-faucet]');
  const sandbox = written.indexOf('[sandbox]');
  assert.ok(top > 0 && sandbox > top, '受管 provider 表要插在用户表区之前，顶层块更在前');
  assert.match(written, /^# >>> oc-faucet >>>\nmodel = "opencode\/big-pickle"/);
  assert.match(written, /model_provider = "oc-faucet"/);
  assert.match(written, /\[model_providers\.oc-faucet\]\nname = "OC Faucet"/);
  assert.match(written, /base_url = "http:\/\/127\.0\.0\.1:41982\/v1"/);
  assert.match(written, /wire_api = "responses"/);
  assert.match(written, /experimental_bearer_token = "ocf-test-key"/);
  assert.match(written, /mode = "read-only"/, '用户自己的表原样留着');
});

test('模型目录：窗口申报到 1M，字段齐到 Codex 能解析', async (t) => {
  const { catalogPath, target } = await withDir(t);
  await target.install(MODELS, OPTS);
  const catalog = JSON.parse(await text(catalogPath));
  assert.equal(catalog.models.length, 2);
  const [first, second] = catalog.models;

  assert.equal(first.slug, 'opencode/big-pickle');
  assert.equal(first.context_window, 1_000_000);
  // Codex 把顶层 model_context_window 夹在 max_context_window 以内，这里必须给足
  assert.equal(first.max_context_window, 1_000_000);
  assert.deepEqual(first.supported_reasoning_levels.map((level) => level.effort), ['low', 'high']);
  assert.equal(first.default_reasoning_level, 'low');
  assert.deepEqual(first.input_modalities, ['text', 'image']);
  assert.equal(first.visibility, 'list');
  assert.equal(first.supported_in_api, true);
  assert.equal(first.shell_type, 'unified_exec');
  // Codex 缺这两样会拒绝整份目录
  assert.ok(first.base_instructions.length > 0);
  assert.deepEqual(first.truncation_policy, { mode: 'tokens', limit: 10_000 });
  for (const key of ['slug', 'display_name', 'description', 'supported_reasoning_levels', 'shell_type',
    'visibility', 'supported_in_api', 'priority', 'availability_nux', 'upgrade', 'support_verbosity',
    'default_verbosity', 'apply_patch_tool_type', 'truncation_policy', 'experimental_supported_tools']) {
    assert.ok(key in second, `目录条目少了 Codex 必填的 ${key}`);
  }
  // 上游没给窗口时按兜底值申报，别让 Codex 用 272k 的兜底去夹
  assert.equal(second.context_window, 272_000);
  assert.deepEqual(second.input_modalities, ['text']);
});

test('状态：以文件实读为准，清单来自目录文件', async (t) => {
  const { file, catalogPath, target } = await withDir(t);
  await target.install(MODELS, OPTS);
  assert.deepEqual((await target.status()).models, ['opencode/big-pickle', 'opencode/plain-free']);
  await writeFile(catalogPath, JSON.stringify({ models: [{ slug: 'opencode/big-pickle' }] }));
  assert.deepEqual((await target.status()).models, ['opencode/big-pickle']);
  await writeFile(file, 'model = "gpt-5.1-codex"\n');
  assert.deepEqual(await target.status(), { written: false, models: [] }, '外部把受管块删了就报未写入');
});

test('写入：用户自己的同名顶层取值先留档，摘除时逐行还原', async (t) => {
  const { file, target } = await withDir(t, 'model = "gpt-5.1-codex"\nmodel_provider = "openai"\nmodel_catalog_json = "./models-original.json"\n\n[features]\nx = true\n');
  await target.install(MODELS, OPTS);
  const written = await text(file);
  assert.equal(written.match(/^model = /gm)?.length, 1, '同一个顶层键不能出现两次（TOML 会解析失败）');
  assert.doesNotMatch(written, /model_provider = "openai"/);

  await target.uninstall();
  const restored = await text(file);
  assert.match(restored, /model = "gpt-5\.1-codex"/);
  assert.match(restored, /model_provider = "openai"/);
  assert.match(restored, /model_catalog_json = "\.\/models-original\.json"/);
  assert.doesNotMatch(restored, /oc-faucet/);
  assert.match(restored, /\[features\]\nx = true/);
  assert.ok(restored.indexOf('model = "gpt-5.1-codex"') < restored.indexOf('[features]'), '还原的行要回到第一个表头之前');
});

test('写入：快照持久化失败时不改 Codex 配置或模型目录', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-codex-'));
  const file = join(dir, 'config.toml');
  const catalogPath = join(dir, 'models.json');
  const initial = 'model = "gpt-original"\nmodel_provider = "openai"\n';
  await writeFile(file, initial);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = createCodexTarget({ configPath: file, catalogPath, ownerFile: join(file, 'owner.json') });

  await assert.rejects(() => target.install(MODELS, OPTS));
  assert.equal(await text(file), initial);
  await assert.rejects(() => readFile(catalogPath, 'utf8'), { code: 'ENOENT' });
});

test('摘除：原值快照丢失或损坏时拒绝删除配置和目录', async (t) => {
  for (const damaged of ['missing', 'invalid']) {
    await t.test(damaged, async (t2) => {
      const { file, catalogPath, ownerFile, target } = await withDir(t2, 'model = "gpt-original"\n');
      await target.install(MODELS, OPTS);
      const beforeConfig = await text(file);
      const beforeCatalog = await text(catalogPath);
      if (damaged === 'missing') await rm(ownerFile);
      else await writeFile(ownerFile, '{broken');

      await assert.rejects(() => target.uninstall(), /快照/);
      assert.equal(await text(file), beforeConfig);
      assert.equal(await text(catalogPath), beforeCatalog);
    });
  }
});

test('改动受管块后：状态显示未写入，重装和摘除都拒绝覆盖', async (t) => {
  const { file, catalogPath, target } = await withDir(t, 'model = "gpt-original"\n');
  await target.install(MODELS, OPTS);
  const beforeCatalog = await text(catalogPath);
  const edited = (await text(file)).replace('wire_api = "responses"', 'wire_api = "chat"');
  await writeFile(file, edited);

  assert.deepEqual(await target.status(), { written: false, models: [] });
  await assert.rejects(() => target.install(MODELS, { ...OPTS, apiKey: 'ocf-other-key' }), /受管内容已被改动/);
  await assert.rejects(() => target.uninstall(), /受管内容已被改动/);
  assert.equal(await text(file), edited);
  assert.equal(await text(catalogPath), beforeCatalog);
});

test('受管标记仍在但原值快照丢失：重装不能把当前受管值当原值', async (t) => {
  const { file, ownerFile, target } = await withDir(t, 'model = "gpt-original"\n');
  await target.install(MODELS, OPTS);
  const managed = await text(file);
  await rm(ownerFile);

  await assert.rejects(() => target.install([MODEL_PLAIN], OPTS), /快照缺失/);
  await assert.rejects(() => target.uninstall(), /快照缺失/);
  assert.equal(await text(file), managed);
});

test('标记丢失且顶层值不等于原值快照：拒绝重新认领当前值', async (t) => {
  const { file, target } = await withDir(t, 'model = "gpt-original"\n');
  await target.install(MODELS, OPTS);
  const edited = (await text(file)).replaceAll('# >>> oc-faucet >>>\n', '').replaceAll('# <<< oc-faucet <<<\n', '');
  await writeFile(file, edited);

  await assert.rejects(() => target.install(MODELS, OPTS), /受管标记已丢失/);
  assert.equal(await text(file), edited);
});

test('摘除：目录文件一并删掉', async (t) => {
  const { catalogPath, target } = await withDir(t);
  await target.install(MODELS, OPTS);
  await target.uninstall();
  await assert.rejects(() => readFile(catalogPath, 'utf8'), { code: 'ENOENT' });
});

test('重写：内容没变不写盘', async (t) => {
  const { target } = await withDir(t);
  await target.install(MODELS, OPTS);
  assert.equal((await target.install(MODELS, OPTS)).changed, false);
  assert.equal((await target.install([MODEL_PLAIN], OPTS)).changed, true);
});

test('密钥变了要重写，且只留一份受管块', async (t) => {
  const { file, target } = await withDir(t);
  await target.install(MODELS, OPTS);
  await target.install(MODELS, { port: 41982, apiKey: 'ocf-new-key' });
  const written = await text(file);
  assert.equal(written.match(/# >>> oc-faucet >>>/g).length, 2, '顶层块 + provider 块');
  assert.equal(written.match(/\[model_providers\.oc-faucet\]/g).length, 1);
  assert.match(written, /ocf-new-key/);
  assert.doesNotMatch(written, /ocf-test-key/);
});

test('用户自己已有 [model_providers.oc-faucet]：拒绝合并', async (t) => {
  const { target } = await withDir(t, '[model_providers.oc-faucet]\nbase_url = "http://elsewhere"\n');
  await assert.rejects(() => target.install(MODELS, OPTS), /名字撞了/);
});

test('读不懂的配置不碰：长字符串、标记不成对', async (t) => {
  const { file, target } = await withDir(t, 'prompt = """\nmulti line\n"""\n');
  await assert.rejects(() => target.install(MODELS, OPTS), /读不了的长字符串/);

  const second = await withDir(t, '# >>> oc-faucet >>>\nmodel = "x"\n');
  await assert.rejects(() => second.target.install(MODELS, OPTS), /标记不成对/);
});

test('空模型清单：拒绝写入', async (t) => {
  const { target } = await withDir(t);
  await assert.rejects(() => target.install([], OPTS), /至少勾选一个/);
});

test('没写过就摘除：不动文件', async (t) => {
  const { file, target } = await withDir(t, 'model = "gpt-5.1-codex"\n');
  assert.deepEqual(await target.uninstall(), { removed: 0, changed: false });
  assert.equal(await text(file), 'model = "gpt-5.1-codex"\n');
});
