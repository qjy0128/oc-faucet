/**
 * 本机 HTTP 转发面。
 *
 * 这个端口是给 ZCode 当「Anthropic 供应商」用的，只绑 127.0.0.1，密钥由我们自己生成。
 * 三条铁律：
 *   1. 每个请求都要验密钥（连 /health 和 /v1/models 也不例外）；
 *   2. 带 Origin 头的一律 403 —— 这是本机口，绝不接受浏览器页面发来的请求；
 *   3. 日志里永远不许出现密钥。
 *
 * 本文件只做「HTTP 层」的事：路由、鉴权、围栏、读体、排队、错误映射、写日志、拼响应头。
 * 真正的协议翻译（信封解析、Anthropic/OpenAI 形状互转）在 src/protocol.js（codec 同学），
 * 上游调用在 bridge.complete（main.js）。我们只按契约第 7 节的签名调用它们，绝不自己实现。
 */
import http from 'node:http';
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { BridgeError, asBridgeError } from './errors.js';

/** 请求体上限：32MB */
const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** 上游并发上限默认值 */
const DEFAULT_CONCURRENCY = 4;

/** 从 package.json 读版本号，读不到就算了，不能因为这个把服务带崩 */
function readVersion() {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const v = JSON.parse(raw).version;
    return typeof v === 'string' && v ? v : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
const VERSION = readVersion();

/**
 * 三种方言各自的 codec 入口名（protocol.js 导出）。
 * Responses 的两个上行函数多收一个 prepared：命名空间工具要把摊平的名字拆回去。
 */
const CODECS = {
  anthropic: { prepare: 'prepareAnthropic', json: 'toAnthropicResponse', sse: 'sendAnthropicSSE' },
  openai: { prepare: 'prepareOpenAI', json: 'toOpenAIResponse', sse: 'sendOpenAISSE' },
  responses: { prepare: 'prepareResponses', json: 'toResponsesResponse', sse: 'sendResponsesSSE' },
};

/**
 * 缓存 protocol.js 的加载结果。
 *
 * 为什么是动态 import：codec 同学的 src/protocol.js 是独立写作用域，我不该去创建它；
 * 顶层静态 import 会让「文件还不存在」时的测试直接解析失败。动态 import 同样只使用
 * 契约第 7 节的公开签名，但允许本模块先加载起来（测试里还可以用 o.protocol 注入桩）。
 * 加载失败不缓存失败结果，下次请求会重试。
 */
let protocolPromise = null;
function loadProtocol() {
  if (!protocolPromise) {
    protocolPromise = import('./protocol.js').catch((err) => {
      protocolPromise = null;
      throw err;
    });
  }
  return protocolPromise;
}

/** 定长比较，避免用 === 比较密钥时泄漏时序信息 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  try {
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/** 取出请求里携带的密钥：x-api-key 优先，其次 Authorization: Bearer */
function presentedKey(req) {
  const pick = (v) => (Array.isArray(v) ? v[0] : v);
  const xKey = pick(req.headers['x-api-key']);
  if (typeof xKey === 'string' && xKey.trim()) return xKey.trim();
  const auth = pick(req.headers.authorization);
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m && m[1].trim()) return m[1].trim();
  }
  return null;
}

/** 统一错误体：契约第 8 节规定的形状 */
function errorBody(code, message) {
  return { type: 'error', error: { type: code, message } };
}

/** 把 URL 路径归到「协议」维度，用于日志里的 protocol 字段 */
function protocolOfPath(path) {
  switch (path) {
    case '/health':
      return 'health';
    case '/v1/models':
      return 'models';
    case '/v1/messages':
    case '/v1/messages/count_tokens':
      return 'anthropic';
    case '/v1/chat/completions':
      return 'openai';
    case '/v1/responses':
      return 'responses';
    default:
      return 'unknown';
  }
}

/**
 * 读请求体，超过上限立刻放弃并抛 413。
 * 注意：超限时主动 pause()，不再把剩余字节读进内存。
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(arg);
    };

    function onData(chunk) {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        try {
          req.pause();
        } catch {
          /* 忽略：暂停失败不影响返回 413 */
        }
        finish(
          reject,
          new BridgeError(
            `请求体太大了（超过 ${limit} 字节上限）。请把单次请求的内容缩小后再试。`,
            413,
            'payload_too_large',
          ),
        );
        return;
      }
      chunks.push(chunk);
    }
    function onEnd() {
      finish(resolve, Buffer.concat(chunks));
    }
    function onError(err) {
      finish(reject, err);
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/**
 * 极简 Promise 信号量：名额满了就排队等，**不丢请求**。
 * 只在真正的上游调用（bridge.complete）外面套一层。
 */
function createLimiter(limit, log) {
  let active = 0;
  const waiting = [];

  const release = () => {
    active -= 1;
    const next = waiting.shift();
    if (next) {
      active += 1;
      next();
    }
  };

  return async function run(fn) {
    if (active < limit) {
      active += 1;
    } else {
      const ahead = waiting.length;
      log(
        ahead === 0
          ? `上游并发已达上限 ${limit}，这个请求开始排队等待（不会丢弃）。`
          : `上游并发已达上限 ${limit}，继续排队中（前面还有 ${ahead} 个）。`,
      );
      await new Promise((resolve) => waiting.push(resolve));
    }
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

/** 把上游 token 统计压成日志里的一行小对象；给不出就 null */
function summarizeTokens(tokens, protocolModule) {
  if (!tokens || typeof tokens !== 'object') return null;
  if (protocolModule && typeof protocolModule.tokenUsage === 'function') {
    try {
      const u = protocolModule.tokenUsage(tokens);
      if (u && typeof u === 'object') {
        return {
          input: num(u.input),
          output: num(u.output),
          cacheRead: num(u.cacheRead),
          cacheWrite: num(u.cacheWrite),
          reasoning: num(u.reasoning),
        };
      }
    } catch {
      /* tokenUsage 挂了也不能影响记日志，往下走本地兜底 */
    }
  }
  const cache = tokens.cache && typeof tokens.cache === 'object' ? tokens.cache : {};
  return {
    input: num(tokens.input),
    output: num(tokens.output),
    cacheRead: num(cache.read ?? tokens.cacheRead),
    cacheWrite: num(cache.write ?? tokens.cacheWrite),
    reasoning: num(tokens.reasoning),
  };
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** 信封可能带 name/arguments，但保底用 JSON 字符串统计 */
function safeStringify(v) {
  try {
    const s = JSON.stringify(v);
    return typeof s === 'string' ? s : '';
  } catch {
    return '';
  }
}

/**
 * 粗略估算输入 token：把 messages 里所有文本字符数加起来，按「4 字符 ≈ 1 token」算。
 * 只数 messages（按需求口径），不数 system，也不问上游。
 */
function estimateInputChars(body) {
  let chars = 0;
  const addText = (s) => {
    if (typeof s === 'string') chars += [...s].length; // 按码点算，中文/emoji 才算得准
  };
  const walkContent = (content) => {
    if (typeof content === 'string') {
      addText(content);
      return;
    }
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      switch (block.type) {
        case 'text':
        case 'thinking':
          addText(block.text ?? block.thinking);
          break;
        case 'tool_use':
          if (block.input !== undefined) addText(safeStringify(block.input));
          break;
        case 'tool_result':
          walkContent(block.content);
          break;
        default:
          addText(block.text);
      }
    }
  };
  const messages = Array.isArray(body && body.messages) ? body.messages : [];
  for (const m of messages) {
    if (m && typeof m === 'object') walkContent(m.content);
  }
  return chars;
}

/**
 * 把异常归一成一个安全的 {status, code, message}，非法状态码一律收成 500。
 *
 * 关键：**只有我们主动抛的 BridgeError 才允许把原文给客户端**。
 * 意料之外的异常（代码 bug、第三方库报错里带连接串/路径/密钥）只回一句人话，
 * 真正的原因写进服务端日志——否则等于把内部实现细节送给调用方。
 */
function normalizeError(err, log) {
  const isOurs = err instanceof BridgeError;
  const be = asBridgeError(err);
  let status = Number.isInteger(be.status) ? be.status : 500;
  if (status < 400 || status > 599) status = 500;
  const code = typeof be.code === 'string' && be.code ? be.code : 'internal_error';

  if (!isOurs) {
    if (typeof log === 'function') log(`本次请求内部异常（只记在服务端）：${be.message}`);
    return {
      status,
      code,
      message: '本机转发服务内部出错。请查看控制面板里的请求日志，或点「请求日志」打开明细。',
    };
  }

  const message = typeof be.message === 'string' && be.message ? be.message : '本机转发服务内部出错。';
  return { status, code, message };
}

/**
 * @param {object} o
 * @param {object} o.bridge   接口见契约第 8 节，直接传对象便于测试打桩
 * @param {string} o.apiKey   本机口密钥
 * @param {(m:string)=>void} [o.log]
 * @param {number} [o.concurrency] 上游并发上限，默认 4
 * @param {string} [o.dataDir]     结构化日志落盘目录，可选
 * @param {number} [o.maxBodyBytes] 请求体上限，默认 32MB（主要给测试用小值）
 * @param {object} [o.protocol]    仅测试用：注入 protocol.js 的替身
 * @param {boolean} [o.lanAccess]  路由器广播：调用方将把本口绑到 0.0.0.0，
 *                                 监听告警按这个预期校验（密钥与 Origin 围栏不变）
 * @returns {import('node:http').Server}
 */
export function createServer(o = {}) {
  const bridge = o.bridge;
  if (!bridge || typeof bridge.getModels !== 'function' || typeof bridge.complete !== 'function') {
    throw new BridgeError('createServer 需要 o.bridge，且必须带 getModels() 和 complete()。', 500, 'invalid_argument');
  }

  const apiKey = typeof o.apiKey === 'string' ? o.apiKey : '';
  if (!apiKey) {
    // 宁可不启动，也不要开一个谁都能用的本机口
    throw new BridgeError(
      'createServer 需要非空的 o.apiKey：没有密钥的本机转发口等于对全机器敞开，拒绝启动。',
      500,
      'invalid_argument',
    );
  }
  // 当前生效的密钥：setApiKey 会换掉它，下一个请求起就按新值验
  let currentApiKey = apiKey;

  const log = typeof o.log === 'function' ? o.log : (m) => console.error(String(m));
  const maxBodyBytes =
    Number.isInteger(o.maxBodyBytes) && o.maxBodyBytes > 0 ? o.maxBodyBytes : MAX_BODY_BYTES;
  const concurrency = Math.max(
    1,
    Number.isInteger(o.concurrency) && o.concurrency > 0 ? o.concurrency : DEFAULT_CONCURRENCY,
  );
  const dataDir = typeof o.dataDir === 'string' && o.dataDir ? o.dataDir : null;
  const injectedProtocol = o.protocol && typeof o.protocol === 'object' ? o.protocol : null;
  const lanAccess = o.lanAccess === true;

  if (dataDir) {
    try {
      mkdirSync(dataDir, { recursive: true });
    } catch (err) {
      log(`数据目录建不出来，本次不记 requests.jsonl：${err && err.message}`);
    }
  }

  const startedAtMs = Date.now();
  const createdAtSeconds = Math.floor(startedAtMs / 1000);
  const limitUpstream = createLimiter(concurrency, log);

  /** 日志里绝不能出现密钥：宁可误伤，也要把密钥抹掉 */
  const secrets = [apiKey];
  const redact = (text) => {
    let s = typeof text === 'string' ? text : String(text);
    for (const secret of secrets) {
      if (secret) s = s.split(secret).join('[已隐藏]');
    }
    return s;
  };

  /** 每次请求记一行 JSON，追加到 <dataDir>/requests.jsonl */
  const appendRequestLog = (entry) => {
    if (!dataDir) return;
    const line = redact(JSON.stringify(entry));
    try {
      appendFileSync(join(dataDir, 'requests.jsonl'), `${line}\n`, 'utf8');
    } catch (err) {
      log(`requests.jsonl 写失败（不影响本次请求）：${err && err.message}`);
    }
  };

  /** 发 JSON。已经发过响应头就别再动，避免 ERR_HTTP_HEADERS_SENT */
  const sendJson = (res, status, obj) => {
    if (res.headersSent) return;
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  };

  const sendError = (res, error) => {
    if (res.headersSent) return;
    sendJson(res, error.status, errorBody(error.code, redact(error.message)));
  };

  /** 上游信息：bridge 没提供就退化成「能取到模型就算就绪」 */
  const upstreamInfo = (modelsOk) => {
    const u = bridge.upstream;
    let ready = modelsOk;
    let baseUrl = null;
    if (u && typeof u === 'object') {
      try {
        ready = typeof u.ready === 'function' ? !!u.ready() : u.ready === undefined ? modelsOk : !!u.ready;
      } catch {
        ready = false;
      }
      try {
        baseUrl = typeof u.baseUrl === 'function' ? u.baseUrl() : (u.baseUrl ?? null);
      } catch {
        baseUrl = null; // 契约里 baseUrl 是 getter，未启动时会抛，这里必须吞掉
      }
    }
    return { ready, baseUrl: baseUrl ?? null };
  };

  const handleGetHealth = async (res) => {
    let modelsOk = true;
    let count = 0;
    try {
      const models = await bridge.getModels();
      count = Array.isArray(models) ? models.length : 0;
    } catch (err) {
      modelsOk = false;
      log(`/health 取模型列表失败：${err && err.message}`);
    }
    sendJson(res, 200, {
      ok: modelsOk,
      version: VERSION,
      models: count,
      upstream: upstreamInfo(modelsOk),
      uptimeMs: Date.now() - startedAtMs,
    });
    return 200;
  };

  const handleGetModels = async (res) => {
    const models = await bridge.getModels();
    const data = (Array.isArray(models) ? models : [])
      .filter((m) => m && typeof m === 'object' && typeof m.id === 'string')
      .map((m) => ({
        id: m.id,
        object: 'model',
        owned_by: typeof m.providerID === 'string' && m.providerID ? m.providerID : 'oc-faucet',
        created: createdAtSeconds,
      }));
    sendJson(res, 200, { object: 'list', data });
    return 200;
  };

  const handleCountTokens = async (req, res) => {
    const raw = await readBody(req, maxBodyBytes);
    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new BridgeError(
        '请求体不是合法的 JSON，没法解析。请检查是不是漏了引号、逗号，或发成了别的编码。',
        400,
        'invalid_json',
      );
    }
    const inputTokens = Math.ceil(estimateInputChars(body) / 4);
    sendJson(res, 200, { input_tokens: inputTokens });
    return 200;
  };

  /**
   * 三条补全路由共用：读体 → 校验模型 → 排队调上游 → 非流式 JSON / 流式 SSE。
   * flavor 是 'anthropic' | 'openai' | 'responses'。
   */
  const handleCompletion = async (req, res, meta, flavor) => {
    const raw = await readBody(req, maxBodyBytes);
    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new BridgeError(
        '请求体不是合法的 JSON，没法解析。请检查是不是漏了引号、逗号，或发成了别的编码。',
        400,
        'invalid_json',
      );
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new BridgeError('请求体必须是一个 JSON 对象。', 400, 'invalid_request');
    }

    // protocol.js 只加载一次并缓存；测试里可以用 o.protocol 注入桩
    const protocolModule = injectedProtocol ?? (await loadProtocol());
    const codec = CODECS[flavor];
    const missing = Object.values(CODECS)
      .flatMap((entry) => [entry.prepare, entry.json, entry.sse])
      .filter((name) => typeof protocolModule[name] !== 'function');
    if (missing.length) {
      throw new BridgeError(
        `协议模块不完整，缺少：${missing.join('、')}。请检查 src/protocol.js 是否已完整实现。`,
        500,
        'internal_error',
      );
    }

    // 先按协议把请求翻译一遍：这一步就能把「模型不存在」之类的问题挡在上游调用之前
    const models = await bridge.getModels();
    const prepared = protocolModule[codec.prepare](body, models);

    meta.model = (prepared && prepared.model && prepared.model.id) || (typeof body.model === 'string' ? body.model : null);
    meta.stream = !!(prepared && prepared.stream);

    // 上游调用排队：超出并发上限的在这里等，而不是被丢掉
    const result = await limitUpstream(() => bridge.complete({ protocol: flavor, body }));

    const model = (result && result.model) || (prepared && prepared.model) || null;
    const decoded = result && result.decoded ? result.decoded : { content: '', calls: [] };
    const tokens = result && result.tokens !== undefined ? result.tokens : null;
    meta.tokens = summarizeTokens(tokens, protocolModule);

    if (!model) {
      throw new BridgeError('上游没有返回模型信息，无法生成响应。', 502, 'upstream_error');
    }

    if (meta.stream) {
      // 流式：先把头设好，再交给 codec 的 send*SSE —— 它会自己 res.end()，我们之后一个字节都不许写
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      try {
        res.socket?.setNoDelay?.(true);
      } catch {
        /* 无所谓，只是想让分片别被 Nagle 攒着 */
      }
      if (flavor === 'anthropic') {
        protocolModule.sendAnthropicSSE(res, model, decoded, tokens);
      } else if (flavor === 'openai') {
        const includeUsage = !!(body.stream_options && body.stream_options.include_usage);
        protocolModule.sendOpenAISSE(res, model, decoded, tokens, includeUsage);
      } else {
        protocolModule.sendResponsesSSE(res, model, decoded, tokens, prepared);
      }
      return 200;
    }

    // 非流式：纯函数转形状，我们自己写头写体
    const payload =
      flavor === 'anthropic'
        ? protocolModule.toAnthropicResponse(model, decoded, tokens)
        : flavor === 'openai'
          ? protocolModule.toOpenAIResponse(model, decoded, tokens)
          : protocolModule.toResponsesResponse(model, decoded, tokens, prepared);
    sendJson(res, 200, payload);
    return 200;
  };

  /** 路由总入口。返回最终要记进日志的状态码。 */
  const handle = async (req, res, meta) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const rawPath = url.pathname;
    const path = rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
    meta.protocol = protocolOfPath(path);

    // 1) 围栏：只要带 Origin 就是浏览器来的，先于鉴权直接 403
    if (req.headers.origin !== undefined) {
      sendError(
        res,
        normalizeError(
          new BridgeError(
            '这个端口只给本机程序用，不接受浏览器发来的请求。请在 ZCode 或命令行客户端里使用。',
            403,
            'browser_not_allowed',
          ),
        ),
      );
      return 403;
    }

    // 2) 鉴权：所有路由都要，包括 /health 和 /v1/models
    if (!safeEqual(presentedKey(req), currentApiKey)) {
      sendError(
        res,
        normalizeError(
          new BridgeError(
            '密钥不对或没带密钥。请在请求里带上 x-api-key 或 Authorization: Bearer <密钥>。',
            401,
            'unauthorized',
          ),
        ),
      );
      return 401;
    }

    // 3) 路由
    const method = req.method || 'GET';
    switch (`${method} ${path}`) {
      case 'GET /health':
        return await handleGetHealth(res);
      case 'GET /v1/models':
        return await handleGetModels(res);
      case 'POST /v1/messages':
        return await handleCompletion(req, res, meta, 'anthropic');
      case 'POST /v1/chat/completions':
        return await handleCompletion(req, res, meta, 'openai');
      case 'POST /v1/responses':
        return await handleCompletion(req, res, meta, 'responses');
      case 'POST /v1/messages/count_tokens':
        return await handleCountTokens(req, res);
      default: {
        const allowed = ['GET /health', 'GET /v1/models', 'POST /v1/messages', 'POST /v1/chat/completions', 'POST /v1/responses', 'POST /v1/messages/count_tokens']
          .filter((r) => r.endsWith(` ${path}`))
          .map((r) => r.split(' ')[0]);
        if (allowed.length) {
          // 路径认识、方法不对：405 并告诉对方哪些方法可用
          if (!res.headersSent) res.setHeader('allow', allowed.join(', '));
          sendError(
            res,
            normalizeError(
              new BridgeError(`这个地址不支持 ${method} 方法，请改用：${allowed.join(' / ')}。`, 405, 'method_not_allowed'),
            ),
          );
          return 405;
        }
        sendError(
          res,
          normalizeError(
            new BridgeError(`没有这个地址：${method} ${path}。请检查是不是路径拼错了。`, 404, 'not_found'),
          ),
        );
        return 404;
      }
    }
  };

  const server = http.createServer((req, res) => {
    const requestStartMs = Date.now();
    const meta = { model: null, stream: false, tokens: null, error: null, protocol: null };
    let logged = false;

    const writeLog = (status) => {
      if (logged) return;
      logged = true;
      appendRequestLog({
        ts: new Date(requestStartMs).toISOString(),
        protocol: meta.protocol,
        model: meta.model,
        stream: meta.stream,
        status,
        elapsedMs: Date.now() - requestStartMs,
        tokens: meta.tokens,
        error: meta.error,
      });
    };

    Promise.resolve()
      .then(() => handle(req, res, meta))
      .then((status) => writeLog(typeof status === 'number' ? status : 200))
      .catch((err) => {
        const normalized = normalizeError(err, log);
        meta.error = normalized.code;
        if (res.headersSent) {
          // 头已经发出去了（流式途中出错）：只能收尾，不能再改状态码
          try {
            res.end();
          } catch {
            /* 连接可能已经断了 */
          }
          writeLog(res.statusCode);
        } else {
          sendError(res, normalized);
          writeLog(normalized.status);
        }
      });
  });

  /** 监听地址与预期核对：默认只许回环；路由器广播开了就应绑全地址 */
  server.on('listening', () => {
    const addr = server.address();
    const host = addr && typeof addr === 'object' ? addr.address : '';
    const loopback = host === '127.0.0.1' || host === '::1';
    const wildcard = host === '0.0.0.0' || host === '::' || host === '';
    if (lanAccess && !wildcard) {
      log(`警告：路由器广播已开，但转发口只监听到 ${host}，局域网设备可能连不进来。`);
    } else if (!lanAccess && !loopback) {
      log(`警告：本机转发口监听到了 ${host}，期望只监听 127.0.0.1。`);
    }
  });

  server.ozFaucet = { concurrency, maxBodyBytes, apiKeyConfigured: true };

  /**
   * 运行时换密钥：下一个请求起按新密钥验，旧密钥立刻作废，进程不用重启。
   * 换下来的旧密钥仍留在抹除清单里——历史日志和新日志都不许出现任何一把密钥。
   */
  server.setApiKey = (next) => {
    const key = typeof next === 'string' ? next.trim() : '';
    if (!key) {
      throw new BridgeError('新密钥是空的，没法换。转发口继续用原来的密钥。', 400, 'invalid_api_key');
    }
    currentApiKey = key;
    secrets.push(key);
  };

  return server;
}

export default createServer;
