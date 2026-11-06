/** 模型体检互斥与对话并发：只用假客户端和临时工作目录。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Bridge } from '../src/main.js';

const MODEL_A = { id: 'opencode/a', providerID: 'opencode', modelID: 'a', name: '模型 A', free: true };
const MODEL_B = { id: 'opencode/b', providerID: 'opencode', modelID: 'b', name: '模型 B', free: true };
const REPLY = '{"content":"完成","calls":[]}';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'oc-probe-concurrency-'));
  const saved = process.env.OCF_DATA_DIR;
  process.env.OCF_DATA_DIR = dir;
  await mkdir(join(dir, 'workspace'), { recursive: true });

  const client = {
    promptCalls: [],
    active: 0,
    maxActive: 0,
    firstRelease: null,
    async createSession() { return `ses_${Math.random().toString(16).slice(2)}`; },
    prompt(options) {
      this.active += 1;
      this.maxActive = Math.max(this.maxActive, this.active);
      const call = { options };
      this.promptCalls.push(call);
      return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          this.active -= 1;
          resolve({ text: REPLY, tokens: null, handoff: null });
        };
        if (this.promptCalls.length === 1) this.firstRelease = finish;
        else setTimeout(finish, 20);
      });
    },
    async deleteSession() {},
    releaseFirst() { this.firstRelease?.(); },
  };
  const bridge = new Bridge({ log: () => {}, targets: [] });
  bridge.client = client;
  bridge.state.phase = 'ready';
  bridge.state.models = [MODEL_A, MODEL_B];
  bridge.state.verdicts.set(MODEL_A.id, { verdict: 'tool', note: '' });
  bridge.state.verdicts.set(MODEL_B.id, { verdict: 'tool', note: '' });
  t.after(async () => {
    client.releaseFirst();
    await bridge.stop({ uninstall: false }).catch(() => {});
    if (saved === undefined) delete process.env.OCF_DATA_DIR;
    else process.env.OCF_DATA_DIR = saved;
    await rm(dir, { recursive: true, force: true });
  });
  return { bridge, client };
}

async function waitForCalls(client, count) {
  const deadline = Date.now() + 2_000;
  while (client.promptCalls.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.ok(client.promptCalls.length >= count, `应进入第 ${count} 次上游调用`);
}

test('全量检测运行中拒绝任意单条重测', async (t) => {
  const { bridge, client } = await fixture(t);
  const all = bridge.probe({ limit: 1 });
  await waitForCalls(client, 1);
  const single = await bridge.probeOne(MODEL_A.id).then((value) => ({ value }), (error) => ({ error }));
  const callsDuringConflict = client.promptCalls.length;
  client.releaseFirst();
  await all;

  assert.equal(single.error?.code, 'probe_busy');
  assert.equal(callsDuringConflict, 1, '冲突的单条重测不得发起上游请求');
});

test('单条重测运行中拒绝全量检测和同模型重复重测', async (t) => {
  const { bridge, client } = await fixture(t);
  const first = bridge.probeOne(MODEL_A.id);
  await waitForCalls(client, 1);
  const duplicate = await bridge.probeOne(MODEL_A.id).then((value) => ({ value }), (error) => ({ error }));
  const all = await bridge.probe().then((value) => ({ value }), (error) => ({ error }));
  const callsDuringConflict = client.promptCalls.length;
  client.releaseFirst();
  await first;

  assert.equal(duplicate.error?.code, 'probe_busy');
  assert.equal(all.error?.code, 'probe_busy');
  assert.equal(callsDuringConflict, 1, '冲突的检测不得发起额外上游请求');
});

test('不同模型的单条重测可以并行', async (t) => {
  const { bridge, client } = await fixture(t);
  const first = bridge.probeOne(MODEL_A.id);
  await waitForCalls(client, 1);
  const second = bridge.probeOne(MODEL_B.id);
  await waitForCalls(client, 2);
  const activeAtOverlap = client.maxActive;
  client.releaseFirst();
  await Promise.all([first, second]);

  assert.equal(activeAtOverlap, 2, '两个不同模型应同时进入体检请求');
});

test('检测锁在等待上下文修改失败后释放', async (t) => {
  const { bridge, client } = await fixture(t);
  let rejectChange;
  bridge.contextWindowChangeInFlight = true;
  bridge.contextWindowChangePromise = new Promise((_, reject) => { rejectChange = reject; });
  const all = bridge.probe().then((value) => ({ value }), (error) => ({ error }));
  const competing = bridge.probeOne(MODEL_A.id).then((value) => ({ value }), (error) => ({ error }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  bridge.contextWindowChangeInFlight = false;
  bridge.contextWindowChangePromise = null;
  rejectChange(new Error('上下文保存失败'));
  const [allResult, competingResult] = await Promise.all([all, competing]);

  assert.match(allResult.error?.message ?? '', /上下文保存失败/);
  assert.equal(competingResult.error?.code, 'probe_busy');

  const retry = bridge.probeOne(MODEL_A.id);
  await waitForCalls(client, 1);
  client.releaseFirst();
  await retry;
});

test('全量检测期间正常对话仍可使用上游', async (t) => {
  const { bridge, client } = await fixture(t);
  let allSettled = false;
  const all = bridge.probe().finally(() => { allSettled = true; });
  await waitForCalls(client, 1);

  const response = await bridge.complete({
    protocol: 'openai',
    body: { model: MODEL_A.id, messages: [{ role: 'user', content: '你好' }] },
  });
  assert.equal(response.decoded.content, '完成');
  assert.equal(allSettled, false, '对话应在检测继续等待时就能完成');
  client.releaseFirst();
  await all;
});
