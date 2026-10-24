/** Claude Code 接入目标测试：配置一律落在临时目录，绝不碰真实 ~/.claude。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClaudeTarget } from '../src/target-claude.js';

const MODEL_TOOL = {
  id: 'opencode/big-pickle',
  name: 'big-pickle',
  images: true,
  reasoning: true,
  variants: { low: { reasoningEffort: 'low' }, high: { reasoningEffort: 'high' } },
  contextWindow: 1_000_000,
  upstreamContextWindow: 1_000_000,
};
const MODEL_CHAT = {
  id: 'opencode/plain-free',
  name: 'plain-free',
  images: false,
  reasoning: false,
  variants: {},
  contextWindow: 131_072,
  upstreamContextWindow: 131_072,
};
const MODELS = [MODEL_TOOL, MODEL_CHAT];
const OPTS = { port: 41982, apiKey: 'ocf-test-key' };

async function withDir(t, initial) {
  const dir = await mkdtemp(join(tmpdir(), 'oc-claude-'));
  const file = join(dir, 'settings.json');
  if (initial !== undefined) {
    if (initial !== null) await writeFile(file, typeof initial === 'string' ? initial : JSON.stringify(initial, null, 2));
  }
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ownerFile = join(dir, 'owner.json');
  return { dir, file, ownerFile, target: createClaudeTarget({ settingsPath: file, ownerFile }) };
}

const read = async (file) => JSON.parse(await readFile(file, 'utf8'));

test('目标形状：id / label / 协议 / 需要选模型', async (t) => {
  const { target } = await withDir(t);
  assert.equal(target.id, 'claude');
  assert.equal(target.label, 'Claude Code');
  assert.equal(target.protocol, 'anthropic');
  assert.equal(target.selectsModels, true);
  assert.deepEqual(await target.status(), { written: false, models: [] });
});

test('写入：本机地址 + Bearer 密钥 + 默认模型 + 网关模型发现', async (t) => {
  const { file, target } = await withDir(t);
  const result = await target.install(MODELS, OPTS);
  assert.equal(result.changed, true);
  assert.equal(result.added, 2);
  const settings = await read(file);
  assert.equal(settings.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:41982');
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, 'ocf-test-key');
  assert.equal(settings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, '1');
  assert.equal(settings.env.OC_FAUCET_TARGET_OWNER, 'oc-faucet:claude:v1');
  // 这个变量是全局值，两种窗口不能用第一个模型的值覆盖其他模型。
  assert.equal(settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
  assert.equal(settings.model, 'opencode/big-pickle');
  assert.equal(settings.env.OC_FAUCET_TARGET_MODELS, 'opencode/big-pickle,opencode/plain-free');
});

test('上下文窗口：所有所选模型相同时才申报全局值', async (t) => {
  const { file, target } = await withDir(t);
  await target.install([{ ...MODEL_TOOL, contextWindow: 640_000 }, { ...MODEL_CHAT, contextWindow: 640_000 }], OPTS);
  assert.equal((await read(file)).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '640000');
});

test('重装后窗口不再一致时立即恢复用户原有上下文设置', async (t) => {
  const { file, target } = await withDir(t, { env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '300000' } });
  await target.install([{ ...MODEL_TOOL, contextWindow: 1_000_000 }], OPTS);
  assert.equal((await read(file)).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1000000');
  await target.install(MODELS, OPTS);
  assert.equal((await read(file)).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '300000');
  await target.uninstall();
  assert.equal((await read(file)).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '300000');
});

test('写入：档位锁在模型真有的档里，没档位的模型不写', async (t) => {
  const { file, target } = await withDir(t);
  await target.install(MODELS, OPTS);
  const settings = await read(file);
  assert.equal(settings.modelSettings['opencode/big-pickle'].effortLevel, 'low');
  assert.equal(settings.modelSettings['opencode/plain-free'], undefined);
});

test('写入：模型 ID 的点号保留在同一个 modelSettings 键里', async (t) => {
  const { file, target } = await withDir(t);
  const dotted = { ...MODEL_TOOL, id: 'opencode/glm-5.3-flash' };
  await target.install([dotted], OPTS);
  const settings = await read(file);
  assert.equal(settings.modelSettings['opencode/glm-5.3-flash'].effortLevel, 'low');
  assert.equal(settings.modelSettings.opencode, undefined, '不应按点号把 ID 拆成多层对象');
});

test('重装时撤选的模型会恢复原有档位设置', async (t) => {
  const initial = {
    modelSettings: { 'opencode/big-pickle': { effortLevel: 'high', temperature: 0.4 } },
  };
  const { file, target } = await withDir(t, initial);
  await target.install([MODEL_TOOL], OPTS);
  assert.equal((await read(file)).modelSettings['opencode/big-pickle'].effortLevel, 'low');
  await target.install([MODEL_CHAT], OPTS);
  assert.deepEqual((await read(file)).modelSettings['opencode/big-pickle'], { effortLevel: 'high', temperature: 0.4 });
  await target.uninstall();
  assert.deepEqual((await read(file)).modelSettings['opencode/big-pickle'], { effortLevel: 'high', temperature: 0.4 });
});

test('重装接管前记录用户后来修改的档位值，卸载时还原该值', async (t) => {
  const { file, target } = await withDir(t);
  await target.install([MODEL_TOOL], OPTS);
  const edited = await read(file);
  edited.modelSettings['opencode/big-pickle'].effortLevel = 'medium';
  await writeFile(file, JSON.stringify(edited, null, 2));
  await target.install([MODEL_TOOL], OPTS);
  assert.equal((await read(file)).modelSettings['opencode/big-pickle'].effortLevel, 'low');
  await target.uninstall();
  assert.equal((await read(file)).modelSettings['opencode/big-pickle'].effortLevel, 'medium');
});

test('撤选模型时保留用户后来修改的档位值', async (t) => {
  const { file, target } = await withDir(t);
  await target.install([MODEL_TOOL], OPTS);
  const edited = await read(file);
  edited.modelSettings['opencode/big-pickle'].effortLevel = 'medium';
  await writeFile(file, JSON.stringify(edited, null, 2));
  await target.install([MODEL_CHAT], OPTS);
  assert.equal((await read(file)).modelSettings['opencode/big-pickle'].effortLevel, 'medium');
  await target.uninstall();
  assert.equal((await read(file)).modelSettings['opencode/big-pickle'].effortLevel, 'medium');
});

test('写入：不动用户手写段落，原值留档；移除后原样还原', async (t) => {
  const { file, target, dir } = await withDir(t, {
    permissions: { allow: ['Bash'] },
    theme: 'dark',
    env: { ANTHROPIC_BASE_URL: 'https://gateway.example.com', ANTHROPIC_AUTH_TOKEN: 'user-token', SHELL_SESSION_HISTORY: '0' },
    model: 'sonnet',
    modelSettings: { 'claude-opus-4-8': { effortLevel: 'high' } },
  });
  await target.install(MODELS, OPTS);
  const written = await read(file);
  assert.deepEqual(written.permissions, { allow: ['Bash'] });
  assert.equal(written.theme, 'dark');
  assert.equal(written.env.SHELL_SESSION_HISTORY, '0');
  assert.equal(written.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:41982', '我们的键覆盖同名用户值');
  assert.equal(written.modelSettings['claude-opus-4-8'].effortLevel, 'high', '别人家的模型条目不碰');

  const removed = await target.uninstall();
  assert.equal(removed.removed, 1);
  const restored = await read(file);
  assert.equal(restored.env.ANTHROPIC_BASE_URL, 'https://gateway.example.com', '原值要还回去');
  assert.equal(restored.env.ANTHROPIC_AUTH_TOKEN, 'user-token');
  assert.equal(restored.model, 'sonnet');
  assert.equal(restored.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined, '我们加的键要删干净');
  assert.equal(restored.env.OC_FAUCET_TARGET_MODELS, undefined);
  assert.equal(restored.modelSettings['opencode/big-pickle'], undefined);
  assert.deepEqual(restored.modelSettings['claude-opus-4-8'], { effortLevel: 'high' });
});

test('状态：本机网关没有专用归属标记时不算我们写的', async (t) => {
  const { file, target } = await withDir(t, { env: { ANTHROPIC_BASE_URL: 'https://gateway.example.com/v1' } });
  assert.deepEqual(await target.status(), { written: false, models: [] }, '外部网关不是我们写的');
  await target.install(MODELS, OPTS);
  assert.deepEqual((await target.status()).models, ['opencode/big-pickle', 'opencode/plain-free']);
  await writeFile(file, JSON.stringify({ env: {} }));
  assert.deepEqual(await target.status(), { written: false, models: [] }, '文件被外部清空后要如实报');
});

test('归属：用户自己的 127.0.0.1 网关不应被卸载', async (t) => {
  const initial = {
    env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8080', ANTHROPIC_AUTH_TOKEN: 'user-local-key' },
    model: 'my-local-model',
  };
  const { file, target } = await withDir(t, initial);
  const before = await readFile(file, 'utf8');
  assert.deepEqual(await target.status(), { written: false, models: [] });
  assert.deepEqual(await target.uninstall(), { removed: 0, changed: false });
  assert.equal(await readFile(file, 'utf8'), before);
});

test('重写：内容没变不写盘，改了模型清单才写', async (t) => {
  const { file, target } = await withDir(t);
  await target.install(MODELS, OPTS);
  assert.equal((await target.install(MODELS, OPTS)).changed, false);
  assert.equal((await target.install([MODEL_CHAT], OPTS)).changed, true);
  assert.equal((await read(file)).model, 'opencode/plain-free');
});

test('写入：modelPicker 把所选模型列进 /model 菜单，行尾带 modelOC 签名', async (t) => {
  const { file, target } = await withDir(t);
  await target.install(MODELS, OPTS);
  assert.deepEqual((await read(file)).modelPicker, {
    options: [
      { model: 'opencode/big-pickle', label: 'big-pickle', description: 'via modelOC' },
      { model: 'opencode/plain-free', label: 'plain-free', description: 'via modelOC' },
    ],
  });
});

test('modelPicker：用户自己写的菜单不覆盖、不摘除', async (t) => {
  const userPicker = { options: [{ model: 'my-org/my-model', label: '我的', description: '自己的菜单' }] };
  const { file, target } = await withDir(t, { modelPicker: userPicker });
  await target.install(MODELS, OPTS);
  assert.deepEqual((await read(file)).modelPicker, userPicker);
  await target.uninstall();
  assert.deepEqual((await read(file)).modelPicker, userPicker);
});

test('modelPicker：重装时更新我方菜单，卸载后整个摘掉', async (t) => {
  const { file, target } = await withDir(t);
  await target.install(MODELS, OPTS);
  await target.install([MODEL_CHAT], OPTS);
  assert.deepEqual((await read(file)).modelPicker.options, [
    { model: 'opencode/plain-free', label: 'plain-free', description: 'via modelOC' },
  ]);
  await target.uninstall();
  assert.equal((await read(file)).modelPicker, undefined);
});

test('modelPicker：卸载时用户已换成自己的菜单则不还原', async (t) => {
  const { file, target } = await withDir(t);
  await target.install(MODELS, OPTS);
  const edited = await read(file);
  edited.modelPicker = { options: [{ model: 'my-org/my-model', description: '自己的' }] };
  await writeFile(file, JSON.stringify(edited, null, 2));
  await target.uninstall();
  assert.deepEqual((await read(file)).modelPicker, { options: [{ model: 'my-org/my-model', description: '自己的' }] });
});

test('modelPicker：归属快照缺记录但菜单带签名时卸载仍摘掉', async (t) => {
  const { file, ownerFile, target } = await withDir(t);
  await target.install(MODELS, OPTS);
  const owner = JSON.parse(await readFile(ownerFile, 'utf8'));
  delete owner.keys[JSON.stringify(['modelPicker'])];
  await writeFile(ownerFile, JSON.stringify(owner, null, 2));
  await target.uninstall();
  assert.equal((await read(file)).modelPicker, undefined);
});

test('没有共同窗口时保留用户设置，卸载后也不误删', async (t) => {
  const { file, target } = await withDir(t);
  await target.install([{ ...MODEL_CHAT, contextWindow: null }], OPTS);
  const settings = await read(file);
  assert.equal(settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
});

test('上下文窗口为 null 时不写全局值，卸载也保留用户的显式 null', async (t) => {
  const { file, target } = await withDir(t, { env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: null } });
  await target.install([{ ...MODEL_CHAT, contextWindow: null }], OPTS);
  assert.equal((await read(file)).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, null);
  await target.uninstall();
  assert.equal((await read(file)).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, null);
});

test('空窗口或不同窗口时不覆盖预先存在的全局值', async (t) => {
  const { file, target } = await withDir(t, {
    env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '300000', CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '0' },
  });
  await target.install(MODELS, OPTS);
  const written = await read(file);
  assert.equal(written.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '300000');
  assert.equal(written.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, '1');
  await target.uninstall();
  const restored = await read(file);
  assert.equal(restored.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '300000');
  assert.equal(restored.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, '0');
});

test('归属快照丢失或损坏时拒绝安装和卸载，保留 Claude 配置', async (t) => {
  const { dir, file, target } = await withDir(t);
  await target.install(MODELS, OPTS);
  const before = await readFile(file, 'utf8');

  const missingSnapshotTarget = createClaudeTarget({ settingsPath: file, ownerFile: join(dir, 'missing-owner.json') });
  await assert.rejects(() => missingSnapshotTarget.install([MODEL_CHAT], OPTS), /归属快照.*不存在/);
  await assert.rejects(() => missingSnapshotTarget.uninstall(), /归属快照.*不存在/);
  assert.equal(await readFile(file, 'utf8'), before);

  const corruptOwner = join(dir, 'corrupt-owner.json');
  await writeFile(corruptOwner, '{坏掉的');
  const corruptSnapshotTarget = createClaudeTarget({ settingsPath: file, ownerFile: corruptOwner });
  await assert.rejects(() => corruptSnapshotTarget.install([MODEL_CHAT], OPTS), /归属快照.*合法 JSON/);
  await assert.rejects(() => corruptSnapshotTarget.uninstall(), /归属快照.*合法 JSON/);
  assert.equal(await readFile(file, 'utf8'), before);
});

test('旧版接入的空快照缺少原值记录时拒绝重装和卸载', async (t) => {
  const legacySettings = {
    env: {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:41982',
      ANTHROPIC_AUTH_TOKEN: 'ocf-test-key',
      OC_FAUCET_TARGET_MODELS: 'opencode/big-pickle,opencode/plain-free',
    },
    model: 'opencode/big-pickle',
  };
  const { file, ownerFile, target } = await withDir(t, legacySettings);
  await writeFile(ownerFile, '{}');
  const before = await readFile(file, 'utf8');
  assert.deepEqual((await target.status()).models, ['opencode/big-pickle', 'opencode/plain-free']);
  await assert.rejects(() => target.install([MODEL_CHAT], OPTS), /归属快照.*缺少配置所需的原值记录/);
  await assert.rejects(() => target.uninstall(), /归属快照.*缺少配置所需的原值记录/);
  assert.equal(await readFile(file, 'utf8'), before);
});

test('归属快照写入失败时不先改 Claude 配置', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-claude-'));
  const file = join(dir, 'settings.json');
  const ownerFile = join(dir, 'owner-dir');
  await mkdir(ownerFile);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = createClaudeTarget({ settingsPath: file, ownerFile });
  await assert.rejects(() => target.install(MODELS, OPTS));
  await assert.rejects(() => readFile(file, 'utf8'), { code: 'ENOENT' });
});

test('坏文件一律拒绝：非 JSON、顶层非对象、env 不是对象', async (t) => {
  for (const bad of ['{ 坏掉的', '[1,2]', '{"env": "不是对象"}']) {
    const { target } = await withDir(t, bad);
    await assert.rejects(() => target.install(MODELS, OPTS), /没有改动它/);
  }
});

test('空模型清单：拒绝写入', async (t) => {
  const { target } = await withDir(t);
  await assert.rejects(() => target.install([], OPTS), /至少勾选一个/);
  await assert.rejects(() => target.install(MODELS, { port: 0, apiKey: 'x' }), /端口不合法/);
  await assert.rejects(() => target.install([{ id: '没有斜杠' }], OPTS), /合法的 id/);
});

test('没写过就摘除：不动文件', async (t) => {
  const { file, target } = await withDir(t, { theme: 'light' });
  assert.deepEqual(await target.uninstall(), { removed: 0, changed: false });
  assert.deepEqual(await read(file), { theme: 'light' });
});
