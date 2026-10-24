/** Pi 接入目标测试：所有读写都指向临时目录，不碰 ~/.pi/agent。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPiTarget, PI_OWNER, PI_OWNER_HEADER, PI_PROVIDER_KEY } from '../src/target-pi.js';

const MODEL_A = {
  id: 'opencode/deepseek-v4.1-flash-free',
  name: 'DeepSeek V4.1 Flash',
  reasoning: true,
  images: true,
  contextWindow: 200000,
  maxTokens: 8192,
};
const MODEL_B = {
  id: 'opencode/glm-5.3-flash-free',
  name: 'GLM 5.3 Flash',
  reasoning: false,
  images: false,
  contextWindow: null,
};
const OPTS = { port: 41982, apiKey: 'oc-secret' };

async function withTempPi(t, initial) {
  const dir = await mkdtemp(join(tmpdir(), 'oc-pi-'));
  const file = join(dir, 'models.json');
  if (initial !== undefined) {
    await writeFile(file, typeof initial === 'string' ? initial : JSON.stringify(initial, null, 2));
  }
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, file, target: createPiTarget({ agentDir: dir, modelsFile: file }) };
}

function ownProvider(models = []) {
  return {
    baseUrl: 'http://127.0.0.1:41982/v1',
    api: 'openai-completions',
    apiKey: 'oc-secret',
    headers: { [PI_OWNER_HEADER]: PI_OWNER },
    models,
  };
}

test('目标形状：Pi 导出统一的 detect/status/install/uninstall 接口', () => {
  const target = createPiTarget();
  assert.equal(target.id, 'pi');
  assert.equal(target.label, 'Pi');
  for (const method of ['detect', 'status', 'install', 'uninstall']) {
    assert.equal(typeof target[method], 'function');
  }
});

test('detect：PI_CODING_AGENT_DIR 是 Pi agent 目录本身', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-pi-home-'));
  const agentDir = join(dir, 'custom-agent');
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
    await rm(dir, { recursive: true, force: true });
  });

  const target = createPiTarget();
  assert.equal(target.detect(), false);
  await mkdir(agentDir);
  assert.equal(target.detect(), true);
  await target.install([MODEL_A], OPTS);
  assert.equal(JSON.parse(await readFile(join(agentDir, 'models.json'), 'utf8')).providers[PI_PROVIDER_KEY].api, 'openai-completions');
});

test('install：按 Pi 官方字段写入 provider、完整模型 id 与上下文窗口', async (t) => {
  const { file, target } = await withTempPi(t);
  const result = await target.install([MODEL_A, MODEL_B], OPTS);
  assert.deepEqual(result, { added: 2, skipped: [], changed: true });

  const config = JSON.parse(await readFile(file, 'utf8'));
  const provider = config.providers[PI_PROVIDER_KEY];
  assert.equal(provider.baseUrl, 'http://127.0.0.1:41982/v1');
  assert.equal(provider.api, 'openai-completions');
  assert.equal(provider.apiKey, 'oc-secret');
  assert.equal(provider.headers[PI_OWNER_HEADER], PI_OWNER);
  assert.deepEqual(provider.models, [
    {
      id: MODEL_A.id,
      name: 'OC Faucet · DeepSeek V4.1 Flash',
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: 200000,
      maxTokens: 8192,
    },
    {
      id: MODEL_B.id,
      name: 'OC Faucet · GLM 5.3 Flash',
      reasoning: false,
      input: ['text'],
    },
  ]);
  assert.equal((await stat(file)).mode & 0o777, 0o600, '配置包含明文密钥，权限应为 0600');
});

test('install：接受 JSONC，并保留其它 provider 与顶层用户设置', async (t) => {
  const { file, target } = await withTempPi(
    t,
    `{
      // 用户原有模型配置
      "providers": {
        "my-provider": {
          "baseUrl": "https://example.com/v1", // 注释中的斜杠不能误删
          "api": "openai-completions",
          "apiKey": "user-key",
          "models": [{ "id": "own-model", "name": "我的模型", }],
        },
      },
      "theme": "dark",
      "description": "用户配置🙂", // emoji 后面的注释也必须正确解析
      "text": "https://example.com/a//b",
    }`,
  );
  await target.install([MODEL_A], OPTS);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(saved.providers['my-provider'].models, [{ id: 'own-model', name: '我的模型' }]);
  assert.equal(saved.providers['my-provider'].baseUrl, 'https://example.com/v1');
  assert.equal(saved.theme, 'dark');
  assert.equal(saved.description, '用户配置🙂');
  assert.equal(saved.text, 'https://example.com/a//b');
});

test('install：未签名的 oc-faucet provider 冲突时拒绝覆盖', async (t) => {
  const userProvider = { baseUrl: 'https://user.example/v1', api: 'openai-completions', models: [] };
  const { file, target } = await withTempPi(t, { providers: { [PI_PROVIDER_KEY]: userProvider } });
  const before = await readFile(file, 'utf8');
  await assert.rejects(() => target.install([MODEL_A], OPTS), /没有 OC Faucet 的受管标记/);
  assert.equal(await readFile(file, 'utf8'), before);
});

test('install：已签名 provider 内同名用户模型保留，跳过并报告冲突 id', async (t) => {
  const userEntry = { id: MODEL_A.id, name: '用户自己改的名字', reasoning: false, input: ['text'] };
  const { file, target } = await withTempPi(t, { providers: { [PI_PROVIDER_KEY]: ownProvider([userEntry]) } });
  const result = await target.install([MODEL_A, MODEL_B], OPTS);
  assert.equal(result.added, 1);
  assert.deepEqual(result.skipped, [MODEL_A.id]);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(saved.providers[PI_PROVIDER_KEY].models[0], userEntry);
});

test('install：重装幂等，写前备份仅一份', async (t) => {
  const { dir, file, target } = await withTempPi(t, { theme: 'dark' });
  await target.install([MODEL_A], OPTS);
  const first = await stat(file);
  const second = await target.install([MODEL_A], OPTS);
  assert.equal(second.changed, false);
  assert.equal((await stat(file)).mtimeMs, first.mtimeMs);
  const backups = (await readdir(dir)).filter((name) => name.includes('oc-faucet-backup-'));
  assert.equal(backups.length, 1);
  assert.deepEqual(JSON.parse(await readFile(join(dir, backups[0]), 'utf8')), { theme: 'dark' });
});

test('install：危险密钥或坏 JSONC 拒绝写入', async (t) => {
  const { file, target } = await withTempPi(t, { theme: 'dark' });
  const before = await readFile(file, 'utf8');
  await assert.rejects(() => target.install([MODEL_A], { ...OPTS, apiKey: '!echo secret' }), /当命令/);
  await assert.rejects(() => target.install([MODEL_A], { ...OPTS, apiKey: 'PLAIN_ENV_NAME' }), /环境变量引用/);
  assert.equal(await readFile(file, 'utf8'), before);

  await writeFile(file, '{ "providers": { /* 注释没结束');
  const corruptBefore = await readFile(file, 'utf8');
  await assert.rejects(() => target.install([MODEL_A], OPTS), /不是合法的 JSONC/);
  assert.equal(await readFile(file, 'utf8'), corruptBefore);
});

test('status/uninstall：只移除签名模型，用户模型和其它 provider 保留', async (t) => {
  const userEntry = { id: 'user/own-model', name: '用户模型', reasoning: false, input: ['text'] };
  const { file, target } = await withTempPi(t, {
    providers: { [PI_PROVIDER_KEY]: ownProvider([userEntry]), 'my-provider': { apiKey: 'keep-me' } },
    theme: 'dark',
  });
  assert.deepEqual(await target.status(), { written: false, models: [] });
  await target.install([MODEL_A], OPTS);
  assert.deepEqual(await target.status(), { written: true, models: [MODEL_A.id] });

  const result = await target.uninstall();
  assert.deepEqual(result, { removed: 1, changed: true });
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(saved.providers[PI_PROVIDER_KEY].models, [userEntry]);
  assert.equal('headers' in saved.providers[PI_PROVIDER_KEY], false, '不遗留我们的签名');
  assert.deepEqual(saved.providers['my-provider'], { apiKey: 'keep-me' });
  assert.equal(saved.theme, 'dark');
  assert.deepEqual(await target.status(), { written: false, models: [] });
});

test('uninstall：清除唯一由 Pi 目标创建的 provider', async (t) => {
  const { file, target } = await withTempPi(t);
  await target.install([MODEL_A], OPTS);
  assert.deepEqual(await target.uninstall(), { removed: 1, changed: true });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {});
});

test('uninstall：清理 install([]) 建立的空 provider', async (t) => {
  const { file, target } = await withTempPi(t);
  await target.install([], OPTS);
  assert.deepEqual(await target.uninstall(), { removed: 0, changed: true });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {});
});
