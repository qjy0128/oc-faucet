/**
 * 对话会话复用池与历史前缀哈希追踪。
 *
 * 解决无状态客户端（ZCode / Claude Code / Codex 等）每轮请求被重新 createSession +
 * deleteSession 导致的三大问题：
 *   1. 每轮换新 sessionID，打碎上游 x-session-affinity / x-opencode-session KV 缓存；
 *   2. 内嵌模式每轮把整段几十万 token 历史与工具 schema 扁平重喂一遍；
 *   3. 伪装模式每轮退化成单条巨型 user 字符串而非稳定前缀多轮结构。
 *
 * 核心不变量：
 *   - 只有 systemHash 与已发送历史前缀 cumulativeHashes[sentCount - 1] 完全吻合才算延续；
 *   - 客户端发生压缩（/compact）、编辑历史、回溯或分支时立刻自动轮换新会话并全量重发；
 *   - 同一 key 的并发请求串行进入，防止内嵌 OpenCode 会话状态竞态写花；
 *   - 内嵌模式遇到 handoff 中断或上游异常时标记 dirty，下次轮换新会话，绝不遗留半截工具调用。
 */
import { createHash } from 'node:crypto';

export const DEFAULT_MAX_SESSIONS = 200;
export const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;

/** @param {string} value */
export function hashText(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

/** @param {unknown} value */
function canonicalJson(value) {
  if (value === null || value === undefined || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** @param {object} item */
export function serializeHistoryItem(item) {
  if (!item || typeof item !== 'object') return 'null';
  return canonicalJson({
    role: item.role ?? '',
    type: item.type ?? '',
    text: item.text ?? '',
    name: item.name ?? '',
    callId: item.callId ?? '',
    input: item.input ?? null,
    output: item.output ?? null,
    error: item.error === true,
    source: item.source ? { type: item.source.type, media_type: item.source.media_type, url: item.source.url, len: item.source.data?.length ?? 0 } : null,
  });
}

/**
 * 为一次规范化请求计算 system 与逐条滚动历史哈希。
 *
 * @param {string} system
 * @param {Array<object>} history
 * @returns {{ systemHash: string, cumulativeHashes: string[] }}
 */
export function computeConversationHashes(system, history) {
  const systemHash = hashText(system ?? '');
  const list = Array.isArray(history) ? history : [];
  const cumulativeHashes = new Array(list.length);
  let rolling = systemHash;
  for (let i = 0; i < list.length; i += 1) {
    rolling = hashText(`${rolling}|${serializeHistoryItem(list[i])}`);
    cumulativeHashes[i] = rolling;
  }
  return { systemHash, cumulativeHashes };
}

function readHeaderCaseInsensitive(headers, name) {
  if (!headers || typeof headers !== 'object') return null;
  if (typeof headers.get === 'function') return headers.get(name) ?? null;
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target && v !== undefined && v !== null) {
      return Array.isArray(v) ? String(v[0] ?? '') : String(v);
    }
  }
  return null;
}

/**
 * 从请求头或常见客户端字段里提取显式会话提示（如 Anthropic metadata.user_id / prompt_cache_key）。
 *
 * @param {object} o
 * @param {object} [o.body]
 * @param {Record<string,string>} [o.headers]
 * @returns {string|null}
 */
export function extractSessionHint({ body, headers } = {}) {
  const candidates = [
    readHeaderCaseInsensitive(headers, 'x-session-id'),
    readHeaderCaseInsensitive(headers, 'x-opencode-session-id'),
    readHeaderCaseInsensitive(headers, 'x-opencode-session'),
    readHeaderCaseInsensitive(headers, 'anthropic-session-id'),
    typeof body?.metadata?.user_id === 'string' ? body.metadata.user_id : null,
    typeof body?.prompt_cache_key === 'string' ? body.prompt_cache_key : null,
    typeof body?.session_id === 'string' ? body.session_id : null,
    typeof body?.conversation === 'string'
      ? body.conversation
      : (typeof body?.conversation?.id === 'string' ? body.conversation.id : null),
  ];
  for (const c of candidates) {
    const trimmed = typeof c === 'string' ? c.trim() : '';
    if (trimmed && trimmed.length <= 512) return trimmed;
  }
  return null;
}

/**
 * 进程内 LRU 会话复用池。
 */
export class ConversationSessionPool {
  /**
   * @param {object} [o]
   * @param {number} [o.maxEntries]
   * @param {number} [o.idleTtlMs]
   */
  constructor({ maxEntries = DEFAULT_MAX_SESSIONS, idleTtlMs = DEFAULT_IDLE_TTL_MS } = {}) {
    this.maxEntries = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : DEFAULT_MAX_SESSIONS;
    this.idleTtlMs = Number.isFinite(idleTtlMs) && idleTtlMs > 0 ? idleTtlMs : DEFAULT_IDLE_TTL_MS;
    this.entries = new Map();
    this.locks = new Map();
  }

  get size() {
    return this.entries.size;
  }

  /**
   * 生成会话查找键；带上 clientToken 与 systemHash，
   * 保证主对话与摘要/标题副请求不会串线、切换上游后旧 ID 不误用。
   */
  makeKey({ clientToken, modelId, systemHash, firstItemHash, explicitHint }) {
    if (!modelId) return null;
    if (explicitHint) {
      return `exp:${clientToken}:${modelId}:${systemHash}:${hashText(explicitHint)}`;
    }
    if (firstItemHash) {
      return `anc:${clientToken}:${modelId}:${systemHash}:${firstItemHash}`;
    }
    return null;
  }

  /**
   * 同一 key 串行化，防止并行轮次同时读写同一个有状态 OpenCode 会话。
   *
   * @template T
   * @param {string|null} key
   * @param {()=>Promise<T>} fn
   * @returns {Promise<T>}
   */
  async withLock(key, fn) {
    if (!key) return fn();
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const tail = prev.catch(() => {}).then(() => gate);
    this.locks.set(key, tail);
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  /** 清理过期空闲条目，返回需要删除的有状态 sessionID。 */
  pruneExpired(now = Date.now()) {
    const retired = [];
    for (const [key, entry] of this.entries.entries()) {
      if (now - entry.lastUsedAt > this.idleTtlMs) {
        if (entry.stateful && entry.sessionID) retired.push(entry.sessionID);
        this.entries.delete(key);
      }
    }
    return retired;
  }

  /**
   * 尝试获取可复用的上游 sessionID，并判定前缀是否连续。
   *
   * @param {string|null} key
   * @param {object} o
   * @param {boolean} o.stateful
   * @param {string} o.systemHash
   * @param {string[]} o.cumulativeHashes
   * @param {number} [o.now]
   * @returns {{
   *   reuseSessionID: string|null,
   *   sendDeltaFromIndex: number|null,
   *   retiredSessionIDs: string[],
   * }}
   */
  acquire(key, { stateful, systemHash, cumulativeHashes, now = Date.now() }) {
    const retiredSessionIDs = this.pruneExpired(now);
    if (!key) {
      return { reuseSessionID: null, sendDeltaFromIndex: null, retiredSessionIDs };
    }
    const existing = this.entries.get(key);
    if (!existing) {
      return { reuseSessionID: null, sendDeltaFromIndex: null, retiredSessionIDs };
    }

    // 触碰更新 LRU 顺序
    this.entries.delete(key);
    this.entries.set(key, existing);

    const sameSystem = existing.systemHash === systemHash;
    const n = existing.sentCount;
    const prefixMatched =
      sameSystem &&
      n > 0 &&
      cumulativeHashes.length > n &&
      cumulativeHashes[n - 1] === existing.cumulativeHashes[n - 1];

    if (stateful) {
      if (!existing.dirty && existing.stateful && prefixMatched) {
        existing.lastUsedAt = now;
        return {
          reuseSessionID: existing.sessionID,
          sendDeltaFromIndex: n,
          retiredSessionIDs,
        };
      }
      // 历史被压缩/编辑/重放，或者上次 handoff/异常弄脏了会话状态 → 退役旧会话，新起干净会话全量重发
      if (existing.stateful && existing.sessionID) {
        retiredSessionIDs.push(existing.sessionID);
      }
      this.entries.delete(key);
      return { reuseSessionID: null, sendDeltaFromIndex: null, retiredSessionIDs };
    }

    // 无状态上游（如 ZenClient 伪装模式）：没有服务端会话库会脏，只要系于同对话且历史未倒退就继续沿用同一个 ses_ id 命中 KV Cache
    const sameAnchor =
      sameSystem &&
      cumulativeHashes.length >= 1 &&
      existing.cumulativeHashes.length >= 1 &&
      cumulativeHashes[0] === existing.cumulativeHashes[0];
    if (!existing.dirty && !existing.stateful && (prefixMatched || sameAnchor)) {
      existing.lastUsedAt = now;
      return {
        reuseSessionID: existing.sessionID,
        sendDeltaFromIndex: null, // 无状态 HTTP 始终发完整结构化多轮消息，靠稳定 sessionID + 前缀一致命中 KV Cache
        retiredSessionIDs,
      };
    }

    this.entries.delete(key);
    return { reuseSessionID: null, sendDeltaFromIndex: null, retiredSessionIDs };
  }

  /**
   * 一次对话轮次成功后登记/更新状态；返回可能因 LRU 满而被挤出的有状态 sessionID。
   */
  commit(key, { sessionID, stateful, systemHash, cumulativeHashes, dirty = false, now = Date.now() }) {
    if (!key || !sessionID) return [];
    const retired = [];
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, {
      sessionID,
      stateful: stateful === true,
      systemHash,
      cumulativeHashes: [...cumulativeHashes],
      sentCount: cumulativeHashes.length,
      dirty: dirty === true,
      lastUsedAt: now,
    });
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      if (oldest?.stateful && oldest.sessionID && oldest.sessionID !== sessionID) {
        retired.push(oldest.sessionID);
      }
    }
    return retired;
  }

  /** 标记某 key 失效并返回待清理的有状态 sessionID（如上游报 session_not_found 或中断脏态）。 */
  invalidate(key) {
    if (!key) return null;
    const entry = this.entries.get(key);
    this.entries.delete(key);
    return entry?.stateful && entry.sessionID ? entry.sessionID : null;
  }

  /** 停服/重启/切模式时清空池子并返回所有需要销毁的有状态 sessionID。 */
  clear() {
    const retired = [];
    for (const entry of this.entries.values()) {
      if (entry?.stateful && entry.sessionID) retired.push(entry.sessionID);
    }
    this.entries.clear();
    return retired;
  }
}
