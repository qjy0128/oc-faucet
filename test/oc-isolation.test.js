/**
 * 隔离运行时的测试。
 *
 * 这一层要挡住的是一类很贵的错误：把用户自己的供应商凭据带进子进程，
 * 于是"不放别家模型进来"只能靠代码筛，筛错一次就是替他花钱。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ENV_WHITELIST,
  ISOLATED_AGENT,
  buildIsolatedEnv,
  basicAuthHeader,
  ensureRuntimeDirs,
  isolatedConfig,
  randomPassword,
  runtimeRoot,
} from '../src/oc-isolation.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'oc-iso-'));
}

/** 一个"用户自己的环境"：带着各种不该进子进程的凭据 */
function pollutedEnv() {
  return {
    PATH: '/usr/bin:/bin',
    HOME: '/Users/someone',
    TMPDIR: '/tmp',
    LANG: 'zh_CN.UTF-8',
    // 下面这些一个都不该出现在子进程里
    OPENAI_API_KEY: 'sk-secret-openai',
    ANTHROPIC_API_KEY: 'sk-ant-secret',
    GEMINI_API_KEY: 'gemini-secret',
    ZAI_CODING_PLAN_API_KEY: 'zai-secret',
    ALIBABA_API_KEY: 'alibaba-secret',
    OPENCODE_SERVER_PASSWORD: '用户自己的口令',
    OPENCODE_CONFIG_CONTENT: '{"用户自己的配置":true}',
    MAYBE_TOKEN: 'some-token',
    SOMETHING_SECRET: 'some-secret',
  };
}

test('白名单里没有任何看得出是凭据的变量名', () => {
  const suspicious = /(_API_KEY|_TOKEN|_SECRET|_PASSWORD|^OPENAI_|^ANTHROPIC_|^GEMINI_|^AWS_)/;
  const leaked = ENV_WHITELIST.filter((key) => suspicious.test(key));
  assert.deepEqual(leaked, [], `这些名字不该在白名单里：${leaked.join(', ')}`);
});

test('buildIsolatedEnv：用户自己的凭据一个都不带进去', () => {
  const root = join(tempDir(), 'opencode');
  const env = buildIsolatedEnv({ root, baseEnv: pollutedEnv(), password: 'p' });

  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'ZAI_CODING_PLAN_API_KEY', 'ALIBABA_API_KEY', 'MAYBE_TOKEN', 'SOMETHING_SECRET']) {
    assert.equal(env[key], undefined, `${key} 不该出现在子进程环境里`);
  }
  // 该带的还在
  assert.equal(env.PATH, '/usr/bin:/bin');
  assert.equal(env.HOME, '/Users/someone');
  assert.equal(env.LANG, 'zh_CN.UTF-8');
});

test('buildIsolatedEnv：XDG 四个目录全指向运行时目录下', () => {
  const root = join(tempDir(), 'opencode');
  const env = buildIsolatedEnv({ root, baseEnv: {}, password: 'p' });

  assert.equal(env.XDG_CONFIG_HOME, join(root, 'config'));
  assert.equal(env.XDG_DATA_HOME, join(root, 'data'));
  assert.equal(env.XDG_CACHE_HOME, join(root, 'cache'));
  assert.equal(env.XDG_STATE_HOME, join(root, 'state'));
});

test('buildIsolatedEnv：自动更新、项目配置、外部技能、分享全关掉', () => {
  const env = buildIsolatedEnv({ root: join(tempDir(), 'oc'), baseEnv: {}, password: 'p' });
  assert.equal(env.OPENCODE_DISABLE_AUTOUPDATE, 'true');
  assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, 'true');
  assert.equal(env.OPENCODE_DISABLE_CLAUDE_CODE, 'true');
  assert.equal(env.OPENCODE_DISABLE_EXTERNAL_SKILLS, 'true');
});

test('buildIsolatedEnv：口令和隔离配置不能被 extraEnv 覆盖', () => {
  const root = join(tempDir(), 'oc');
  const env = buildIsolatedEnv({
    root,
    baseEnv: {},
    password: 'true-password',
    username: 'opencode',
    extraEnv: {
      OPENCODE_SERVER_PASSWORD: '想偷偷放宽的口令',
      OPENCODE_CONFIG_CONTENT: '{"permission":"allow"}',
      OPENCODE_DISABLE_AUTOUPDATE: 'false',
      STUB_LOG: '/tmp/x.jsonl', // 正常额外变量应当保留
    },
  });

  assert.equal(env.OPENCODE_SERVER_PASSWORD, 'true-password', '口令必须是我们生成的');
  assert.notEqual(env.OPENCODE_CONFIG_CONTENT, '{"permission":"allow"}', '隔离配置不能被顶掉');
  assert.equal(env.OPENCODE_DISABLE_AUTOUPDATE, 'true', '自动更新必须关');
  assert.equal(env.STUB_LOG, '/tmp/x.jsonl', '正常的额外变量要能带进去');
});

test('buildIsolatedEnv：隔离配置里本机动作一律挂审批，由客户端自动秒拒', () => {
  const env = buildIsolatedEnv({ root: join(tempDir(), 'oc'), baseEnv: {}, password: 'p' });
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);

  // 必须 ask 不能 deny：deny 会让 OpenCode 不把工具表申报给上游，免费池直接 403
  assert.equal(config.permission['*'], 'ask', '未列出的动作挂审批（由 OcClient 自动拒批），不能 deny');
  for (const action of ['question', 'websearch', 'codesearch', 'webfetch', 'task', 'todowrite']) {
    assert.equal(config.permission[action], 'deny', `${action} 必须直接拒掉`);
  }
  assert.equal(config.autoupdate, false);
  assert.equal(config.share, 'disabled');
  assert.ok(config.agent[ISOLATED_AGENT], '要有我们自己的推理 agent');
});

test('buildIsolatedEnv：缺参数时明确报错，不生成半个环境', () => {
  assert.throws(() => buildIsolatedEnv({ root: '', password: 'p' }), TypeError);
  assert.throws(() => buildIsolatedEnv({ root: '/tmp/x', password: '' }), TypeError);
});

test('ensureRuntimeDirs：config/data/cache/state/project 全建出来，权限 0700', () => {
  const root = join(tempDir(), 'opencode');
  ensureRuntimeDirs(root);

  for (const name of ['config', 'data', 'cache', 'state', 'project']) {
    const dir = join(root, name);
    assert.ok(existsSync(dir), `${name} 目录应当存在`);
    // 权限位只取低 9 位比较，避开不同文件系统的额外标记
    assert.equal(statSync(dir).mode & 0o777, 0o700, `${name} 应当是 0700`);
  }
});

test('runtimeRoot：拼在数据目录下，参数不对就报错', () => {
  assert.equal(runtimeRoot('/data/oz'), join('/data/oz', 'opencode'));
  assert.throws(() => runtimeRoot(''), TypeError);
  assert.throws(() => runtimeRoot(undefined), TypeError);
});

test('randomPassword：够长、每次都不一样', () => {
  const a = randomPassword();
  const b = randomPassword();
  assert.equal(a.length, 48);
  assert.match(a, /^[0-9a-f]+$/);
  assert.notEqual(a, b, '两次生成的口令不该相同');
});

test('basicAuthHeader：是标准的 Basic base64', () => {
  const header = basicAuthHeader('opencode', 'abc123');
  assert.equal(header, `Basic ${Buffer.from('opencode:abc123').toString('base64')}`);
  assert.match(header, /^Basic [A-Za-z0-9+/]+={0,2}$/);
});

test('清理临时目录', (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.ok(existsSync(dir));
});
