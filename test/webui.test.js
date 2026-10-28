/**
 * Web 控制面板的测试。
 *
 * 重点不是"页面能不能打开"，而是**安全边界**：这个面板能改接入工具的配置，
 * 一旦没令牌的本地网页也能调它，就等于谁都能改。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startWebUi } from '../src/webui.js';

/** 造一份最小的界面资源 */
function makeAssets() {
  const dir = mkdtempSync(join(tmpdir(), 'oc-web-assets-'));
  writeFileSync(
    join(dir, 'index.html'),
    '<!doctype html><html><body><div id="app"></div><script src="renderer.js"></script></body></html>',
  );
  writeFileSync(join(dir, 'style.css'), 'body{color:#000}');
  writeFileSync(join(dir, 'renderer.js'), '/* ui */');
  const webDir = mkdtempSync(join(tmpdir(), 'oc-web-client-'));
  const webClientFile = join(webDir, 'web-client.js');
  writeFileSync(webClientFile, '/* web client */');
  return { assetsDir: dir, webClientFile };
}

/** 一个够用的假桥：方法都在，返回固定值，调用次数记下来 */
function fakeBridge({ logFile } = {}) {
  const calls = [];
  const state = { models: [], phase: 'ready', port: 41982, progress: null };
  return {
    calls,
    snapshot: () => ({ ...state }),
    refresh: async () => {
      calls.push('refresh');
      state.models = [{ id: 'opencode/a' }, { id: 'opencode/b' }];
      return state.models;
    },
    probe: async ({ force } = {}) => {
      calls.push(`probe:${force}`);
      return [
        { model: { id: 'opencode/a' }, verdict: 'tool' },
        { model: { id: 'opencode/b' }, verdict: 'failed' },
      ];
    },
    probeOne: async (id) => {
      calls.push(`probeOne:${id}`);
      return id === 'opencode/a' ? { id, verdict: 'tool' } : null;
    },
    import: async () => {
      calls.push('import');
      return { added: 2, changed: true, disabledBuiltins: 5 };
    },
    uninstall: async () => {
      calls.push('uninstall');
      return { removed: 2, changed: true };
    },
    installTarget: async (id, options) => {
      calls.push(`installTarget:${id}:${JSON.stringify(options?.modelIds ?? null)}`);
      if (id === 'nope') {
        const error = new Error(`没有叫「${id}」的接入目标。`);
        error.status = 404;
        error.code = 'target_not_found';
        throw error;
      }
      return { added: 3, skipped: 1, changed: true };
    },
    uninstallTarget: async (id) => {
      calls.push(`uninstallTarget:${id}`);
      return { removed: 3, changed: true };
    },
    setModelContextWindow: async (id, value) => {
      calls.push(`setModelContextWindow:${id}:${value}`);
      return { ok: true };
    },
    // 实读各目标状态：记录调用，并把「最新读到的」写进快照缓存
    listTargetStates: async () => {
      calls.push('listTargetStates');
      state.targets = [{ id: 'zcode', label: 'ZCode', detected: true, written: true, models: ['opencode/a'] }];
      return state.targets;
    },
    restart: async () => {
      calls.push('restart');
      return { ...state, phase: 'ready' };
    },
    readSettings: async () => ({ probeConcurrency: 3, probeTtlMinutes: 360 }),
    saveSettings: async (patch) => {
      calls.push(`save:${JSON.stringify(patch)}`);
      return { probeConcurrency: 3, probeTtlMinutes: 360, ...patch };
    },
    setUpstreamMode: async (mode) => {
      calls.push(`setUpstreamMode:${mode}`);
      if (mode !== 'embedded' && mode !== 'masquerade') {
        const error = new Error(`没有叫「${mode}」的上游方案。`);
        error.status = 400;
        error.code = 'invalid_upstream_mode';
        throw error;
      }
      return { ok: true, mode, changed: true };
    },
    setLanAccess: async (enabled) => {
      calls.push(`setLanAccess:${enabled}`);
      if (typeof enabled !== 'boolean') {
        const error = new Error('路由器广播开关只接受 true / false');
        error.status = 500;
        throw error;
      }
      return { ok: true, lanAccess: enabled, changed: true };
    },
    lanInfo: async () => {
      calls.push('lanInfo');
      return {
        lanAccess: true,
        port: 41982,
        addresses: [{ address: '192.168.1.8', cidr: '192.168.1.8/24', url: 'http://192.168.1.8:41982' }],
        apiKey: 'oc-panel-key',
        modelIds: ['opencode/a'],
      };
    },
    getApiKey: async () => {
      calls.push('getApiKey');
      return 'oc-panel-key';
    },
    setApiKey: async (key) => {
      calls.push(`setApiKey:${key}`);
      if (typeof key !== 'string' || !key.trim()) {
        const error = new Error('新密钥没法保存：去掉首尾空格之后什么都不剩了。');
        error.status = 400;
        error.code = 'invalid_api_key';
        throw error;
      }
      return { ok: true };
    },
    zcodeConfigPath: () => '/tmp/zcode/provider_config.json',
    requestsLogPath: () => logFile ?? '/tmp/zcode/requests.jsonl',
    workdir: () => '/tmp/oz/workspace',
  };
}

async function withPanel(t, { bridge, onRestart, onStop } = {}) {
  const { assetsDir, webClientFile } = makeAssets();
  const b = bridge ?? fakeBridge();
  const ui = await startWebUi({ bridge: b, port: 0, assetsDir, webClientFile, onRestart, onStop });
  t.after(async () => {
    await ui.close();
  });
  return { ui, bridge: b };
}

/** 带令牌请求 */
function call(ui, path, { method = 'GET', body, headers = {} } = {}) {
  return fetch(`http://127.0.0.1:${ui.port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-oc-token': ui.token, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/* ---------------- 安全边界 ---------------- */

test('没令牌的请求一律 401（本地网页不能偷偷调它）', async (t) => {
  const { ui } = await withPanel(t);
  for (const [method, path] of [
    ['GET', '/api/state'],
    ['POST', '/api/import'],
    ['POST', '/api/uninstall'],
    ['POST', '/api/restart'],
    ['POST', '/api/stop'],
    ['GET', '/api/settings'],
    ['GET', '/api/key'],
    ['POST', '/api/key'],
    ['POST', '/api/targets/install'],
    ['POST', '/api/targets/uninstall'],
    ['POST', '/api/models/context-window'],
  ]) {
    const res = await fetch(`http://127.0.0.1:${ui.port}${path}`, { method });
    assert.equal(res.status, 401, `${method} ${path} 应当 401`);
  }
});

test('令牌不对也是 401', async (t) => {
  const { ui } = await withPanel(t);
  // 注意：HTTP 头只能是 ASCII，真实令牌是 base64url 所以没问题；
  // 这里用一个明显不同的 ASCII 串来验"值不对也挡"。
  const res = await fetch(`http://127.0.0.1:${ui.port}/api/state`, {
    headers: { 'x-oc-token': 'wrong-token-0123456789' },
  });
  assert.equal(res.status, 401);
});

test('跨站 Origin 一律 403（哪怕令牌对）', async (t) => {
  const { ui } = await withPanel(t);
  for (const [origin, path, method, body] of [
    ['https://evil.example', '/api/state', 'GET'],
    ['http://192.168.1.5:8080', '/api/models/context-window', 'POST', { id: 'opencode/a', value: 1_000_000 }],
  ]) {
    const res = await call(ui, path, { method, body, headers: { origin } });
    assert.equal(res.status, 403, `Origin=${origin} 应当 403`);
  }
});

test('本机 Origin 放行', async (t) => {
  const { ui } = await withPanel(t);
  const res = await call(ui, '/api/state', { headers: { origin: `http://127.0.0.1:${ui.port}` } });
  assert.equal(res.status, 200);
});

test('面板里没有能执行任意命令的接口', async (t) => {
  const { ui } = await withPanel(t);
  for (const path of ['/api/exec', '/api/shell', '/api/run', '/api/eval']) {
    const res = await call(ui, path, { method: 'POST', body: { cmd: 'rm -rf /' } });
    assert.equal(res.status, 404, `${path} 不该存在`);
  }
});

/* ---------------- 页面与静态资源 ---------------- */

test('首页能打开，并且先装了 web 客户端再跑 renderer', async (t) => {
  const { ui } = await withPanel(t);
  const res = await call(ui, `/?t=${ui.token}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /web-client\.js/);
  const clientAt = html.indexOf('web-client.js');
  const rendererAt = html.indexOf('renderer.js');
  assert.ok(clientAt >= 0 && clientAt < rendererAt, 'web-client.js 必须在 renderer.js 之前');
});

test('静态资源不带令牌也要能拿到（浏览器子资源带不了令牌）', async (t) => {
  const { ui } = await withPanel(t);
  // 真实浏览器加载 /style.css、/renderer.js 时既没有 ?t= 也带不上自定义头。
  // 之前把它们和 API 一起卡在令牌后面，结果就是页面裸奔、脚本没加载、状态永远停在"准备中"。
  for (const path of ['/style.css', '/renderer.js', '/web-client.js']) {
    const res = await fetch(`http://127.0.0.1:${ui.port}${path}`);
    assert.equal(res.status, 200, `${path} 不该要令牌`);
  }
  // 但动作接口仍然必须带令牌
  const api = await fetch(`http://127.0.0.1:${ui.port}/api/import`, { method: 'POST' });
  assert.equal(api.status, 401, '能动配置的接口绝不能裸奔');
});

test('静态资源只有白名单里的几个，别的一概 404', async (t) => {
  const { ui } = await withPanel(t);
  for (const path of ['/style.css', '/renderer.js', '/web-client.js']) {
    const res = await call(ui, path);
    assert.equal(res.status, 200, `${path} 应当能拿到`);
  }
  // 路径穿越和各种敏感文件必须是 404
  for (const path of ['/../package.json', '/../../etc/passwd', '/webui.js', '/src/main.js']) {
    const res = await call(ui, path);
    assert.equal(res.status, 404, `${path} 不该被发出去`);
  }
});

/* ---------------- 功能接口 ---------------- */

test('GET /api/state 返回快照', async (t) => {
  const { ui } = await withPanel(t);
  const res = await call(ui, '/api/state');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).phase, 'ready');
});

test('GET /api/state 先实读各目标状态再返回快照（面板 1.5s 轮询不能拿旧缓存）', async (t) => {
  const { ui, bridge } = await withPanel(t);
  const res = await call(ui, '/api/state');
  assert.equal(res.status, 200);
  assert.ok(bridge.calls.includes('listTargetStates'), '拿快照前必须先实读一遍各目标状态');
  const body = await res.json();
  assert.deepEqual(
    body.targets,
    [{ id: 'zcode', label: 'ZCode', detected: true, written: true, models: ['opencode/a'] }],
    '返回的 targets 必须是这次实读的结果，不是旧缓存',
  );
});

test('POST /api/refresh 返回模型数量', async (t) => {
  const { ui, bridge } = await withPanel(t);
  const res = await call(ui, '/api/refresh', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).models, 2);
  assert.deepEqual(bridge.calls, ['refresh']);
});

test('POST /api/probe 汇总各类判定数', async (t) => {
  const { ui } = await withPanel(t);
  const res = await call(ui, '/api/probe', { method: 'POST', body: { force: true } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.summary, { tool: 1, chat: 0, failed: 1 });
  assert.equal(body.total, 2);
});

test('POST /api/probe-one 找不到模型时明确报错', async (t) => {
  const { ui } = await withPanel(t);
  const missing = await call(ui, '/api/probe-one', { method: 'POST', body: { id: 'opencode/不存在' } });
  assert.equal(missing.status, 500);
  assert.match((await missing.json()).error, /不在当前清单里/);

  const noId = await call(ui, '/api/probe-one', { method: 'POST', body: {} });
  assert.equal(noId.status, 500);
});

test('POST /api/import 与 /api/uninstall 透传结果', async (t) => {
  const { ui } = await withPanel(t);
  const imported = await (await call(ui, '/api/import', { method: 'POST' })).json();
  assert.equal(imported.added, 2);
  assert.equal(imported.disabledBuiltins, 5);

  const removed = await (await call(ui, '/api/uninstall', { method: 'POST' })).json();
  assert.equal(removed.removed, 2);
});

/* ---------------- 目标写入/摘除接口（工单 06） ---------------- */

test('POST /api/targets/install 按 body.id 委托桥的 installTarget 并透传结果', async (t) => {
  const { ui, bridge } = await withPanel(t);
  const res = await call(ui, '/api/targets/install', { method: 'POST', body: { id: 'dsh' } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.added, 3);
  assert.equal(body.skipped, 1, '有模型 id 撞了用户手写条目而让位时，个数要如实回给界面');
  assert.deepEqual(bridge.calls, ['installTarget:dsh:null']);
});

test('POST /api/targets/install 把勾选的模型清单透传给桥', async (t) => {
  const { ui, bridge } = await withPanel(t);
  const res = await call(ui, '/api/targets/install', { method: 'POST', body: { id: 'codex', modelIds: ['opencode/a', 'opencode/b'] } });
  assert.equal(res.status, 200);
  assert.deepEqual(bridge.calls, ['installTarget:codex:["opencode/a","opencode/b"]']);
});

test('POST /api/targets/uninstall 按 body.id 委托桥的 uninstallTarget 并透传结果', async (t) => {
  const { ui, bridge } = await withPanel(t);
  const res = await call(ui, '/api/targets/uninstall', { method: 'POST', body: { id: 'zcode' } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).removed, 3);
  assert.deepEqual(bridge.calls, ['uninstallTarget:zcode']);
});

test('目标接口缺 id 时按人话报错，不闷头乱写', async (t) => {
  const { ui, bridge } = await withPanel(t);
  for (const path of ['/api/targets/install', '/api/targets/uninstall']) {
    const res = await call(ui, path, { method: 'POST', body: {} });
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /缺少目标 id/);
  }
  assert.deepEqual(bridge.calls, [], '缺 id 不该碰到桥');
});

test('目标 id 不认识时透传桥的 404 与错误码', async (t) => {
  const { ui } = await withPanel(t);
  const res = await call(ui, '/api/targets/install', { method: 'POST', body: { id: 'nope' } });
  assert.equal(res.status, 404, '桥给的 404 状态码要透传');
  const body = await res.json();
  assert.match(body.error, /没有叫/);
  assert.equal(body.code, 'target_not_found');
});

test('POST /api/models/context-window 把模型 id 和 token 数原样交给桥，null 表示恢复默认', async (t) => {
  const { ui, bridge } = await withPanel(t);

  const saved = await call(ui, '/api/models/context-window', {
    method: 'POST',
    body: { id: 'opencode/a', value: 1_000_000 },
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { ok: true });

  const restored = await call(ui, '/api/models/context-window', {
    method: 'POST',
    body: { id: 'opencode/a', value: null },
  });
  assert.equal(restored.status, 200);
  assert.deepEqual(bridge.calls, [
    'setModelContextWindow:opencode/a:1000000',
    'setModelContextWindow:opencode/a:null',
  ]);
});

test('上下文窗口接口缺少模型 id 时不调用桥', async (t) => {
  const { ui, bridge } = await withPanel(t);
  const res = await call(ui, '/api/models/context-window', { method: 'POST', body: { value: 200_000 } });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /缺少模型 id/);
  assert.equal(body.code, 'missing_model_id');
  assert.deepEqual(bridge.calls, []);
});

test('POST /api/restart 回调宿主重启，并把新快照回给界面', async (t) => {
  let restarted = 0;
  const { ui } = await withPanel(t, {
    onRestart: async () => {
      restarted += 1;
      return { phase: 'ready', port: 41990, models: [] };
    },
  });
  const res = await call(ui, '/api/restart', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(restarted, 1);
  assert.equal((await res.json()).port, 41990);
});

test('POST /api/stop 先回响应再收摊，别让浏览器只看到连接被掐', async (t) => {
  let stopped = false;
  const { ui } = await withPanel(t, {
    onStop: async () => {
      stopped = true;
    },
  });
  const res = await call(ui, '/api/stop', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { stopping: true });
  assert.equal(stopped, false, '响应还没发出去就不该开始收摊');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(stopped, true, '响应发出去之后应当收摊');
});

test('壳子不支持重启/关闭时明确报错，而不是假装成功', async (t) => {
  const { ui } = await withPanel(t);
  const restartRes = await call(ui, '/api/restart', { method: 'POST' });
  assert.equal(restartRes.status, 500);
  assert.match((await restartRes.json()).error, /不支持重启/);

  const stopRes = await call(ui, '/api/stop', { method: 'POST' });
  assert.equal(stopRes.status, 500);
  assert.match((await stopRes.json()).error, /不支持关闭/);
});

test('设置读写只放行认识的字段', async (t) => {
  const { ui, bridge } = await withPanel(t);
  await call(ui, '/api/settings', {
    method: 'POST',
    body: { probeConcurrency: 4, 想偷偷改的字段: 'x', port: 1 },
  });
  assert.equal(bridge.calls.length, 1);
  assert.deepEqual(JSON.parse(bridge.calls[0].slice('save:'.length)), { probeConcurrency: 4 });
});

test('GET /api/log 返回最后 N 行，读不到文件也不炸', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-log-'));
  const logFile = join(dir, 'requests.jsonl');
  writeFileSync(logFile, `${Array.from({ length: 80 }, (_, i) => `{"i":${i}}`).join('\n')}\n`);

  const { ui } = await withPanel(t, { bridge: fakeBridge({ logFile }) });
  const res = await call(ui, '/api/log?lines=5');
  assert.equal(res.status, 200);
  const { lines } = await res.json();
  assert.equal(lines.length, 5);
  assert.equal(lines.at(-1), '{"i":79}');

  // 文件不存在时给空数组，不是 500
  const missing = await withPanel(t, { bridge: fakeBridge({ logFile: join(dir, 'nope.jsonl') }) });
  const missingRes = await call(missing.ui, '/api/log');
  assert.equal(missingRes.status, 200);
  assert.deepEqual((await missingRes.json()).lines, []);
});

/* ---------------- 密钥接口 ---------------- */

test('GET /api/key 返回当前密钥', async (t) => {
  const { ui, bridge } = await withPanel(t);
  const res = await call(ui, '/api/key');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).key, 'oc-panel-key');
  assert.deepEqual(bridge.calls, ['getApiKey']);
});

test('POST /api/key 保存新密钥并回报成功', async (t) => {
  const { ui, bridge } = await withPanel(t);
  const res = await call(ui, '/api/key', { method: 'POST', body: { key: 'oc-new-key' } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.deepEqual(bridge.calls, ['setApiKey:oc-new-key']);
});

test('POST /api/key 空密钥 → 400，错误是说人话的中文', async (t) => {
  const { ui } = await withPanel(t);
  const res = await call(ui, '/api/key', { method: 'POST', body: { key: '   ' } });
  assert.equal(res.status, 400, '校验失败要按桥给的状态码透传');
  const body = await res.json();
  assert.match(body.error, /空/);
  assert.equal(body.code, 'invalid_api_key');
});

test('请求体不是 JSON 时给 500 且说人话', async (t) => {
  const { ui } = await withPanel(t);
  const res = await fetch(`http://127.0.0.1:${ui.port}/api/probe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-oc-token': ui.token },
    body: '{这不是 JSON',
  });
  assert.equal(res.status, 500);
});

test('桥抛的错原样转给界面，不吞掉', async (t) => {
  const bridge = fakeBridge();
  bridge.import = async () => {
    const error = new Error('ZCode 配置文件读不了');
    error.status = 409;
    error.code = 'bad_config';
    throw error;
  };
  const { ui } = await withPanel(t, { bridge });
  const res = await call(ui, '/api/import', { method: 'POST' });
  assert.equal(res.status, 409, '桥给的状态码要透传');
  const body = await res.json();
  assert.match(body.error, /配置文件读不了/);
  assert.equal(body.code, 'bad_config');
});

/* ---------------- 方案切换接口 ---------------- */

test('POST /api/upstream-mode 切换方案，结果原样回报', async (t) => {
  const { ui, bridge } = await withPanel(t);
  const res = await call(ui, '/api/upstream-mode', { method: 'POST', body: { mode: 'masquerade' } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, mode: 'masquerade', changed: true });
  assert.equal(bridge.calls.at(-1), 'setUpstreamMode:masquerade');
});

test('POST /api/upstream-mode 缺 mode → 500 且说人话；方案非法由桥挡下', async (t) => {
  const { ui, bridge } = await withPanel(t);
  const missing = await call(ui, '/api/upstream-mode', { method: 'POST', body: {} });
  assert.equal(missing.status, 500);
  assert.match((await missing.json()).error, /缺少方案名/);
  assert.equal(bridge.calls.length, 0, '缺参数不该到桥那一层');

  const bad = await call(ui, '/api/upstream-mode', { method: 'POST', body: { mode: '随便' } });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /没有叫/);
});

/* ---------------- 路由器广播接口 ---------------- */

test('POST /api/lan-access 切换广播，GET /api/lan-info 回接入信息', async (t) => {
  const { ui, bridge } = await withPanel(t);
  const on = await call(ui, '/api/lan-access', { method: 'POST', body: { enabled: true } });
  assert.equal(on.status, 200);
  assert.deepEqual(await on.json(), { ok: true, lanAccess: true, changed: true });
  assert.equal(bridge.calls.at(-1), 'setLanAccess:true');

  const bad = await call(ui, '/api/lan-access', { method: 'POST', body: { enabled: 'yes' } });
  assert.equal(bad.status, 500);
  assert.match((await bad.json()).error, /true \/ false/);

  const info = await call(ui, '/api/lan-info');
  assert.equal(info.status, 200);
  const body = await info.json();
  assert.equal(body.apiKey, 'oc-panel-key', '接入信息带密钥（仅面板通道）');
  assert.equal(body.addresses[0].url, 'http://192.168.1.8:41982');
  assert.deepEqual(body.modelIds, ['opencode/a']);
});
