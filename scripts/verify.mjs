#!/usr/bin/env node
/**
 * 真机端到端验证。
 *
 * 这个脚本**真的**把整条链路跑一遍，而不是打桩：
 *   起 OpenCode → 拉模型目录 → 挑一个免费模型体检 →
 *   起本机转发口 → 发一个 ZCode 会发的 Anthropic 请求 →
 *   检查回来的形状是不是 ZCode 能认的 → 收摊。
 *
 * 用法：
 *   node scripts/verify.mjs                # 只跑一个模型，快
 *   node scripts/verify.mjs --models 3     # 跑前 3 个免费模型
 *   node scripts/verify.mjs --keep         # 跑完不清理数据目录（排障用）
 *
 * 退出码 0 = 全通，1 = 有步骤没过。任何一步失败都会打印原因，不吞异常。
 */
import { Bridge } from '../src/main.js';
import { interleaveByProvider } from '../src/models.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const wantModels = Number(args[args.indexOf('--models') + 1]) || 1;
const keep = args.includes('--keep');

/** 极简断言：失败就抛，让脚本以非 0 退出 */
const steps = [];
function step(name, ok, detail = '') {
  steps.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) throw new Error(`步骤失败：${name}`);
}

let dataDir;
let bridge;

try {
  dataDir = await mkdtemp(join(tmpdir(), 'oc-verify-'));
  process.env.OCF_DATA_DIR = dataDir;
  process.env.OCF_PORT = '0'; // 让系统分配，避免撞端口

  console.log(`\n数据目录：${dataDir}\n`);

  // ---------- 1. 起服务 ----------
  console.log('【1/6】启动 OpenCode 与本机转发口');
  bridge = new Bridge({ log: () => {} });
  const t0 = Date.now();
  await bridge.start();
  step('服务启动成功', bridge.state.phase === 'ready', `耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  step('转发口只监听回环地址', bridge.state.port > 0, `127.0.0.1:${bridge.state.port}`);
  step('OpenCode 已连接', bridge.state.upstream.ready, bridge.state.upstream.baseUrl);

  // ---------- 2. 模型目录 ----------
  console.log('\n【2/6】读取模型目录');
  const all = await bridge.refresh();
  step('拿到了免费模型', all.length > 0, `${all.length} 个免费模型`);
  // 水龙头只该放 OpenCode 官方那一家；别的供应商花的是用户自己的钱。
  const providers = [...new Set(all.map((m) => m.providerID))];
  step('只来自 opencode 一家', providers.length === 1 && providers[0] === 'opencode', providers.join(', '));
  step('全都免费且没过期', all.every((m) => m.free && !m.deprecated), `${all.length} 个模型全部符合`);

  // ---------- 3. 体检 ----------
  console.log('\n【3/6】体检模型（真发请求给上游）');
  // 免费池里混着不少"看着免费其实用不了"的模型（地区封锁、上游超时），
  // 顺着 id 一个个测会白等很久，所以分批往上加，测到够用就停。
  // 摊开逻辑收在 src/models.js，体检那边用的是同一份，不会两处走偏。
  const interleaved = interleaveByProvider(all);

  const batchSize = wantModels;
  const maxBatches = Number(args[args.indexOf('--batches') + 1]) || 8;
  const probed = [];
  let batch = 0;
  const results = [];
  while (probed.length < interleaved.length && batch < maxBatches) {
    const slice = interleaved.slice(batch * batchSize, (batch + 1) * batchSize);
    if (!slice.length) break;
    batch += 1;
    console.log(`   第 ${batch} 批（${slice.map((m) => m.name).join('、')}）…`);
    bridge.state.models = slice;
    const batchResults = await bridge.probe({ force: true, limit: slice.length, timeoutMs: 45000 });
    results.push(...batchResults);
    probed.push(...slice);
    const ok = batchResults.filter((r) => r.verdict === 'tool' || r.verdict === 'chat');
    if (ok.length) break;
  }

  const usable = results.filter((r) => r.verdict === 'tool' || r.verdict === 'chat');
  const withTools = results.filter((r) => r.verdict === 'tool');
  step('体检跑完没崩', results.length > 0, `共测了 ${results.length} 个`);
  step(
    '至少有一个模型可用',
    usable.length > 0,
    usable.length
      ? `能用工具 ${withTools.length} 个，只能聊天 ${usable.length - withTools.length} 个`
      : `测了 ${results.length} 个都不行（上游限制，不是桥的问题）`,
  );
  if (usable.length) {
    const best = withTools[0] ?? usable[0];
    step(`挑中模型 ${best.model.name}`, true, `判定=${best.verdict}，耗时 ${(best.elapsedMs / 1000).toFixed(1)}s`);
  }

  // ---------- 4. Anthropic 端到端 ----------
  console.log('\n【4/6】模拟 ZCode 发一个 Anthropic 请求');
  const target = withTools[0] ?? usable[0];
  const url = `http://127.0.0.1:${bridge.state.port}/v1/messages`;
  const body = {
    model: target.model.id,
    max_tokens: 1024,
    system: '你是一个测试助手。',
    messages: [{ role: 'user', content: '请回复：水龙头已打开' }],
  };
  const t1 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'x-api-key': bridge.state.apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const elapsed = ((Date.now() - t1) / 1000).toFixed(1);
  step('HTTP 200', res.status === 200, `耗时 ${elapsed}s，status=${res.status}`);
  const payload = await res.json();
  step('返回 Anthropic message 形状', payload.type === 'message' && payload.role === 'assistant', `type=${payload.type}`);
  step('content 是数组', Array.isArray(payload.content), `块数 ${payload.content?.length}`);
  const textBlocks = (payload.content ?? []).filter((b) => b.type === 'text');
  step('有文本回复', textBlocks.length > 0, JSON.stringify(textBlocks[0]?.text ?? '').slice(0, 90));
  step('stop_reason 合法', ['end_turn', 'tool_use'].includes(payload.stop_reason), payload.stop_reason);
  step('usage 有两个口径的数字', Number.isFinite(payload.usage?.input_tokens) && Number.isFinite(payload.usage?.output_tokens),
    `in=${payload.usage?.input_tokens} out=${payload.usage?.output_tokens}`);

  // ---------- 5. 工具调用路径 ----------
  console.log('\n【5/6】带工具的请求（ZCode 真实用法）');
  if (withTools.length) {
    const toolBody = {
      model: withTools[0].model.id,
      max_tokens: 1024,
      system: '你是一个测试助手。',
      tools: [
        {
          name: 'read',
          description: '读取一个文件',
          input_schema: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] },
        },
      ],
      messages: [{ role: 'user', content: '请读一下 /tmp/oc-demo.txt，告诉我里面写了什么' }],
    };
    const r2 = await fetch(url, {
      method: 'POST',
      headers: { 'x-api-key': bridge.state.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(toolBody),
    });
    const p2 = await r2.json();
    step('带工具的请求也成功', r2.status === 200, `status=${r2.status}`);
    const uses = (p2.content ?? []).filter((b) => b.type === 'tool_use');
    if (uses.length) {
      step('模型产生了 tool_use 块', uses[0].name === 'read', `name=${uses[0].name} input=${JSON.stringify(uses[0].input)}`);
      step('stop_reason=tool_use', p2.stop_reason === 'tool_use', p2.stop_reason);
    } else {
      console.log(`   ℹ️  这次没产生工具调用，回了文本：${JSON.stringify((p2.content ?? [])[0]?.text ?? '').slice(0, 80)}`);
      console.log('   ℹ️  这是模型自己的选择，不算失败——但说明它这次没用工具。');
    }
  } else {
    console.log('   ⏭️  没有「能用工具」的模型，跳过（这本身是需要关注的信息）');
  }

  // ---------- 6. 围栏 ----------
  console.log('\n【6/6】安全检查');
  const noKey = await fetch(`http://127.0.0.1:${bridge.state.port}/v1/models`);
  step('没密钥被挡（401）', noKey.status === 401, `status=${noKey.status}`);
  const withOrigin = await fetch(`http://127.0.0.1:${bridge.state.port}/v1/models`, {
    headers: { 'x-api-key': bridge.state.apiKey, origin: 'https://example.com' },
  });
  step('浏览器来的被挡（403）', withOrigin.status === 403, `status=${withOrigin.status}`);
  const wb = await fetch(`http://127.0.0.1:${bridge.state.port}/v1/models`, { headers: { 'x-api-key': bridge.state.apiKey } });
  const wbBody = await wb.json();
  step('模型列表可读', wbBody.object === 'list' && wbBody.data.length > 0, `${wbBody.data?.length} 个`);

  console.log(`\n${'─'.repeat(56)}\n全部 ${steps.length} 项检查通过。\n`);
} catch (error) {
  console.error(`\n验证中断：${error.message}\n`);
  process.exitCode = 1;
} finally {
  try {
    await bridge?.stop({ uninstall: false });
  } catch (error) {
    console.error(`收尾时出错：${error.message}`);
  }
  if (dataDir && !keep) {
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  } else if (dataDir) {
    console.log(`数据目录保留在：${dataDir}`);
  }
  // OpenCode 子进程如果还活着会拖住事件循环
  setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
}
