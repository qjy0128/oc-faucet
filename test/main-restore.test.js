/**
 * Bridge 启动时「恢复模型」这一步的测试。
 *
 * 挡的是一个真实踩到的坑：转发口起来了、ZCode 也指着它，但桥手上一个模型都没有，
 * 于是 ZCode 每次提问都收到「模型不存在」，而界面上一切显示正常。
 *
 * 这里不需要真的 OpenCode：restore() 只跟 client 要一份模型清单，用一个假 client
 * 就够了，测起来是毫秒级的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Bridge } from '../src/main.js';
import { ProbeCache } from '../src/probe-cache.js';
import { PROBE_FINGERPRINT } from '../src/probe.js';
import * as settings from '../src/settings.js';

const PROVIDERS = {
  providers: [
    {
      id: 'opencode',
      name: 'OpenCode',
      models: {
        'good-one': { name: '能用的', cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } },
        'other-one': { name: '另一个', cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } },
        'untested': { name: '没测过的', cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } },
      },
    },
  ],
};

/** 只提供 restore() 需要的那点东西：providers() 和 ready */
function fakeClient() {
  return { ready: true, baseUrl: 'http://127.0.0.1:1', providers: async () => PROVIDERS };
}

/**
 * 造一个「已经停过检查」的桥：数据目录是临时目录，缓存文件提前写好。
 * 不走 start()，因为那会真的去拉起 OpenCode 进程。
 */
async function bridgeWithCache({ cacheEntries, ttlMinutes = 360 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'oc-restore-'));
  process.env.OCF_DATA_DIR = dir;
  await mkdir(join(dir, 'workspace'), { recursive: true });
  await writeFile(
    join(dir, 'settings.json'),
    `${JSON.stringify({ probeTtlMinutes: ttlMinutes })}\n`,
    'utf8',
  );

  const cache = new ProbeCache({ file: join(dir, 'probe-cache.json') });
  for (const [modelId, entry] of Object.entries(cacheEntries ?? {})) {
    await cache.set(modelId, entry.fingerprint ?? PROBE_FINGERPRINT, entry.verdict, entry.note ?? '');
  }

  const bridge = new Bridge({ log: () => {} });
  bridge.client = fakeClient();
  return { bridge, dir };
}

test('restore：把缓存里的判定装回来，端口不再空转', async (t) => {
  const { bridge, dir } = await bridgeWithCache({
    cacheEntries: {
      'opencode/good-one': { verdict: 'tool' },
      'opencode/other-one': { verdict: 'chat' },
    },
  });
  t.after(async () => {
    delete process.env.OCF_DATA_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  // 修复前正是这样：缓存文件在磁盘上好好的，桥手上却是空的。
  assert.equal(bridge.getModels().length, 0, 'restore 之前应当是零个可用模型');

  const restored = await bridge.restore();
  assert.equal(restored, 2, '两条结论都该被载回来');

  const available = bridge.getModels().map((m) => m.id).sort();
  assert.deepEqual(available, ['opencode/good-one', 'opencode/other-one']);
  // 「只能聊天」的仍然算可用（要放进 ZCode），但要标记出来
  const chatOnly = bridge.getModels().find((m) => m.id === 'opencode/other-one');
  assert.equal(chatOnly.chatOnly, true);
});

test('restore：没体检过的模型不会被当成可用', async (t) => {
  const { bridge, dir } = await bridgeWithCache({ cacheEntries: {} });
  t.after(async () => {
    delete process.env.OCF_DATA_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  assert.equal(await bridge.restore(), 0);
  assert.equal(bridge.getModels().length, 0, '没测过就不能给 ZCode 用——这是体检存在的意义');
});

test('restore：指纹对不上的旧结论会被丢掉', async (t) => {
  const { bridge, dir } = await bridgeWithCache({
    cacheEntries: { 'opencode/good-one': { verdict: 'tool', fingerprint: 'v0-旧版本' } },
  });
  t.after(async () => {
    delete process.env.OCF_DATA_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  assert.equal(await bridge.restore(), 0, '体检口径变了，旧结论必须作废');
});

test('restore：过期的结论会被丢掉', async (t) => {
  const { bridge, dir } = await bridgeWithCache({ cacheEntries: {} });
  t.after(async () => {
    delete process.env.OCF_DATA_DIR;
    await rm(dir, { recursive: true, force: true });
  });
  // 直接写缓存文件：cache.set() 盖的是「现在」的时间戳，造不出过期条目。
  // 注意不能靠把 ttlMinutes 设成 0 来测——0 会被当成非法值回落到默认 360 分钟。
  await writeFile(
    join(dir, 'probe-cache.json'),
    `${JSON.stringify({
      version: 1,
      entries: {
        'opencode/good-one': {
          fingerprint: PROBE_FINGERPRINT,
          verdict: 'tool',
          note: '',
          checkedAt: Date.now() - 7 * 3600 * 1000, // 7 小时前，超过默认 6 小时
        },
      },
    })}\n`,
    'utf8',
  );

  assert.equal(await bridge.restore(), 0, '过了保质期的结论不能再用');
});

test('restore：缓存文件是坏的也不抛，只是没有可用模型', async (t) => {
  const { bridge, dir } = await bridgeWithCache({ cacheEntries: {} });
  t.after(async () => {
    delete process.env.OCF_DATA_DIR;
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(join(dir, 'probe-cache.json'), '{ 这不是 JSON', 'utf8');

  // 缓存坏掉最多让体检重跑一遍，绝不该让端口起不来
  assert.equal(await bridge.restore(), 0);
});

test('restore：重复调用不会把已经更新的结论覆盖回旧的', async (t) => {
  const { bridge, dir } = await bridgeWithCache({
    cacheEntries: { 'opencode/good-one': { verdict: 'tool', note: '旧结论' } },
  });
  t.after(async () => {
    delete process.env.OCF_DATA_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  await bridge.restore();
  // 假装刚跑完一次体检，拿到了新结论：这个模型其实用不了
  bridge.state.verdicts.set('opencode/good-one', { verdict: 'failed', note: '刚测的', cached: false });

  await bridge.restore();
  assert.equal(
    bridge.state.verdicts.get('opencode/good-one').note,
    '刚测的',
    '内存里更新的结论不能被磁盘上的旧结论覆盖回去',
  );
});
