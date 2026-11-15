/**
 * 上游限流/额度熔断与错误分类器。
 *
 * 把 OpenCode / Zen 的 429 额度耗尽、地区封锁（403/410）与连续 5xx 故障从普通临时波动里摘出来：
 * 一旦命中硬限制，让同模型进入冷却窗口并在本地直接拦截，返回标准 429 / Retry-After，
 * 避免上游客户端死循环重放、把共享 IP/账号池子在几分钟内打穿。
 */

export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;
export const DEFAULT_BLOCKED_COOLDOWN_MS = 10 * 60 * 1000;
export const DEFAULT_TRANSIENT_COOLDOWN_MS = 2 * 60 * 1000;
export const MIN_RETRY_AFTER_MS = 5_000;
export const DEFAULT_MAX_RETRY_AFTER_MS = 48 * 3600 * 1000;
export const TRANSIENT_FAILURE_THRESHOLD = 3;
export const TRANSIENT_WINDOW_MS = 5 * 60 * 1000;

const RATE_LIMIT_RE =
  /(?:free usage (?:limit|exceeded)|usage limit reached|quota[\s_-]?exceeded|rate[\s_-]?limit|too many requests|daily limit|credits?\s+exhausted|provider\.free-limit|provider\.rate-limit|FreeUsageLimitError|GoUsageLimitError|QuotaExceededError|\b429\b)/i;

const MODEL_BLOCKED_RE =
  /(?:not available in your country|model.*(?:deprecated|retired|unavailable)|zen_forbidden|zen_model_deprecated|地区.*不支持|已弃用)/i;

/**
 * 把上游给出的重试等待时间夹紧到安全范围（保留真实 8h~24h 等日限额冷却窗口，防止被截成 2h）。
 *
 * @param {number|null|undefined} ms
 * @returns {number|null}
 */
export function clampRetryAfterMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.min(DEFAULT_MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, Math.round(ms)));
}

/**
 * 解析 HTTP `retry-after` 响应头（秒数或 HTTP 日期），返回合法区间内的毫秒数或 null。
 *
 * @param {Headers|Record<string,string>|null|undefined} headers
 * @param {number} [now]
 * @returns {number|null}
 */
export function parseRetryAfterMs(headers, now = Date.now()) {
  if (!headers) return null;
  const raw = typeof headers.get === 'function'
    ? (headers.get('retry-after') ?? headers.get('x-ratelimit-reset-after'))
    : (headers['retry-after'] ?? headers['Retry-After'] ?? headers['x-ratelimit-reset-after']);
  if (raw === undefined || raw === null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  const seconds = Number(text);
  let ms = null;
  if (Number.isFinite(seconds) && seconds >= 0) {
    ms = Math.round(seconds * 1000);
  } else {
    const targetMs = Date.parse(text);
    if (Number.isFinite(targetMs)) ms = targetMs - now;
  }
  return clampRetryAfterMs(ms);
}

/**
 * 从上游 JSON 错误体（含嵌套 error/data/response.body）里提取真实重试毫秒数。
 *
 * @param {unknown} body
 * @returns {number|null}
 */
export function extractRetryAfterMsFromBody(body) {
  if (!body) return null;
  let parsed = body;
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  for (const obj of [parsed, parsed.error, parsed.data]) {
    if (!obj || typeof obj !== 'object') continue;
    const ms = Number(obj.retryAfterMs);
    if (Number.isFinite(ms) && ms > 0) return clampRetryAfterMs(ms);
    const sec = Number(obj.retryAfterSeconds ?? obj.retry_after);
    if (Number.isFinite(sec) && sec > 0) return clampRetryAfterMs(sec * 1000);
  }
  const nestedBody = parsed.response?.body ?? parsed.data?.responseBody ?? parsed.error?.response?.body;
  if (typeof nestedBody === 'string' && nestedBody) {
    return extractRetryAfterMsFromBody(nestedBody);
  }
  return null;
}

/**
 * 识别上游错误性质。
 *
 * @param {object} info
 * @param {number} [info.status]
 * @param {string} [info.code]
 * @param {string} [info.message]
 * @param {Headers|Record<string,string>|null} [info.headers]
 * @param {number|null} [info.retryAfterMs]
 * @param {number} [info.now]
 * @returns {{ kind: 'rate_limit'|'model_blocked'|'transient', retryAfterMs: number }}
 */
export function classifyUpstreamError({ status, code, message, headers, retryAfterMs, now = Date.now() } = {}) {
  const text = `${code ?? ''} ${message ?? ''}`;
  if (
    status === 429 ||
    code === 'zen_rate_limited' ||
    code === 'upstream_rate_limited' ||
    code === 'model_rate_limit_cooldown' ||
    RATE_LIMIT_RE.test(text)
  ) {
    return {
      kind: 'rate_limit',
      retryAfterMs: clampRetryAfterMs(retryAfterMs) ?? parseRetryAfterMs(headers, now) ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS,
    };
  }
  if (
    status === 403 ||
    status === 410 ||
    code === 'zen_forbidden' ||
    code === 'zen_model_deprecated' ||
    MODEL_BLOCKED_RE.test(text)
  ) {
    return {
      kind: 'model_blocked',
      retryAfterMs: DEFAULT_BLOCKED_COOLDOWN_MS,
    };
  }
  return {
    kind: 'transient',
    retryAfterMs: DEFAULT_TRANSIENT_COOLDOWN_MS,
  };
}

/**
 * 按模型 ID 跟踪冷却态，避免对已限流或连续失败的模型继续无效打上游。
 */
export class ModelCooldownTracker {
  /**
   * @param {object} [o]
   * @param {number} [o.rateLimitCooldownMs]
   * @param {number} [o.blockedCooldownMs]
   * @param {number} [o.transientCooldownMs]
   * @param {number} [o.transientThreshold]
   */
  constructor(o = {}) {
    this.rateLimitCooldownMs = Number.isFinite(o.rateLimitCooldownMs) && o.rateLimitCooldownMs > 0
      ? o.rateLimitCooldownMs
      : DEFAULT_RATE_LIMIT_COOLDOWN_MS;
    this.blockedCooldownMs = Number.isFinite(o.blockedCooldownMs) && o.blockedCooldownMs > 0
      ? o.blockedCooldownMs
      : DEFAULT_BLOCKED_COOLDOWN_MS;
    this.transientCooldownMs = Number.isFinite(o.transientCooldownMs) && o.transientCooldownMs > 0
      ? o.transientCooldownMs
      : DEFAULT_TRANSIENT_COOLDOWN_MS;
    this.transientThreshold = Number.isInteger(o.transientThreshold) && o.transientThreshold > 0
      ? o.transientThreshold
      : TRANSIENT_FAILURE_THRESHOLD;
    this.entries = new Map();
    this.lastRateLimitAt = 0;
  }

  /**
   * @param {string} modelId
   * @param {number} [now]
   * @returns {{ until: number, remainingMs: number, kind: string, reason: string } | null}
   */
  get(modelId, now = Date.now()) {
    if (!modelId) return null;
    const entry = this.entries.get(modelId);
    if (!entry || !entry.until) return null;
    if (entry.until <= now) {
      this.entries.delete(modelId);
      return null;
    }
    return {
      until: entry.until,
      remainingMs: entry.until - now,
      kind: entry.kind,
      reason: entry.reason,
    };
  }

  /** @param {string} modelId */
  recordSuccess(modelId) {
    if (!modelId) return;
    this.entries.delete(modelId);
  }

  /**
   * 记录一次上游失败；返回本次是否触发或延长了冷却。
   *
   * @param {string} modelId
   * @param {object} info
   * @param {number} [now]
   * @returns {{ tripped: boolean, kind: string, until: number|null, remainingMs: number, reason: string }}
   */
  recordError(modelId, info = {}, now = Date.now()) {
    const classified = classifyUpstreamError({ ...info, now });
    const reason = typeof info.message === 'string' && info.message ? info.message : '上游限流或服务异常';

    if (classified.kind === 'rate_limit') {
      const duration = Math.max(classified.retryAfterMs, this.rateLimitCooldownMs === DEFAULT_RATE_LIMIT_COOLDOWN_MS ? classified.retryAfterMs : this.rateLimitCooldownMs);
      const until = now + duration;
      this.lastRateLimitAt = now;
      this.entries.set(modelId, {
        kind: 'rate_limit',
        until,
        reason,
        consecutiveFailures: 0,
        lastFailureAt: now,
      });
      return { tripped: true, kind: 'rate_limit', until, remainingMs: until - now, reason };
    }

    if (classified.kind === 'model_blocked') {
      const until = now + this.blockedCooldownMs;
      this.entries.set(modelId, {
        kind: 'model_blocked',
        until,
        reason,
        consecutiveFailures: 0,
        lastFailureAt: now,
      });
      return { tripped: true, kind: 'model_blocked', until, remainingMs: until - now, reason };
    }

    const prev = this.entries.get(modelId);
    const withinWindow = prev && now - (prev.lastFailureAt ?? 0) <= TRANSIENT_WINDOW_MS;
    const count = withinWindow ? (prev.consecutiveFailures ?? 0) + 1 : 1;
    if (count >= this.transientThreshold) {
      const until = now + this.transientCooldownMs;
      this.entries.set(modelId, {
        kind: 'transient',
        until,
        reason,
        consecutiveFailures: count,
        lastFailureAt: now,
      });
      return { tripped: true, kind: 'transient', until, remainingMs: until - now, reason };
    }
    this.entries.set(modelId, {
      kind: 'transient',
      until: 0,
      reason,
      consecutiveFailures: count,
      lastFailureAt: now,
    });
    return { tripped: false, kind: 'transient', until: null, remainingMs: 0, reason };
  }

  /**
   * 最近是否有过全局/免费池限流命中（用来暂停空闲后台自动重测，避免继续烧 IP 额度）。
   *
   * @param {number} [now]
   * @param {number} [windowMs]
   */
  hasRecentRateLimit(now = Date.now(), windowMs = this.rateLimitCooldownMs) {
    return this.lastRateLimitAt > 0 && now - this.lastRateLimitAt < windowMs;
  }

  clearAll() {
    this.entries.clear();
    this.lastRateLimitAt = 0;
  }
}
