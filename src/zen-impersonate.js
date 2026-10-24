/**
 * 伪装层（impersonation）：让本桥的直连请求在 zen 眼里就是一只真的 OpenCode 客户端。
 *
 * 这是 Magpie 路线的核心（参考 /tmp/magpie/internal/provider/opencode_client.go，
 * 其注释里的门禁规则全部来自 2026-10 真机实测）。免费池只伺候"看起来是 OpenCode"
 * 的请求，缺一样就 403/400/426：
 *
 *   1. UA 必须是真实客户端字串（版本 ≥1.18.0，否则 426）；
 *   2. `x-opencode-session`(+`-id`) 必须是 OpenCode 版式的 ses_ id——按它的
 *      identifier.ts 算法生成：`ses_` + 12 位十六进制（毫秒×0x1000+当日计数，
 *      会话 id 按位取反）+ 14 位随机 base62；同一会话每回合复用，两个会话绝不共用；
 *   3. `x-opencode-request` 每次请求都换新的 msg_ id（同格式，不取反）；
 *   4. `x-opencode-client: cli`、`x-opencode-project: global`；
 *   5. 绝不带 `x-session-affinity` / `X-Session-Id`（带了 403）；
 *   6. 工具表里必须有小写 bash、read 且带真实参数 schema（空 schema 403）；
 *   7. 上游永远流式（stream:true）；
 *   8. 匿名密钥 "public" 即可，不需要任何登录态——**绝不把用户凭据带过来**。
 */
import { randomBytes } from 'node:crypto';

/** 我们冒充的 OpenCode 版本。zen 免费池拒收 1.18.0 以下（426）；被停用时只需改这一处。 */
export const OPENCODE_VERSION = '1.19.0';

/** OpenCode 1.19.0 实测发出的 User-Agent（ai-sdk 与 Bun 版本一并带上）。 */
export const OPENCODE_USER_AGENT = `opencode/${OPENCODE_VERSION} ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14`;

/** 没登录时 OpenCode 用的匿名密钥；zen 的免费模型认它。 */
export const OPENCODE_ANONYMOUS_KEY = 'public';

/** 免费池真正伺候的根：zen 的 /zen 前缀会被拒，要打 /inference。 */
export const ZEN_INFERENCE_ROOT = 'https://opencode.ai/inference';

/** 模型目录的备用源（免费判定/上下文窗口/每模型协议标注都靠它）。 */
export const MODELS_DEV_URL = 'https://models.dev/api.json';

/**
 * 桩工具：让 zen 看见"申报了 bash/read"（空 schema 会被 403），但对我们不止是装饰——
 * 模型真调了它，调用会以结构化 tool_call 回到响应里，正好喂转交映射。
 *
 * 描述用诚实的中性功能说明：**不许写"Never call this tool"**（Magpie 那样写是因为
 * 它们把桩调用直接丢掉；我们靠桩调用转交）。实测守规矩的推理模型（如
 * nemotron-3.5-super-vl）读到"禁止调用"就真的不调，信封又没写好，体检被误判成
 * "只能聊天"。中性描述下：想动手的模型自然去调（转交接住），守协议的走信封，两条都通。
 */
export const OPENCODE_TOOL_DESCRIPTIONS = Object.freeze({
  bash: 'Execute a bash command in the terminal.',
  read: 'Read the contents of a file.',
});

export const OPENCODE_TOOL_SCHEMAS = Object.freeze({
  bash: Object.freeze({
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command to execute' },
      timeout: { type: 'integer', description: 'Optional timeout in milliseconds' },
      workdir: { type: 'string', description: 'The working directory to run the command in' },
    },
    required: ['command'],
  }),
  read: Object.freeze({
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'The absolute path to the file or directory to read' },
      offset: { type: 'integer', description: 'Line number to start reading from (1-indexed)' },
      limit: { type: 'integer', description: 'The maximum number of lines to read' },
    },
    required: ['filePath'],
  }),
});

/** OpenCode 版式 id 的形状（前缀 3 个小写字母 + 12 位十六进制 + 14 位 base62）。 */
export const OPENCODE_ID_PATTERN = /^[a-z]{3}_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * id 生成的时钟与计数器（OpenCode 的 identifier.ts 同款逻辑）：
 * 同一毫秒内多次生成时用低位计数器区分。会话 id（descending）把时间位取反，
 * 让"最新的会话"在字典序里排最前——zen 还会校验这 12 位的低位计数必须很小，
 * 乱造一个同形状的哈希值会被 403。
 */
const idClock = {
  lastMs: 0,
  counter: 0,
};

/**
 * 造一个 OpenCode 版式的 id。
 * @param {string} prefix 三字母前缀（'ses' 会话 / 'msg' 回合）
 * @param {object} [o]
 * @param {boolean} [o.descending] true = 时间位按位取反（会话 id 用）
 * @param {number} [o.now] 时间戳（默认现在；测试注入用）
 * @returns {string} 形如 `ses_012345abcdefABcdEFghijKL`
 */
export function openCodeNewID(prefix, { descending = false, now = Date.now() } = {}) {
  const ms = Number.isFinite(now) ? Math.floor(now) : Date.now();
  if (ms !== idClock.lastMs) {
    idClock.lastMs = ms;
    idClock.counter = 0;
  }
  idClock.counter += 1;
  let current = BigInt(ms) * 0x1000n + BigInt(idClock.counter);
  if (descending) current = ~current; // JS 的 ~ 对 BigInt 是按位取反
  // 和 Go 原版一样先掩到 48 位再格式化：取反后的值是负数，不先掩会格式出负号
  const hex = (current & 0xffffffffffffn).toString(16).padStart(12, '0');
  const random = randomBytes(14);
  let id = `${prefix}_${hex}`;
  for (const byte of random) id += BASE62[byte % BASE62.length];
  return id;
}

/** 这个 id 是不是 OpenCode 可能造出来的会话 id：形状对，且低 12 位的时间计数很小。 */
export function isOpenCodeSessionID(id) {
  if (typeof id !== 'string' || !id.startsWith('ses_') || !OPENCODE_ID_PATTERN.test(id)) return false;
  // Magpie 的校验口径：取第 14-16 位（十六进制）解析，取反后必须 < 16（计数器很小）
  const low = Number.parseInt(id.slice(13, 16), 16);
  return Number.isInteger(low) && 0xfff - low < 16;
}

/** 会话注册表：seed → ses_ id 的 LRU（同一会话复用、绝不跨会话共用）。 */
export function createSessionRegistry({ keep = 1000 } = {}) {
  const map = new Map(); // Map 本身按插入序，refresh 即 LRU
  return {
    /** 拿 seed 对应的会话 id；没有就造一个并记住（LRU 逐出最老的）。 */
    forSeed(seed) {
      const key = String(seed ?? '');
      if (isOpenCodeSessionID(key)) return key; // 调用方给的本来就是合法会话 id
      if (map.has(key)) {
        const id = map.get(key);
        map.delete(key);
        map.set(key, id); // 触一下，挪到最新
        return id;
      }
      const id = openCodeNewID('ses', { descending: true });
      map.set(key, id);
      if (map.size > keep) map.delete(map.keys().next().value);
      return id;
    },
    get size() {
      return map.size;
    },
  };
}

/**
 * 拼一次上游调用的全套伪装头。每次调用都换新的 x-opencode-request（msg_ id）。
 * 注意：这里**绝不**设置 x-session-affinity / X-Session-Id——带了会被免费池 403。
 *
 * @param {string} sessionID 已定的会话 id（ses_ 开头）
 * @returns {Record<string,string>}
 */
export function impersonationHeaders(sessionID) {
  return {
    'user-agent': OPENCODE_USER_AGENT,
    'x-opencode-session': sessionID,
    'x-opencode-session-id': sessionID,
    'x-opencode-request': openCodeNewID('msg'),
    'x-opencode-client': 'cli',
    'x-opencode-project': 'global',
  };
}

/**
 * 某个方言该带的认证头。匿名密钥 public：
 * chat/Responses 走 Bearer；Anthropic Messages 再加 x-api-key 和版本头
 * （OpenCode 用 @ai-sdk/anthropic，实测同款）。
 * @param {'chat'|'anthropic'|'responses'} dialect
 */
export function authHeaders(dialect) {
  const headers = { authorization: `Bearer ${OPENCODE_ANONYMOUS_KEY}` };
  if (dialect === 'anthropic') {
    headers['x-api-key'] = OPENCODE_ANONYMOUS_KEY;
    headers['anthropic-version'] = '2023-06-01';
  }
  return headers;
}

/** 两种方言各自的请求体里，桩工具（bash/read）长什么样。 */
export function stubTools(dialect) {
  return ['bash', 'read'].map((name) => {
    const parameters = OPENCODE_TOOL_SCHEMAS[name];
    const description = OPENCODE_TOOL_DESCRIPTIONS[name];
    if (dialect === 'anthropic') {
      return { name, description, input_schema: parameters };
    }
    if (dialect === 'responses') {
      return { type: 'function', name, description, parameters };
    }
    return { type: 'function', function: { name, description, parameters } };
  });
}
