/**
 * 体检缓存的测试。全部在系统临时目录里跑，不碰网络、不碰真实数据目录。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ProbeCache } from '../src/probe-cache.js';

/** 建一个隔离的临时目录，测试结束自动删掉 */
async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oc-probe-cache-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('未命中：空缓存 get 返回 null', async (t) => {
  const dir = await tempDir(t);
  const cache = new ProbeCache({ file: path.join(dir, 'probe.json') });
  await cache.load();

  assert.equal(cache.get('opencode/foo', 'v1'), null);
  assert.equal(cache.size, 0);
});

test('命中：set 之后能读回同样的判定', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'probe.json');
  const cache = new ProbeCache({ file });
  await cache.load();

  await cache.set('opencode/foo', 'v1', 'tool', '能按协议产生工具调用');

  const hit = cache.get('opencode/foo', 'v1');
  assert.ok(hit, '应该命中');
  assert.equal(hit.verdict, 'tool');
  assert.equal(hit.note, '能按协议产生工具调用');
  assert.ok(Number.isFinite(hit.checkedAt) && hit.checkedAt > 0);
  assert.equal(cache.size, 1);

  // 重新建一个实例 load()，证明结论真的落到磁盘上了
  const reloaded = new ProbeCache({ file });
  await reloaded.load();
  assert.equal(reloaded.get('opencode/foo', 'v1')?.verdict, 'tool');
});

test('指纹变化：旧结论立刻作废', async (t) => {
  const dir = await tempDir(t);
  const cache = new ProbeCache({ file: path.join(dir, 'probe.json') });
  await cache.load();
  await cache.set('opencode/foo', 'v1', 'tool', '能按协议产生工具调用');

  assert.equal(cache.get('opencode/foo', 'v2'), null, '指纹不同必须当没缓存');
  assert.equal(cache.get('opencode/foo', 'v1')?.verdict, 'tool', '原指纹仍然有效');
});

test('过期：tool 走 ttlMs，chat 走更短的 failureTtlMs', async (t) => {
  const dir = await tempDir(t);

  const success = new ProbeCache({ file: path.join(dir, 'probe2.json'), ttlMs: 60, failureTtlMs: 30 });
  await success.load();
  await success.set('opencode/a', 'v1', 'tool', '能按协议产生工具调用');
  assert.equal(success.get('opencode/a', 'v1')?.verdict, 'tool', '没过期应该命中');
  await sleep(80);
  assert.equal(success.get('opencode/a', 'v1'), null, '过了 ttlMs 应该失效');

  const failure = new ProbeCache({ file: path.join(dir, 'probe3.json'), ttlMs: 10_000, failureTtlMs: 30 });
  await failure.load();
  await failure.set('opencode/b', 'v1', 'chat', '只能普通对话，已关闭工具');
  assert.equal(failure.get('opencode/b', 'v1')?.verdict, 'chat', '没过期应该命中');
  await sleep(60);
  assert.equal(failure.get('opencode/b', 'v1'), null, 'chat 过 failureTtlMs 就该失效（好让模型有机会被重测）');
});

test('坏文件 / 缺文件：load 当空缓存，不抛错', async (t) => {
  const dir = await tempDir(t);

  const missing = new ProbeCache({ file: path.join(dir, '不存在', 'probe.json') });
  await missing.load();
  assert.equal(missing.size, 0);

  const broken = path.join(dir, 'broken.json');
  await writeFile(broken, '{ 这不是 JSON ,,,', 'utf8');
  const brokenCache = new ProbeCache({ file: broken });
  await brokenCache.load();
  assert.equal(brokenCache.size, 0);
  assert.equal(brokenCache.get('opencode/foo', 'v1'), null);

  // 版本对不上也当空缓存
  const wrongVersion = path.join(dir, 'v99.json');
  await writeFile(wrongVersion, JSON.stringify({ version: 99, entries: { 'opencode/foo': { fingerprint: 'v1', verdict: 'tool', checkedAt: Date.now(), note: 'x' } } }), 'utf8');
  const otherVersion = new ProbeCache({ file: wrongVersion });
  await otherVersion.load();
  assert.equal(otherVersion.size, 0, '结构版本不同必须整份丢弃');

  // 坏文件之后还能正常写入
  await brokenCache.set('opencode/foo', 'v1', 'tool', '能按协议产生工具调用');
  assert.equal(brokenCache.get('opencode/foo', 'v1')?.verdict, 'tool');
});

test('原子写：目录自动建、不留 .tmp、文件里带 version', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'nested', 'deep', 'probe.json');
  const cache = new ProbeCache({ file });
  await cache.load();
  await cache.set('opencode/foo', 'v1', 'tool', '能按协议产生工具调用');

  const raw = await readFile(file, 'utf8');
  const parsed = JSON.parse(raw); // 能被解析 = 没有写半截
  assert.equal(parsed.version, 1);
  assert.equal(parsed.entries['opencode/foo'].verdict, 'tool');

  const names = await readdir(path.join(dir, 'nested', 'deep'));
  assert.deepEqual(names.sort(), ['probe.json'], '.tmp 必须已经被 rename 掉，不能留在原地');
});

test('并发 set：多个模型同时写不会互相踩，内容全部完整', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'probe.json');
  const cache = new ProbeCache({ file });
  await cache.load();

  const ids = Array.from({ length: 12 }, (_, i) => `opencode/model-${i}`);
  await Promise.all([
    ...ids.map((id, i) => cache.set(id, 'v1', i % 3 === 0 ? 'chat' : 'tool', `第 ${i} 个`)),
    cache.clear().then(() => Promise.all(ids.slice(0, 6).map((id) => cache.set(id, 'v1', 'tool', 'clear 后重写')))),
  ]);

  const raw = await readFile(file, 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, 1);
  for (const id of ids.slice(0, 6)) {
    assert.equal(parsed.entries[id]?.verdict, 'tool', `${id} 应该在文件里`);
  }
  // 内存与磁盘不能脱节
  for (const id of ids.slice(0, 6)) {
    assert.equal(cache.get(id, 'v1')?.verdict, 'tool');
  }
  const leftovers = (await readdir(dir)).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], '不能留下 .tmp 文件');
});

test('clear 会同时清掉内存和磁盘内容', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'probe.json');
  const cache = new ProbeCache({ file });
  await cache.load();
  await cache.set('opencode/foo', 'v1', 'tool', '能按协议产生工具调用');
  await cache.clear();

  assert.equal(cache.size, 0);
  assert.equal(cache.get('opencode/foo', 'v1'), null);
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(parsed.entries, {});
});

test('toJSON 形状：自带 version 和 entries', async (t) => {
  const dir = await tempDir(t);
  const cache = new ProbeCache({ file: path.join(dir, 'probe.json') });
  await cache.load();
  await cache.set('opencode/foo', 'v1', 'chat', '只能普通对话，已关闭工具');

  const json = cache.toJSON();
  assert.equal(json.version, 1);
  assert.equal(json.entries['opencode/foo'].fingerprint, 'v1');
  assert.equal(json.entries['opencode/foo'].verdict, 'chat');
  assert.equal(json.entries['opencode/foo'].note, '只能普通对话，已关闭工具');
});

test('不传 file 时只放内存，不报错', async (t) => {
  const cache = new ProbeCache({});
  await cache.load();
  await cache.set('opencode/foo', 'v1', 'tool', '能按协议产生工具调用');
  assert.equal(cache.get('opencode/foo', 'v1')?.verdict, 'tool');
  await cache.clear();
  assert.equal(cache.size, 0);
});

test('文件路径指向目录时 load 不抛错', async (t) => {
  const dir = await tempDir(t);
  const asDir = path.join(dir, 'actually-a-dir');
  await mkdir(asDir, { recursive: true });
  const cache = new ProbeCache({ file: asDir });
  await cache.load();
  assert.equal(cache.size, 0);
});
