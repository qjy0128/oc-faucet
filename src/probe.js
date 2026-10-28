/**
 * 模型体检：这个模型到底能不能按协议产生工具调用？
 *
 * 背景（为什么非做不可）：免费模型池里大量模型只会聊天，不会按信封协议产生工具调用。
 * 如果不体检就丢给编程工具，用户让它读个文件，模型会开始**编造文件内容**——这比直接报错
 * 更糟。所以每个模型上线前都要实测一次：给它一个只能读文件的 read 工具，让它真读一次
 * 带随机 token 的靶子文件。读到才准上线。
 *
 * 体检口径改了（提示词、判定规则、靶子文件写法……），必须同步改 PROBE_FINGERPRINT，
 * 让旧缓存全部失效，否则老结论会继续骗人。
 */
import { randomBytes } from 'node:crypto';
import { rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BridgeError } from './errors.js';

/** 探测口径版本号。探测逻辑变了必须改这个（改了旧缓存自动作废）。
 *  v2（2026-10-23）：回合内真调过本机工具（被审批拦下）也算 tool——转交链路上线后
 *  这类模型在真实流量里完全能编程，以前把它们误判成"只能聊天"还顺手剥了工具表。 */
export const PROBE_FINGERPRINT = 'v2';

const DEFAULT_TIMEOUT_MS = 90000;
const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 6;

/**
 * 体检一个模型。
 *
 * @param {object} client     只需满足接口契约第 5 节的 OcClient（测试里用假 client 打桩）
 * @param {object} model      Model
 * @param {object} o
 * @param {string} o.workdir      靶子临时文件放哪（必须是绝对路径且存在）
 * @param {number} [o.timeoutMs]  默认 90000
 * @param {(s:string)=>void} [o.onLog]
 * @returns {Promise<{verdict:'tool'|'chat', note:string, elapsedMs:number}>}
 */
export async function probe(client, model, o = {}) {
  if (!client || typeof client.prompt !== 'function') {
    throw new BridgeError('体检失败：拿不到可用的 OpenCode 连接', 500, 'probe_no_client');
  }
  const modelRef = resolveModelRef(model);
  const workdir = o.workdir;
  if (typeof workdir !== 'string' || !path.isAbsolute(workdir)) {
    throw new BridgeError('体检失败：工作目录必须是绝对路径', 500, 'probe_bad_workdir');
  }
  try {
    const info = await stat(workdir);
    if (!info.isDirectory()) {
      throw new BridgeError(`体检失败：工作目录不是一个目录（${workdir}）`, 500, 'probe_bad_workdir');
    }
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError(`体检失败：工作目录不存在（${workdir}）`, 500, 'probe_bad_workdir');
  }

  const timeoutMs = Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : DEFAULT_TIMEOUT_MS;
  const onLog = typeof o.onLog === 'function' ? o.onLog : () => {};

  // 靶子文件：随机文件名 + 随机 token，避免模型靠背题蒙对
  const token = `OZ-PROBE-${randomBytes(4).toString('hex')}`;
  const fileName = `.oc-probe-${randomBytes(4).toString('hex')}.txt`;
  const filePath = path.join(workdir, fileName);

  const startedAt = Date.now();
  let sessionID = null;
  const abort = new AbortController();
  const timer = setTimeout(() => {
    abort.abort(new BridgeError(`体检超时：模型 ${timeoutMs} 毫秒内没有回话`, 504, 'probe_timeout'));
  }, timeoutMs);
  // 别让这个计时器拖住进程退出
  if (typeof timer.unref === 'function') timer.unref();

  try {
    await writeFile(filePath, `${token}\n`, 'utf8');

    sessionID = await client.createSession({
      title: `OC Faucet 体检 · ${modelRef.label}`,
      directory: workdir,
    });

    const reply = await withAbort(
      client.prompt({
        sessionID,
        providerID: modelRef.providerID,
        modelID: modelRef.modelID,
        system: buildProbeSystem({ filePath, fileName }),
        text: buildProbeUserText({ filePath }),
        timeoutMs,
        signal: abort.signal,
      }),
      abort.signal,
    );

    const text = typeof reply === 'string' ? reply : reply?.text;
    const nativeBlocked = Number(reply?.nativeBlocked ?? 0);
    return { ...classify(text, { filePath, fileName, token, nativeBlocked }), elapsedMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
    // 靶子文件和一次性会话都要收拾干净；清理失败绝不能盖住真正的结论
    try {
      await rm(filePath, { force: true });
    } catch (error) {
      onLog(`清理体检临时文件失败：${errorMessage(error)}`);
    }
    if (sessionID) {
      try {
        await client.deleteSession(sessionID);
      } catch (error) {
        onLog(`清理体检会话失败：${errorMessage(error)}`);
      }
    }
  }
}

/**
 * 并发体检一批模型。用 N 个 worker 从共享游标取任务，**真并发**，不是 for 循环串行 await。
 * 任何单个模型失败都只记成 {verdict:'failed'}，绝不许把整批带崩。
 *
 * @param {object} o
 * @param {object} o.client
 * @param {Array} o.models
 * @param {string} o.workdir
 * @param {number} [o.concurrency] 默认 3，上限 6
 * @param {number} [o.timeoutMs]
 * @param {object} [o.cache]   ProbeCache
 * @param {boolean} [o.force]  true = 忽略缓存强制重测
 * @param {string} [o.fingerprint] 缓存指纹；默认 PROBE_FINGERPRINT。
 *   两种上游方案（内嵌/伪装）各自记结论，互不污染——Bridge 按模式传不同的指纹。
 * @param {(p:{done:number,total:number,model:object,result:object})=>void} [o.onProgress]
 * @param {(s:string)=>void} [o.onLog]
 * @returns {Promise<Array<object>>}
 */
export async function probeMany(o = {}) {
  const { client, models, workdir, cache = null, force = false, timeoutMs, onLog, fingerprint = PROBE_FINGERPRINT } = o;
  if (!Array.isArray(models)) {
    throw new BridgeError('体检失败：模型列表必须是数组', 500, 'probe_bad_models');
  }
  const total = models.length;
  const concurrency = clampConcurrency(o.concurrency);
  const results = new Array(total);
  /** 共享游标：worker 同步自增着取任务，天然不会撞车 */
  let cursor = 0;
  let done = 0;

  async function runOne(model) {
    const itemStartedAt = Date.now();
    const ref = resolveModelRef(model);

    if (!force && cache && typeof cache.get === 'function') {
      const hit = safeCacheGet(cache, ref.id, onLog, fingerprint);
      if (hit) {
        return { model, verdict: hit.verdict, note: hit.note, elapsedMs: Date.now() - itemStartedAt, cached: true };
      }
    }

    // 上游 5xx（端点抖动）与语义打偏（模型随机坏运气）当场重试一次：
    // 别让一次运气差把好模型标红（同一口径；超时反映的是负载、
    // 格式错是确定性的——都不属于运气，不重试）
    const retryable = new Set(['upstream_error', 'probe_call_mismatch']);
    let retried = false;
    for (;;) {
      try {
        const outcome = await probe(client, model, { workdir, timeoutMs, onLog });
        await writeCache(outcome.verdict, outcome.note);
        return {
          model,
          verdict: outcome.verdict,
          note: outcome.note,
          elapsedMs: Date.now() - itemStartedAt,
          cached: false,
        };
      } catch (error) {
        if (!retried && retryable.has(error?.code)) {
          retried = true;
          if (typeof onLog === 'function') onLog(`${ref.label} 体检一次失败（${error.code}），当场重试一次`);
          continue;
        }
        // 单个模型失败就是一条 failed，别的模型照跑。失败也写缓存（短 TTL）：
        // 免费池几分钟一换，失败多半是"此刻路由不到"——10 分钟后自动重试就有机会翻案
        const note = `体检失败：${errorMessage(error)}`;
        await writeCache('failed', note);
        return {
          model,
          verdict: 'failed',
          note,
          elapsedMs: Date.now() - itemStartedAt,
          cached: false,
          error,
        };
      }
    }

    /** 写缓存要等它落定（否则测试收尾时写盘还在路上）；失败只记日志，不影响结论 */
    async function writeCache(verdict, note) {
      if (!cache || typeof cache.set !== 'function') return;
      try {
        await cache.set(ref.id, fingerprint, verdict, note);
      } catch (writeError) {
        if (typeof onLog === 'function') onLog(`写体检缓存失败：${errorMessage(writeError)}`);
      }
    }
  }

  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= total) return;

      const model = models[index];
      const result = await runOne(model); // runOne 内部自兜底，不会外抛
      results[index] = result;

      // 下面这段是同步执行的，所以 done 严格从 1 递增到 total，不会有两个任务看到同一个值
      done += 1;
      const snapshot = { done, total, model, result };
      if (typeof o.onProgress === 'function') {
        try {
          o.onProgress(snapshot);
        } catch (error) {
          if (typeof onLog === 'function') onLog(`onProgress 回调出错：${errorMessage(error)}`);
        }
      }
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, total));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/* ------------------------------------------------------------------ *
 * 内部工具
 * ------------------------------------------------------------------ */

/**
 * 等一个 promise，但信号一旦触发就立刻收手。
 * 上游客户端未必会老实响应 signal（比如卡在读响应体），光靠它可能一直挂着，
 * 所以这里自己再兜一层，保证体检任务有去有回、不会把整批拖死。
 */
function withAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** 取中止信号携带的原因；没有原因也给一个能看懂的错 */
function abortReason(signal) {
  if (signal.reason instanceof Error) return signal.reason;
  return new BridgeError('体检超时：模型没有在限定时间内回话', 504, 'probe_timeout');
}

/** 体检用的系统提示。只给一个 read 工具，并要求按信封格式回复。 */function buildProbeSystem({ filePath, fileName }) {
  return [
    '你正在接受一次自动化能力探测。请严格按下面的信封协议回复。',
    '',
    '你有且只有一个外部工具：',
    `- read：读取本机文件。参数 {"filePath":"文件的绝对路径"}`,
    '',
    '回复必须是**一个 JSON 对象**，不要 Markdown 代码围栏，不要在 JSON 前后写任何解释：',
    '{"content":"给用户的文字，可为空串","calls":[{"name":"工具名","arguments":{}}]}',
    '',
    '规则：',
    '1. calls 里只放你“请求调用”的工具，不要假装它们已经执行，也不要编造执行结果。',
    '2. 工具名与参数名必须逐字照抄上面的写法，不许换成相似名字，不许调用不存在的工具。',
    '3. 不需要调用工具时，calls 给空数组。',
    `4. 本次唯一可用的目标文件是 ${fileName}（绝对路径 ${filePath}），不要猜别的路径。`,
  ].join('\n');
}

/** 体检用的用户消息：读靶子文件，说出里面的 token。注意这里**不能**把 token 写进提示词。 */
function buildProbeUserText({ filePath }) {
  return [
    `请用 read 工具读取这个文件：${filePath}`,
    '文件里有一行随机 token（形如 OZ-PROBE-xxxxxxxx）。',
    '把读到的 token 原样告诉我。必须按信封格式回复，不要只描述你打算怎么做。',
    '如果你确实无法调用工具，就只回一句说明，不要编造文件内容。',
  ].join('\n');
}

/**
 * 判定。规则一个字都不放宽：
 *  - 能解析出 JSON，且 calls 里有 name === 'read' 的元素，且它的 arguments 里有字符串值
 *    包含文件名或 token → 'tool'
 *  - 回信不符合信封，但**回合内真调过本机工具**（被审批拦下，client.prompt 的
 *    nativeBlocked 计数）→ 'tool'：转交链路会把它的本机调用翻成客户端工具调用，
 *    这类模型完全能编程；判成 chat 会剥掉工具表、把转交路径也堵死（实测误伤过
 *    nemotron-3.5-lightning）。
 *  - 能解析出 JSON，calls 为空或不存在，但有非空 content → 'chat'
 *  - 根本不是 JSON，但有非空文本 → 'chat'（模型只会说人话）
 *  - 什么都没解析出来、或者明明产生了调用却打偏了目标 → 抛异常（由调用方记为 failed）
 */
function classify(text, { filePath, fileName, token, nativeBlocked = 0 }) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new BridgeError('体检失败：模型没有返回任何文本内容', 502, 'probe_empty_reply');
  }

  const parsed = parseEnvelope(text);

  if (parsed === null) {
    // 根本不是 JSON：模型只会说人话——除非它其实真调过本机工具（转交能兜住）
    if (nativeBlocked > 0) {
      return { verdict: 'tool', note: `会真调本机工具（拦截 ${nativeBlocked} 次），由转交链路兜住，支持编程` };
    }
    return { verdict: 'chat', note: '只能普通对话，已关闭工具' };
  }

  // calls 写了但不是数组：拿不准的东西一律不放过，宁可当失败重测
  const hasCallsKey = parsed.calls !== undefined && parsed.calls !== null;
  if (hasCallsKey && !Array.isArray(parsed.calls)) {
    throw new BridgeError(
      '体检失败：模型回复里的 calls 不是一个数组，没法确认它真的会按协议调用工具',
      502,
      'probe_invalid_output',
    );
  }

  const rawCalls = Array.isArray(parsed.calls) ? parsed.calls : null;
  if (rawCalls && rawCalls.length > 0) {
    const readCall = rawCalls.find((call) => call && typeof call === 'object' && call.name === 'read');
    if (readCall && argumentsMention(readCall.arguments, [filePath, fileName, token])) {
      return { verdict: 'tool', note: '能按协议产生工具调用' };
    }
    // 产生了调用但没打中靶子（工具名不对 / 参数里没有目标文件），这种最容易在真实使用中翻车
    throw new BridgeError(
      '体检失败：模型返回了工具调用，但里面没有指向目标文件的 read 调用（可能编造了路径或工具名）',
      502,
      'probe_call_mismatch',
    );
  }

  if (typeof parsed.content === 'string' && parsed.content.trim() !== '') {
    if (nativeBlocked > 0) {
      return { verdict: 'tool', note: `会真调本机工具（拦截 ${nativeBlocked} 次），由转交链路兜住，支持编程` };
    }
    return { verdict: 'chat', note: '只能普通对话，已关闭工具' };
  }

  throw new BridgeError('体检失败：模型回复里既没有工具调用也没有任何文字内容', 502, 'probe_invalid_output');
}

/**
 * 尝试从回复里解析出信封 JSON。
 * 只接受两种写法：整段就是 JSON，或者整段被一个 Markdown 代码围栏包着。
 * 故意不从大段散文里抠 JSON 片段——那会把“随口提了一句 JSON”当成真产生了调用。
 */
function parseEnvelope(text) {
  const trimmed = text.trim();
  const candidates = [trimmed];

  const fence = trimmed.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/);
  if (fence) candidates.push(fence[1].trim());

  for (const candidate of candidates) {
    let value;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  }
  return null;
}

/** arguments 里的任何一个字符串值（含嵌套）是否包含目标文件名 / 完整路径 / token */
function argumentsMention(args, needles) {
  const strings = collectStrings(args);
  return strings.some((s) => needles.some((needle) => needle && s.includes(needle)));
}

/** 递归收集一个值里所有的字符串（只看值不看键），带深度上限防爆栈 */
function collectStrings(value, out = [], depth = 0) {
  if (depth > 8) return out;
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out, depth + 1);
  }
  return out;
}

/** 从 Model 里取出 providerID / modelID / id；缺 id 时按契约用 `${providerID}/${modelID}` 合成 */
function resolveModelRef(model) {
  const providerID = typeof model?.providerID === 'string' ? model.providerID : '';
  const modelID = typeof model?.modelID === 'string' ? model.modelID : '';
  let id = typeof model?.id === 'string' && model.id ? model.id : '';

  let resolvedProvider = providerID;
  let resolvedModel = modelID;
  if (!resolvedProvider || !resolvedModel) {
    // 兜底：从 `${providerID}/${modelID}` 拆回来（只认第一个斜杠）
    const slash = id.indexOf('/');
    if (slash > 0) {
      if (!resolvedProvider) resolvedProvider = id.slice(0, slash);
      if (!resolvedModel) resolvedModel = id.slice(slash + 1);
    }
  }
  if (!id) id = `${resolvedProvider}/${resolvedModel}`;

  return {
    id,
    providerID: resolvedProvider,
    modelID: resolvedModel,
    label: typeof model?.name === 'string' && model.name ? model.name : id,
  };
}

/** 缓存读取包一层：缓存自己坏掉也不能把体检带崩 */
function safeCacheGet(cache, modelId, onLog, fingerprint = PROBE_FINGERPRINT) {
  try {
    return cache.get(modelId, fingerprint) || null;
  } catch (error) {
    if (typeof onLog === 'function') onLog(`读体检缓存失败：${errorMessage(error)}`);
    return null;
  }
}

function clampConcurrency(value) {
  if (!Number.isFinite(value)) return DEFAULT_CONCURRENCY;
  const n = Math.trunc(value);
  if (n < 1) return DEFAULT_CONCURRENCY;
  return Math.min(n, MAX_CONCURRENCY);
}

function errorMessage(error) {
  if (error && typeof error.message === 'string' && error.message) return error.message;
  return String(error);
}
