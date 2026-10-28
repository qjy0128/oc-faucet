/**
 * 隔离运行时：给 OC Faucet 单独养一只 OpenCode，不碰用户自己那只。
 *
 * 为什么必须隔离（踩过坑才明白的，不是想当然）：
 *
 *   1. **别家供应商的钱**。用户自己的 OpenCode 里可能配了阿里云百炼、OpenAI、智谱……
 *      那些花的是他自己的钱或订阅额度。只要复用他的运行时，那些凭据就在环境里，
 *      模型清单里就会出现，"不放进来"只能靠代码筛——筛错一次就是替他花钱。
 *      隔离之后那些凭据根本不进子进程，从"看见了不拿"变成"压根看不见"。
 *
 *   2. **配置打架**。复用用户运行时会带上他的 `opencode.json`、项目配置、外部技能、
 *      自动更新。任何一条都可能让接入行为随他的项目变化而变化，出了问题也难复现。
 *
 * 做法：
 *   - 独立的 XDG 目录（config/data/cache/state 全指向数据目录下）
 *   - 环境变量按白名单复制，别的一概不带
 *   - 随机口令 + Basic 认证，本机别的程序也调不动它
 *   - 一份写死的配置：本机动作一律不批、自动更新关、分享关
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * 允许带进子进程的环境变量。
 *
 * 只留"让程序能正常跑起来"的那些（找可执行文件、时区、证书、临时目录）；
 * 凡是可能带凭据的一律不带——`*_API_KEY`、`*_TOKEN`、`*_SECRET`、
 * `OPENAI_*`、`ANTHROPIC_*`、`GEMINI_*` 这些都不在名单里。
 */
export const ENV_WHITELIST = Object.freeze([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'TZ',
  'TMPDIR',
  'SHELL',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'NODE_OPTIONS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  // Windows
  'SystemRoot',
  'WINDIR',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PATHEXT',
  'COMSPEC',
]);

/** XDG 四个目录名（Windows 上 OpenCode 也认这几个环境变量） */
export const XDG_DIRS = Object.freeze(['config', 'data', 'cache', 'state']);

/** 运行时目录下还要有：会话工作区、启动时的工作目录，以及 v2 的隔离 HOME */
const EXTRA_DIRS = Object.freeze(['project', 'home']);

/**
 * 隔离配置：这只 OpenCode 只负责"推理"，不负责"动手"。
 *
 * - `permission` 一律标成 ask，**必须配合 OcClient 的自动拒批**（prompt 期间轮询
 *   /permission 并立刻 reject）。为什么不能图省事写 deny：deny 会让 OpenCode 不再把
 *   工具表申报给上游，而免费池要求请求里声明带参数的 bash/read 工具——申报为空 zen
 *   直接 403（"free tier can only be used from within OpenCode"，2026-10-22 实测，
 *   全模型团灭）。ask 下工具表照常申报；模型真调工具时由 OcClient 秒拒，回合正常结束。
 *   真正的执行权在客户端那边，本桥只让它产出 JSON 信封。
 * - `autoupdate` / `share` / 外部技能全关：接入行为不该因为上游偷偷升级而变。
 */
export const isolatedConfig = Object.freeze({
  permission: {
    '*': 'ask',
    question: 'deny',
    websearch: 'deny',
    codesearch: 'deny',
    webfetch: 'deny',
    task: 'deny',
    plan_enter: 'deny',
    plan_exit: 'deny',
    todowrite: 'deny',
  },
  autoupdate: false,
  share: 'disabled',
  agent: {
    // 外部推理专用：只按信封协议作答，绝不碰本机工具
    'oc-faucet': {
      mode: 'primary',
      description: 'OC Faucet 外部推理',
      prompt:
        '你是外部助手的推理组件。绝不调用 OpenCode 自带的工具；' +
        '需要外部工具时，只能在被要求的 JSON 响应里描述调用。' +
        '外部客户端拥有执行权，并会在下一次请求里把工具结果给你。',
      permission: {
        '*': 'ask',
        question: 'deny',
        websearch: 'deny',
        codesearch: 'deny',
        webfetch: 'deny',
        task: 'deny',
        plan_enter: 'deny',
        plan_exit: 'deny',
        todowrite: 'deny',
      },
    },
  },
});

/** 这只 OpenCode 用的 agent 名 */
export const ISOLATED_AGENT = 'oc-faucet';

/** 运行时根目录：`<数据目录>/opencode` */
export function runtimeRoot(dataDir) {
  if (typeof dataDir !== 'string' || !dataDir) {
    throw new TypeError('runtimeRoot 需要一个非空的数据目录路径');
  }
  return join(dataDir, 'opencode');
}

/**
 * 把运行时需要的目录都建出来（权限 0700）。
 * @param {string} root `runtimeRoot()` 的返回值
 * @returns {string} 同一个 root，方便链式调用
 */
export function ensureRuntimeDirs(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const name of XDG_DIRS) mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
  for (const name of EXTRA_DIRS) mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
  return root;
}

/**
 * 造一个随机口令，给这只 OpenCode 的 HTTP 接口上锁。
 * @returns {string} 48 位十六进制
 */
export function randomPassword() {
  return randomBytes(24).toString('hex');
}

/**
 * 拼出子进程的环境变量：白名单 + XDG 指向隔离目录 + 隔离配置 + 口令。
 *
 * `extraEnv` 最后合并，让调用方（以及测试里的假 opencode）能带上自己的开关；
 * 但它**不能**覆盖口令和隔离配置——那几项在合并之后重新钉一遍。
 *
 * @param {object} o
 * @param {string} o.root                  运行时根目录
 * @param {object} [o.baseEnv]             从哪个环境里摘（默认 process.env）
 * @param {string} o.password              OpenCode 的 HTTP 口令
 * @param {string} [o.username]            Basic 认证用户名
 * @param {object} [o.extraEnv]            额外要带进去的变量
 * @returns {Record<string,string>}
 */
export function buildIsolatedEnv({ root, baseEnv = process.env, password, username = 'opencode', extraEnv = {} }) {
  if (typeof root !== 'string' || !root) throw new TypeError('buildIsolatedEnv 需要一个非空的运行时目录');
  if (typeof password !== 'string' || !password) throw new TypeError('buildIsolatedEnv 需要一个非空口令');

  const env = {};
  for (const key of ENV_WHITELIST) {
    const value = baseEnv?.[key];
    if (typeof value === 'string' && value) env[key] = value;
  }

  for (const name of XDG_DIRS) {
    env[`XDG_${name.toUpperCase()}_HOME`] = join(root, name);
  }

  if (extraEnv && typeof extraEnv === 'object') {
    for (const [key, value] of Object.entries(extraEnv)) {
      if (typeof value === 'string') env[key] = value;
    }
  }

  // 这几项在 extraEnv 之后钉死：调用方不该能把隔离关掉
  env.OPENCODE_SERVER_USERNAME = username;
  env.OPENCODE_SERVER_PASSWORD = password;
  env.OPENCODE_DISABLE_AUTOUPDATE = 'true';
  env.OPENCODE_DISABLE_PROJECT_CONFIG = 'true';
  env.OPENCODE_DISABLE_CLAUDE_CODE = 'true';
  env.OPENCODE_DISABLE_EXTERNAL_SKILLS = 'true';
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(isolatedConfig);

  return env;
}

/**
 * Basic 认证头。
 * @param {string} username
 * @param {string} password
 * @returns {string} `Basic xxx`
 */
export function basicAuthHeader(username, password) {
  const raw = `${username}:${password}`;
  return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
}
