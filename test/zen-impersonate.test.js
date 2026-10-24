/**
 * zen-impersonate.js 的测试：id 生成、会话注册表、伪装头——全部纯函数离线跑。
 * 口径逐条对着 Magpie 的实现（/tmp/magpie/internal/provider/opencode_client.go）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OPENCODE_ANONYMOUS_KEY,
  OPENCODE_ID_PATTERN,
  OPENCODE_TOOL_DESCRIPTIONS,
  OPENCODE_USER_AGENT,
  authHeaders,
  createSessionRegistry,
  impersonationHeaders,
  isOpenCodeSessionID,
  openCodeNewID,
  stubTools,
} from '../src/zen-impersonate.js';

/* ------------------------------------------------------------------ */
/* id 生成                                                              */
/* ------------------------------------------------------------------ */

test('openCodeNewID：形状逐项对上（前缀 + 12 位十六进制 + 14 位 base62）', () => {
  for (const prefix of ['ses', 'msg']) {
    const id = openCodeNewID(prefix);
    assert.ok(id.startsWith(`${prefix}_`), '前缀要对');
    assert.match(id, OPENCODE_ID_PATTERN, '整体形状要过 OpenCode 版式的正则');
    assert.equal([...id].length, prefix.length + 1 + 12 + 14, '总长度固定');
  }
});

test('openCodeNewID：同一毫秒内的多个 id 互不相同（低位计数器）', () => {
  const now = Date.now();
  const ids = new Set(Array.from({ length: 20 }, () => openCodeNewID('msg', { now })));
  assert.equal(ids.size, 20, '同一毫秒里生成的 id 必须个个不同');
});

test('openCodeNewID：会话 id（descending）通过 zen 的「低位计数必须很小」校验', () => {
  // 注入一个独立时刻：同一毫秒内造了 15 个以上 id 后，低位计数会超出 zen 的
  // 「可信计数」窗口——这是 OpenCode 算法本身的性质（实际业务每毫秒只造两三个
  // id，触发不了），测试里别让前面的用例污染这个用例的计数器。
  const session = openCodeNewID('ses', { descending: true, now: Date.now() + 1234 });
  assert.ok(isOpenCodeSessionID(session), '自己造的会话 id 得被自己的校验认');
  const turn = openCodeNewID('msg', { now: Date.now() + 1235 });
  assert.equal(isOpenCodeSessionID(turn), false, '回合 id 不是会话 id');
});

test('isOpenCodeSessionID：形状对但时间位乱造的过不了（zen 实测会 403 的那种）', () => {
  // ses_ + 全 f 的十二位（取反后计数位巨大）+ 合法 base62 尾巴
  assert.equal(isOpenCodeSessionID('ses_000000ffffffABCDEFGHJKLM'), false);
  assert.equal(isOpenCodeSessionID('msg_abcdef123456ABCDEFGHJKLM'), false, '前缀不对');
  assert.equal(isOpenCodeSessionID('ses_abcdef123456AB!DEFGHJKLMN'), false, '尾巴有非 base62 字符');
  assert.equal(isOpenCodeSessionID(''), false);
  assert.equal(isOpenCodeSessionID(null), false);
});

/* ------------------------------------------------------------------ */
/* 会话注册表                                                            */
/* ------------------------------------------------------------------ */

test('会话注册表：同一 seed 复用同一个 id，不同 seed 各拿各的', () => {
  const registry = createSessionRegistry();
  const a1 = registry.forSeed('conversation-a');
  const a2 = registry.forSeed('conversation-a');
  const b = registry.forSeed('conversation-b');
  assert.equal(a1, a2, '同一会话的每一回合都要复用同一个 ses_ id（zen 按它路由和缓存）');
  assert.notEqual(a1, b, '两个会话绝不共用一个 id');
  assert.ok(isOpenCodeSessionID(a1));
  assert.ok(isOpenCodeSessionID(b));
});

test('会话注册表：seed 本身是合法会话 id 时原样使用', () => {
  const registry = createSessionRegistry();
  const real = openCodeNewID('ses', { descending: true });
  assert.equal(registry.forSeed(real), real);
});

test('会话注册表：LRU 逐出最久没用的，容量可配', () => {
  const registry = createSessionRegistry({ keep: 3 });
  const first = registry.forSeed('a');
  registry.forSeed('b');
  registry.forSeed('c');
  registry.forSeed('a'); // 触一下 a，把 b 挤成最老的
  registry.forSeed('d');
  assert.equal(registry.size, 3, '超过容量要逐出');
  assert.equal(registry.forSeed('a'), first, '刚用过的不能被逐出');
  const bAgain = registry.forSeed('b');
  assert.notEqual(bAgain, '占位', '');
  assert.ok(isOpenCodeSessionID(bAgain), '被逐出后的 seed 再来要拿新 id');
});

/* ------------------------------------------------------------------ */
/* 伪装头                                                               */
/* ------------------------------------------------------------------ */

test('impersonationHeaders：全套门禁头都在，affinity 头一个都没有', () => {
  const session = openCodeNewID('ses', { descending: true });
  const headers = impersonationHeaders(session);
  assert.equal(headers['user-agent'], OPENCODE_USER_AGENT);
  assert.equal(headers['x-opencode-session'], session);
  assert.equal(headers['x-opencode-session-id'], session);
  assert.match(headers['x-opencode-request'], /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.equal(headers['x-opencode-client'], 'cli');
  assert.equal(headers['x-opencode-project'], 'global');
  // 带了这两个会被免费池 403——必须一个都不出现（任何大小写写法）
  for (const key of Object.keys(headers)) {
    assert.ok(!/session-affinity/i.test(key), `不许出现 ${key}`);
    assert.ok(!/^x-session-id$/i.test(key), `不许出现 ${key}`);
  }
});

test('impersonationHeaders：每次调用都换新的 x-opencode-request', () => {
  const session = openCodeNewID('ses', { descending: true });
  const a = impersonationHeaders(session);
  const b = impersonationHeaders(session);
  assert.equal(a['x-opencode-session'], b['x-opencode-session'], '会话 id 不变');
  assert.notEqual(a['x-opencode-request'], b['x-opencode-request'], '回合 id 必须次次新');
});

/* ------------------------------------------------------------------ */
/* 认证头与桩工具                                                        */
/* ------------------------------------------------------------------ */

test('authHeaders：chat/responses 只带 Bearer public；anthropic 再加 x-api-key 和版本头', () => {
  assert.deepEqual(authHeaders('chat'), { authorization: `Bearer ${OPENCODE_ANONYMOUS_KEY}` });
  assert.deepEqual(authHeaders('responses'), { authorization: `Bearer ${OPENCODE_ANONYMOUS_KEY}` });
  assert.deepEqual(authHeaders('anthropic'), {
    authorization: `Bearer ${OPENCODE_ANONYMOUS_KEY}`,
    'x-api-key': OPENCODE_ANONYMOUS_KEY,
    'anthropic-version': '2023-06-01',
  });
  assert.equal(OPENCODE_ANONYMOUS_KEY, 'public', '永远匿名，绝不带用户凭据');
});

test('stubTools：bash/read 逐字节带上 OpenCode 的参数 schema，描述诚实且中性', () => {
  for (const dialect of ['chat', 'anthropic', 'responses']) {
    const tools = stubTools(dialect);
    assert.deepEqual(tools.map((t) => (dialect === 'chat' ? t.function.name : t.name)).sort(), ['bash', 'read']);
    for (const tool of tools) {
      const fn = dialect === 'chat' ? tool.function : tool;
      // 描述绝不能写"禁止调用"——那会让守规矩的模型不调桩，转交链路就断了
      assert.ok(!/never|not available/i.test(fn.description), `描述不许劝退：${fn.description}`);
      assert.ok(fn.description.length > 0, '描述不能为空');
      assert.ok(Array.isArray(fn.parameters?.required ?? fn.input_schema?.required), '必填项要在（空 schema 会被 403）');
      assert.ok(Object.keys((fn.parameters ?? fn.input_schema)?.properties ?? {}).length > 0, '参数 schema 不能是空的');
    }
  }
  assert.deepEqual(stubTools('chat')[0].function.description, OPENCODE_TOOL_DESCRIPTIONS.bash);
});
