/**
 * 体检模块的测试。全部用假 client 打桩，不访问网络、不需要本机跑着 OpenCode。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { probe, probeMany, PROBE_FINGERPRINT } from '../src/probe.js';
import { ProbeCache } from '../src/probe-cache.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oc-probe-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function makeModel(id) {
  const [providerID, ...rest] = id.split('/');
  return {
    id,
    providerID,
    modelID: rest.join('/'),
    name: rest.join('/'),
    free: true,
    reasoning: false,
    variants: {},
    images: false,
    contextWindow: 200000,
    deprecated: false,
  };
}

/**
 * 假 client：只实现契约第 5 节里 probe 用到的那几个方法。
 * @param {object} o
 * @param {(req:object)=>any} o.reply 给什么就返回什么；返回 Error 就抛出
 * @param {number} [o.delayMs] 每次 prompt 先睡多久（用来验证真并发）
 */
function makeClient({ reply, delayMs = 0 } = {}) {
  const state = { prompts: [], createdDirs: [], deleted: [], inFlight: 0, maxInFlight: 0, sessions: 0 };

  const client = {
    state,
    async createSession({ title, directory } = {}) {
      state.sessions += 1;
      state.createdDirs.push(directory);
      return `sess-${state.sessions}`;
    },
    async deleteSession(id) {
      state.deleted.push(id);
    },
    async prompt(req) {
      state.prompts.push(req);
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        if (delayMs > 0) await sleep(delayMs);
        const out = typeof reply === 'function' ? await reply(req) : reply;
        if (out instanceof Error) throw out;
        if (typeof out === 'string') return { text: out, tokens: null };
        return out;
      } finally {
        state.inFlight -= 1;
      }
    },
  };
  return client;
}

/** 体检提示词里出现了绝对路径，假模型从这里把靶子路径抠出来，跟真模型看到的信息一致 */
function targetPathOf(req) {
  const match = req.text.match(/读取这个文件：(\S+)/);
  assert.ok(match, '用户消息里应该带上靶子文件的绝对路径');
  return match[1];
}

/* ------------------------------------------------------------------ *
 * probe：单个模型
 * ------------------------------------------------------------------ */

test('probe：正确返回 read 调用 → tool', async (t) => {
  const dir = await tempDir(t);
  const model = makeModel('opencode/good');
  let sawFileContent = null;

  const client = makeClient({
    reply: async (req) => {
      const filePath = targetPathOf(req);
      const token = (await readFile(filePath, 'utf8')).trim();
      sawFileContent = token;
      // 模拟一个“真会用工具”的模型：用工具给出的绝对路径，把读到的 token 说出来
      return {
        text: JSON.stringify({ content: `token 是 ${token}`, calls: [{ name: 'read', arguments: { filePath } }] }),
        tokens: null,
      };
    },
  });

  const result = await probe(client, model, { workdir: dir });

  assert.equal(result.verdict, 'tool');
  assert.equal(result.note, '能按协议产生工具调用');
  assert.ok(result.elapsedMs >= 0 && Number.isFinite(result.elapsedMs));
  assert.match(sawFileContent, /^OZ-PROBE-[0-9a-f]{8}$/, '靶子文件里应该是一行随机 token');

  const req = client.state.prompts[0];
  assert.equal(req.providerID, 'opencode');
  assert.equal(req.modelID, 'good');
  assert.equal(req.sessionID, 'sess-1');
  assert.match(req.system, /read/);
  assert.match(req.system, /calls/);
  assert.ok(req.timeoutMs > 0);
  assert.ok(!req.text.includes(sawFileContent), '提示词里绝不能出现 token，否则模型不用读文件也能蒙对');
  assert.ok(!req.system.includes(sawFileContent), '提示词里绝不能出现 token，否则模型不用读文件也能蒙对');

  // 会话用一次就删，靶子文件用完就删
  assert.deepEqual(client.state.deleted, ['sess-1']);
  assert.equal(client.state.createdDirs[0], dir);
  await assert.rejects(access(targetPathOf(req)), '靶子临时文件应该被清理掉');
});

test('probe：只回 JSON 文本、没有 calls → chat', async (t) => {
  const dir = await tempDir(t);
  const client = makeClient({ reply: '{"content":"你好，我是聊天模型，帮不了你。","calls":[]}' });

  const result = await probe(client, makeModel('opencode/chatty'), { workdir: dir });

  assert.equal(result.verdict, 'chat');
  assert.equal(result.note, '只能普通对话，已关闭工具');
  assert.equal(client.state.deleted.length, 1, '不管结果如何都要把一次性会话删掉');
});

test('probe：回的是非 JSON 的人话 → chat', async (t) => {
  const dir = await tempDir(t);
  const client = makeClient({ reply: '我是一个语言模型，不太清楚你想让我做什么。' });

  const result = await probe(client, makeModel('opencode/plain'), { workdir: dir });

  assert.equal(result.verdict, 'chat');
  assert.equal(result.note, '只能普通对话，已关闭工具');
});

test('probe：Markdown 围栏包着的正确信封也算 tool', async (t) => {
  const dir = await tempDir(t);
  const client = makeClient({
    reply: (req) => {
      const filePath = targetPathOf(req);
      return `\`\`\`json\n${JSON.stringify({ content: '', calls: [{ name: 'read', arguments: { filePath } }] })}\n\`\`\``;
    },
  });

  const result = await probe(client, makeModel('opencode/fenced'), { workdir: dir });
  assert.equal(result.verdict, 'tool');
});

test('probe：调用打偏了（没有 read / 参数里没有目标文件）→ 抛异常，不放宽', async (t) => {
  const dir = await tempDir(t);

  const wrongTool = makeClient({ reply: '{"content":"我读了","calls":[{"name":"bash","arguments":{"command":"cat /tmp/x"}}]}' });
  await assert.rejects(
    () => probe(wrongTool, makeModel('opencode/wrongtool'), { workdir: dir }),
    /没有指向目标文件的 read 调用/,
  );

  const wrongPath = makeClient({ reply: '{"content":"我读了","calls":[{"name":"read","arguments":{"filePath":"/etc/hosts"}}]}' });
  await assert.rejects(
    () => probe(wrongPath, makeModel('opencode/wrongpath'), { workdir: dir }),
    /没有指向目标文件的 read 调用/,
  );
});

test('probe：空回复、空 content 且无 calls → 抛异常', async (t) => {
  const dir = await tempDir(t);

  const empty = makeClient({ reply: '   ' });
  await assert.rejects(() => probe(empty, makeModel('opencode/empty'), { workdir: dir }), /没有返回任何文本内容/);

  const hollow = makeClient({ reply: '{"content":"","calls":[]}' });
  await assert.rejects(() => probe(hollow, makeModel('opencode/hollow'), { workdir: dir }), /既没有工具调用也没有任何文字内容/);

  // calls 写了但不是数组：拿不准，按失败处理
  const badCalls = makeClient({ reply: '{"content":"我读了","calls":"read /tmp/x"}' });
  await assert.rejects(() => probe(badCalls, makeModel('opencode/badcalls'), { workdir: dir }), /不是一个数组/);
});

test('probe：参数里放嵌套结构也能识别出目标文件', async (t) => {
  const dir = await tempDir(t);
  const client = makeClient({
    reply: (req) => {
      const filePath = targetPathOf(req);
      // 参数形状歪一点（不完全是 {filePath}），但字符串值里有目标路径，仍算会用工具
      return JSON.stringify({ content: '读了', calls: [{ name: 'read', arguments: { args: [filePath] } }] });
    },
  });

  const result = await probe(client, makeModel('opencode/nested'), { workdir: dir });
  assert.equal(result.verdict, 'tool');
});

test('probe：顶层不是信封对象的怪形状一律当 chat（宁可漏判，不可错判成 tool）', async (t) => {
  const dir = await tempDir(t);

  // 顶层是数组：不是信封，但确实是"模型吐了一段文本"，按 chat 处理 → 该模型不会被放行
  const arrayTop = makeClient({ reply: '[{"name":"read","arguments":{"filePath":"/tmp/whatever"}}]' });
  const result = await probe(arrayTop, makeModel('opencode/arr'), { workdir: dir });
  assert.equal(result.verdict, 'chat', '认不出信封时绝不能判成能用工具');
  assert.equal(result.note, '只能普通对话，已关闭工具');
});

test('probe：prompt 抛错时异常要冒出来（由调用方记为 failed）', async (t) => {
  const dir = await tempDir(t);
  const client = makeClient({ reply: new Error('上游 502：模型服务暂时不可用') });

  await assert.rejects(() => probe(client, makeModel('opencode/boom'), { workdir: dir }), /模型服务暂时不可用/);
});

test('probe：workdir 不是绝对路径 / 不存在 / 是个文件时直接报错', async (t) => {
  const dir = await tempDir(t);
  const client = makeClient({ reply: '{"content":"x","calls":[]}' });

  await assert.rejects(() => probe(client, makeModel('opencode/a'), { workdir: 'relative/dir' }), /必须是绝对路径/);
  await assert.rejects(
    () => probe(client, makeModel('opencode/a'), { workdir: path.join(dir, '不存在') }),
    /工作目录不存在/,
  );

  const asFile = path.join(dir, 'a-file.txt');
  await writeFile(asFile, 'x', 'utf8');
  await assert.rejects(() => probe(client, makeModel('opencode/a'), { workdir: asFile }), /不是一个目录/);

  assert.equal(client.state.prompts.length, 0, '参数不合法时不该去打扰模型');
});

test('probe：模型超时会被掐断，并被记为失败', async (t) => {
  const dir = await tempDir(t);
  // 假模型装死不回话（也完全不理会 abort 信号）；probe 必须自己收手，不能一直挂着
  const client = makeClient({ delayMs: 400, reply: '{"content":"太慢了","calls":[]}' });

  const startedAt = Date.now();
  const result = await probeMany({ client, models: [makeModel('opencode/slow')], workdir: dir, timeoutMs: 60 });
  const elapsed = Date.now() - startedAt;

  assert.equal(result[0].verdict, 'failed');
  assert.match(result[0].note, /超时/);
  assert.ok(elapsed < 300, `必须赶在模型回话之前就收手（假模型要睡 400ms，实测 ${elapsed}ms）`);
});

/* ------------------------------------------------------------------ *
 * probeMany：一批模型
 * ------------------------------------------------------------------ */

test('probeMany：单个模型失败不带崩整批，失败项记 failed', async (t) => {
  const dir = await tempDir(t);
  const models = [makeModel('opencode/a'), makeModel('opencode/bad'), makeModel('opencode/c')];

  const client = makeClient({
    reply: (req) => {
      if (req.modelID === 'bad') throw new Error('上游超时');
      const filePath = targetPathOf(req);
      return { text: JSON.stringify({ content: 'ok', calls: [{ name: 'read', arguments: { filePath } }] }), tokens: null };
    },
  });

  const results = await probeMany({ client, models, workdir: dir });

  assert.equal(results.length, 3);
  assert.deepEqual(results.map((r) => r.verdict), ['tool', 'failed', 'tool']);
  assert.equal(results[1].model.id, 'opencode/bad');
  assert.match(results[1].note, /体检失败：上游超时/);
  assert.ok(results[1].error instanceof Error);
  assert.equal(results[1].cached, false);
  assert.equal(results[0].cached, false);
});

test('probeMany：真并发（6 个模型 × 每个 100ms，concurrency=3 → 远快于串行）', async (t) => {
  const dir = await tempDir(t);
  const models = Array.from({ length: 6 }, (_, i) => makeModel(`opencode/m${i}`));

  const client = makeClient({
    delayMs: 100,
    reply: (req) => {
      const filePath = targetPathOf(req);
      return { text: JSON.stringify({ content: '', calls: [{ name: 'read', arguments: { filePath } }] }), tokens: null };
    },
  });

  const startedAt = Date.now();
  const results = await probeMany({ client, models, workdir: dir, concurrency: 3 });
  const elapsed = Date.now() - startedAt;

  console.log(`并发实测：6 个模型 / 每个 100ms / concurrency=3 → ${elapsed}ms（串行会是 600ms 以上）`);
  assert.equal(results.length, 6);
  assert.ok(results.every((r) => r.verdict === 'tool'));

  assert.ok(elapsed < 400, `必须真并发：实测 ${elapsed}ms，串行会是 600ms 以上`);
  assert.equal(client.state.maxInFlight, 3, '同时在跑的请求数应该正好等于并发度 3');
});

test('probeMany：onProgress 每个模型完成时调一次，done 从 1 递增到 total', async (t) => {
  const dir = await tempDir(t);
  const models = Array.from({ length: 5 }, (_, i) => makeModel(`opencode/p${i}`));
  const client = makeClient({
    delayMs: 10,
    reply: (req) => {
      const filePath = targetPathOf(req);
      return JSON.stringify({ content: '', calls: [{ name: 'read', arguments: { filePath } }] });
    },
  });

  const events = [];
  const results = await probeMany({
    client,
    models,
    workdir: dir,
    concurrency: 2,
    onProgress: (p) => events.push({ ...p }),
  });

  assert.equal(events.length, 5, 'onProgress 必须每个模型调一次，不管成功失败');
  assert.deepEqual(events.map((e) => e.done), [1, 2, 3, 4, 5]);
  assert.ok(events.every((e) => e.total === 5));
  assert.deepEqual(events.map((e) => e.model.id).sort(), models.map((m) => m.id).sort());
  assert.ok(events.every((e) => e.result && typeof e.result.verdict === 'string'));
  // 结果顺序必须跟传入顺序一致，不能因为并发而乱序
  assert.deepEqual(results.map((r) => r.model.id), models.map((m) => m.id));
});

test('probeMany：失败也要计入 onProgress', async (t) => {
  const dir = await tempDir(t);
  const models = [makeModel('opencode/ok'), makeModel('opencode/bad')];
  const client = makeClient({
    reply: (req) => {
      if (req.modelID === 'bad') throw new Error('塌了');
      const filePath = targetPathOf(req);
      return JSON.stringify({ content: '', calls: [{ name: 'read', arguments: { filePath } }] });
    },
  });

  const events = [];
  await probeMany({ client, models, workdir: dir, onProgress: (p) => events.push(p) });

  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.done), [1, 2]);
  assert.equal(events.filter((e) => e.result.verdict === 'failed').length, 1);
});

test('probeMany：缓存命中就不再调用 client.prompt', async (t) => {
  const dir = await tempDir(t);
  const cache = new ProbeCache({ file: path.join(dir, 'cache.json') });
  await cache.load();
  await cache.set('opencode/hit', PROBE_FINGERPRINT, 'tool', '能按协议产生工具调用');

  const models = [makeModel('opencode/hit'), makeModel('opencode/miss')];
  const client = makeClient({
    reply: (req) => {
      const filePath = targetPathOf(req);
      return JSON.stringify({ content: '', calls: [{ name: 'read', arguments: { filePath } }] });
    },
  });

  const results = await probeMany({ client, models, workdir: dir, cache });

  assert.equal(client.state.prompts.length, 1, '命中缓存的模型不该再去打扰上游');
  assert.equal(client.state.prompts[0].modelID, 'miss');

  const hit = results.find((r) => r.model.id === 'opencode/hit');
  assert.equal(hit.verdict, 'tool');
  assert.equal(hit.cached, true);
  assert.equal(hit.note, '能按协议产生工具调用');

  const miss = results.find((r) => r.model.id === 'opencode/miss');
  assert.equal(miss.cached, false);
  // 新测出来的结论要写回缓存
  assert.equal(cache.get('opencode/miss', PROBE_FINGERPRINT)?.verdict, 'tool');
});

test('probeMany：force=true 时即使有缓存也重测', async (t) => {
  const dir = await tempDir(t);
  const cache = new ProbeCache({ file: path.join(dir, 'cache.json') });
  await cache.load();
  await cache.set('opencode/hit', PROBE_FINGERPRINT, 'tool', '能按协议产生工具调用');

  const client = makeClient({ reply: '{"content":"我只会聊天","calls":[]}' });
  const results = await probeMany({ client, models: [makeModel('opencode/hit')], workdir: dir, cache, force: true });

  assert.equal(client.state.prompts.length, 1, 'force=true 必须真的重测');
  assert.equal(results[0].verdict, 'chat');
  assert.equal(results[0].cached, false);
  // 结论被刷新了
  assert.equal(cache.get('opencode/hit', PROBE_FINGERPRINT)?.verdict, 'chat');
});

test('probeMany：指纹变了缓存就不算数', async (t) => {
  const dir = await tempDir(t);
  const cache = new ProbeCache({ file: path.join(dir, 'cache.json') });
  await cache.load();
  await cache.set('opencode/hit', 'v0-旧口径', 'tool', '旧结论');

  const client = makeClient({ reply: '{"content":"我只会聊天","calls":[]}' });
  const results = await probeMany({ client, models: [makeModel('opencode/hit')], workdir: dir, cache });

  assert.equal(client.state.prompts.length, 1, '指纹不同必须重测');
  assert.equal(results[0].verdict, 'chat');
  assert.equal(results[0].cached, false);
});

test('probeMany：失败的结论也写缓存，但走短 TTL（池子轮换后自动翻案）', async (t) => {
  const dir = await tempDir(t);
  // failureTtlMs 压到 60ms，等它过期验证"失败会自动作废"
  const cache = new ProbeCache({ file: path.join(dir, 'cache.json'), failureTtlMs: 60 });
  await cache.load();

  const client = makeClient({ reply: new Error('上游炸了') });
  const results = await probeMany({ client, models: [makeModel('opencode/bad')], workdir: dir, cache });

  assert.equal(results[0].verdict, 'failed');
  assert.equal(cache.get('opencode/bad', PROBE_FINGERPRINT)?.verdict, 'failed', '失败结论要进缓存（短 TTL）');
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(cache.get('opencode/bad', PROBE_FINGERPRINT), null, '短 TTL 一过自动作废，下次重测');
});

test('probeMany：并发上限夹到 6，空列表不炸', async (t) => {
  const dir = await tempDir(t);
  const models = Array.from({ length: 10 }, (_, i) => makeModel(`opencode/n${i}`));
  const client = makeClient({
    delayMs: 5,
    reply: (req) => {
      const filePath = targetPathOf(req);
      return JSON.stringify({ content: '', calls: [{ name: 'read', arguments: { filePath } }] });
    },
  });

  const results = await probeMany({ client, models, workdir: dir, concurrency: 99 });
  assert.equal(results.length, 10);
  assert.ok(client.state.maxInFlight <= 6, `并发上限必须是 6，实测 ${client.state.maxInFlight}`);

  const empty = await probeMany({ client: makeClient({ reply: '' }), models: [], workdir: dir });
  assert.deepEqual(empty, []);
});

test('probeMany：onProgress 自己抛错不能把体检带崩', async (t) => {
  const dir = await tempDir(t);
  const client = makeClient({ reply: '{"content":"我只会聊天","calls":[]}' });

  const results = await probeMany({
    client,
    models: [makeModel('opencode/a'), makeModel('opencode/b')],
    workdir: dir,
    onProgress: () => {
      throw new Error('调用方的回调写崩了');
    },
  });

  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.verdict === 'chat'));
});

test('PROBE_FINGERPRINT 是个非空常量', () => {
  assert.equal(typeof PROBE_FINGERPRINT, 'string');
  assert.ok(PROBE_FINGERPRINT.length > 0);
});

test('probe 用完不留临时文件', async (t) => {
  const dir = await tempDir(t);
  const client = makeClient({ reply: '{"content":"我只会聊天","calls":[]}' });
  await probe(client, makeModel('opencode/a'), { workdir: dir });
  await probe(client, makeModel('opencode/b'), { workdir: dir });

  assert.deepEqual(await readdir(dir), [], '靶子文件必须清理干净');
});
