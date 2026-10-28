/**
 * 伪装模式的上游客户端：直连 zen 免费池，请求逐字节模仿 OpenCode 客户端。
 *
 * 与 OcClient（内嵌模式）暴露同一套接口——providers / createSession / prompt /
 * deleteSession / ready / baseUrl / stop——Bridge 按设置择一使用，信封协议、
 * 转交、体检、目标写入全部复用。两者的差别只在运输层：
 *
 *   - 没有子进程、没有会话状态、没有审批闸门；
 *   - 门禁靠伪装头 + 桩工具 + 永远流式过（规则见 zen-impersonate.js 顶部注释）；
 *   - 模型若真调 bash/read 桩，调用会以**结构化 tool_call** 回到响应里
 *     （内嵌模式要走 SSE 事件流才拿得到），直接喂转交映射即可；
 *   - 绝不带任何用户凭据：永远匿名 public（隔离初衷不变）。
 *
 * 当前限制：
 *   - 推理档位（variant）不透传——各方言的档位参数没有实测依据，宁可走默认；
 *   - Gemini 族的模型从伪装目录剔除（generateContent 方言不做）；
 *   - 每次调用自成一话（新 ses_ id），不做按对话的会话亲和（缓存命中让位于正确性）。
 */
import { BridgeError } from './errors.js';
import { rejectFeedback } from './handoff.js';
import {
  MODELS_DEV_URL,
  OPENCODE_ANONYMOUS_KEY,
  createSessionRegistry,
  impersonationHeaders,
  openCodeNewID,
  stubTools,
} from './zen-impersonate.js';

/** 单次上游调用的默认等待 */
const DEFAULT_PROMPT_TIMEOUT_MS = 180_000;
/** 目录拉取的等待 */
const CATALOG_TIMEOUT_MS = 30_000;

/**
 * @param {object} [o]
 * @param {string} [o.baseUrl]     zen 根地址（默认 https://opencode.ai；测试注本地桩）
 * @param {string} [o.modelsDevUrl] 目录源（默认 models.dev；测试注本地桩）
 * @param {(line:string)=>void} [o.onLog]
 */
export class ZenClient {
  constructor(o = {}) {
    // 环境变量覆盖留给测试与排障：把两个源指到本地桩，不触公网
    const base = (
      typeof o.baseUrl === 'string' && o.baseUrl ? o.baseUrl : process.env.OCF_ZEN_BASE ?? 'https://opencode.ai'
    ).replace(/\/+$/, '');
    this.modelsDevUrl =
      typeof o.modelsDevUrl === 'string' && o.modelsDevUrl ? o.modelsDevUrl : process.env.OCF_MODELS_DEV_URL ?? MODELS_DEV_URL;
    this.inferenceRoot = `${base}/inference`;
    this.openAiRoot = `${base}/inference/openai`;
    this.onLog = typeof o.onLog === 'function' ? o.onLog : () => {};

    this.#started = false;
    /** modelID → 方言（'chat' | 'anthropic' | 'responses'），providers() 时刷新 */
    this.#dialects = new Map();
    /** seed → 真 ses_ id（目录等非会话调用各领一个；合法 ses_ 原样复用） */
    this.#sessions = createSessionRegistry();
  }

  #started;
  #dialects;
  #sessions;

  /** 与 OcClient 同名属性对齐：伪装模式没有隔离子进程，这个值让上下文覆盖功能整体关闭 */
  get isolate() {
    return false;
  }

  get ready() {
    return this.#started;
  }

  /** 面板展示用：上游地址（伪装模式就是 zen 的推理口） */
  get baseUrl() {
    return `${this.openAiRoot}/v1`;
  }

  /** 没有进程可起；目录懒拉，第一次 providers() 才触网 */
  async start() {
    this.#started = true;
  }

  async stop() {
    this.#started = false;
  }

  _log(line) {
    try {
      this.onLog(String(line));
    } catch {
      /* 调用方的日志回调炸了不该拖垮我们 */
    }
  }

  /* ------------------------------------------------------------------ */
  /* 目录                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * 模型目录，产出与内嵌模式 `/config/providers` 完全同款的形状：
   * provider id 仍是 `opencode`、模型 id 仍是 `opencode/<modelID>`——
   * 切模式后各接入目标与客户端配置一个都不用改。
   *
   * 主源 models.dev（价格/窗口/模态/每模型协议标注都在）；
   * 它没有 opencode 条目时退 zen 自己的 /models（信息不全，免费判定退化为
   * `-free` 后缀 + 已知免费 id 白名单——Magpie 同款口径）。
   */
  async providers() {
    let rawModels = null;
    try {
      rawModels = await this.#modelsFromModelsDev();
    } catch (error) {
      this._log(`[伪装] models.dev 目录拉取失败，退 zen 实时清单：${error?.message ?? error}`);
    }
    if (!rawModels) rawModels = await this.#modelsFromZen();

    const models = {};
    let skippedGemini = 0;
    for (const { modelID, raw, dialect } of rawModels) {
      if (dialect === 'gemini') {
        skippedGemini += 1;
        continue; // v1 不做 generateContent 方言
      }
      this.#dialects.set(modelID, dialect);
      models[modelID] = raw;
    }
    if (skippedGemini) {
      this._log(`[伪装] ${skippedGemini} 个 Gemini 族模型不支持伪装直连，已从目录剔除`);
    }
    if (!Object.keys(models).length) {
      throw new BridgeError(
        '伪装模式没拿到任何模型目录（models.dev 与 zen 都没给）。稍后重试，或切回内嵌模式。',
        502,
        'zen_catalog_empty',
      );
    }
    return { providers: [{ id: 'opencode', name: 'OpenCode Zen（伪装直连）', models }] };
  }

  /** models.dev 的 opencode 条目 → 原始模型数组（含方言标注） */
  async #modelsFromModelsDev() {
    const res = await fetch(this.modelsDevUrl, { signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) });
    if (!res.ok) {
      throw new BridgeError(`models.dev HTTP ${res.status}`, 502, 'zen_catalog_error');
    }
    const all = await res.json();
    const entry = all && typeof all === 'object' ? all.opencode : null;
    const models = entry && typeof entry === 'object' ? entry.models : null;
    if (!models || typeof models !== 'object') return null;

    const out = [];
    for (const [modelID, m] of Object.entries(models)) {
      if (!m || typeof m !== 'object') continue;
      const npm = m.provider?.npm;
      const dialect =
        npm === '@ai-sdk/anthropic' ? 'anthropic' : npm === '@ai-sdk/openai' ? 'responses' : npm === '@ai-sdk/google' ? 'gemini' : 'chat';
      // 价格信息缺失按收费处理：把未知价格说成免费才是危险的方向
      const cost = m.cost && typeof m.cost === 'object' ? m.cost : null;
      const raw = {
        id: modelID,
        name: typeof m.name === 'string' && m.name ? m.name : modelID,
        reasoning: m.reasoning === true,
        modalities: m.modalities && typeof m.modalities === 'object' ? m.modalities : undefined,
        limit: m.limit && typeof m.limit === 'object' ? m.limit : undefined,
        status: m.status === 'deprecated' ? 'deprecated' : 'active',
        ...(cost
          ? {
              cost: {
                input: cost.input ?? 1,
                output: cost.output ?? 1,
                cache: { read: cost.cache_read ?? cost.cacheRead ?? 0, write: cost.cache_write ?? cost.cacheWrite ?? 0 },
              },
            }
          : { cost: { input: 1, output: 1, cache: { read: 0, write: 0 } } }),
      };
      out.push({ modelID, raw, dialect });
    }
    return out;
  }

  /** zen 自己的 /models 实时清单（信息不全时的退路；免费判定退化为后缀+白名单） */
  async #modelsFromZen() {
    const res = await this.#zenFetch(`${this.openAiRoot}/v1/models`, { session: 'catalog' });
    if (!res.ok) {
      throw new BridgeError(
        `问 zen 要模型清单失败（HTTP ${res.status}）：${res.text.slice(0, 200)}`,
        502,
        'zen_catalog_error',
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(res.text);
    } catch {
      throw new BridgeError('zen 的模型清单不是合法 JSON。', 502, 'zen_catalog_error');
    }
    const list = Array.isArray(parsed?.data) ? parsed.data : [];
    const freeIds = new Set(['big-pickle', 'grok-code']); // 名字不带 -free 但确实免费（Magpie 实测）
    return list
      .map((m) => String(m?.id ?? ''))
      .filter(Boolean)
      .map((modelID) => {
        const freeGuess = modelID.endsWith('-free') || freeIds.has(modelID);
        return {
          modelID,
          dialect: 'chat',
          raw: {
            id: modelID,
            name: modelID,
            ...(freeGuess ? { cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } } : { cost: { input: 1, output: 1, cache: { read: 0, write: 0 } } }),
          },
        };
      });
  }

  /* ------------------------------------------------------------------ */
  /* 会话（假会话：只为对齐 OcClient 接口，上游本就无状态）                 */
  /* ------------------------------------------------------------------ */

  /** 造一个真形状的 ses_ id 当会话号；上游按它做路由/缓存，用完即弃 */
  async createSession() {
    return openCodeNewID('ses', { descending: true });
  }

  /** 上游无会话可删；保留接口对齐，失败也不该有人在乎 */
  async deleteSession() {}

  /** 伪装模式没有 OpenCode 全局配置可写；明确拒绝而不是假装成功 */
  async setModelContextWindows() {
    throw new BridgeError(
      '伪装模式直连 zen，没有可以修改上下文长度的 OpenCode 配置。切回内嵌模式后再改。',
      409,
      'context_window_unsupported_mode',
    );
  }

  /* ------------------------------------------------------------------ */
  /* prompt                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * 发一条消息并收齐回复（上游永远流式，收齐再还）。接口与 OcClient.prompt 一致。
   * @param {object} o 同 OcClient.prompt（sessionID/providerID/modelID/system/text/
   *                   variant/handoff/timeoutMs/signal）
   * @returns {Promise<{text:string, tokens:object|null, handoff:{name:string,arguments:object}|null}>}
   */
  async prompt(o = {}) {
    const {
      sessionID,
      modelID,
      system,
      text,
      variant,
      handoff,
      timeoutMs = DEFAULT_PROMPT_TIMEOUT_MS,
      signal,
    } = o;
    if (typeof modelID !== 'string' || !modelID) {
      throw new BridgeError('伪装模式调用缺 modelID。', 400, 'invalid_request');
    }
    if (typeof variant === 'string' && variant) {
      // 已知限制：各方言的档位参数没有实测依据，透传怕被上游拒收，走模型默认
      this._log(`[伪装] 忽略推理档位 ${variant}（v1 不透传档位，按模型默认跑）`);
    }

    const dialect = this.#dialects.get(modelID) ?? 'chat';
    const messages = this.#seedMessages(dialect, { system, text });

    const first = await this.#round(dialect, modelID, sessionID, messages, { timeoutMs, signal });
    const stubCalls = first.calls.filter((call) => call.name === 'bash' || call.name === 'read');
    if (!stubCalls.length) {
      return { text: first.text, tokens: first.tokens, handoff: null, nativeBlocked: 0 };
    }

    // 模型真调了桩工具：先试转交（native 名和参数恰好就是映射表认的原生形状）
    if (typeof handoff === 'function') {
      for (const call of stubCalls) {
        let translated = null;
        try {
          translated = handoff({ native: call.name, input: call.arguments });
        } catch {
          translated = null; // 回调炸了按翻译失败走
        }
        if (translated && typeof translated.name === 'string' && translated.arguments && typeof translated.arguments === 'object') {
          this._log(`[伪装] 转交：模型桩调用 ${call.name} → 客户端 ${translated.name}`);
          return { text: '', tokens: first.tokens, handoff: { name: translated.name, arguments: translated.arguments }, nativeBlocked: stubCalls.length };
        }
      }
    }

    // 翻不了：纠正一轮——把桩调用原样认领，回一条点名工具的反馈，请它按信封说话
    const corrected = await this.#round(
      dialect,
      modelID,
      sessionID,
      this.#appendStubExchange(dialect, messages, stubCalls),
      { timeoutMs, signal },
    );
    // 纠正后仍调桩：不再抛错（内嵌模式对反复真调也宽容——每笔都拒、回合照常结束）。
    // 带着计数返回，交由上层裁决：体检据此判 tool（它确实会调工具），
    // 真实流量里信封解析自会给出答案或明确的错误。
    return {
      text: corrected.text,
      tokens: corrected.tokens,
      handoff: null,
      nativeBlocked: stubCalls.length + corrected.calls.length,
    };
  }

  /* ------------------------------------------------------------------ */
  /* 内部：一轮请求                                                      */
  /* ------------------------------------------------------------------ */

  /** 按方言拼初始消息（信封 system + 一条 user 文本；历史已摊平在信封文本里） */
  #seedMessages(dialect, { system, text }) {
    if (dialect === 'anthropic') {
      return { system: system ?? '', messages: [{ role: 'user', content: text }] };
    }
    if (dialect === 'responses') {
      return { instructions: system ?? '', input: text };
    }
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: text });
    return { messages };
  }

  /** 纠正轮：把模型的桩调用认领下来，回一条点名工具、指回信封的反馈（与内嵌模式同款文案） */
  #appendStubExchange(dialect, seed, calls) {
    const feedback = calls
      .map((call) => rejectFeedback(call.name, '本次请求没有申报与之对应的外部工具'))
      .join('\n');
    if (dialect === 'anthropic') {
      return {
        system: seed.system,
        messages: [
          ...seed.messages,
          { role: 'assistant', content: calls.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments })) },
          { role: 'user', content: calls.map((call) => ({ type: 'tool_result', tool_use_id: call.id, content: feedback, is_error: true })) },
        ],
      };
    }
    if (dialect === 'responses') {
      return {
        instructions: seed.instructions,
        input: [
          seed.input,
          ...calls.map((call) => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) })),
          ...calls.map((call) => ({ type: 'function_call_output', call_id: call.id, output: feedback })),
        ],
      };
    }
    return {
      messages: [
        ...seed.messages,
        {
          role: 'assistant',
          content: null,
          tool_calls: calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })),
        },
        ...calls.map((call) => ({ role: 'tool', tool_call_id: call.id, content: feedback })),
      ],
    };
  }

  /** 按方言拼请求体并打出去，收齐流式回复 */
  async #round(dialect, modelID, session, seed, { timeoutMs, signal }) {
    const body = {
      model: modelID,
      stream: true,
      ...(dialect === 'chat' ? { stream_options: { include_usage: true } } : {}),
      ...(dialect === 'anthropic'
        ? { system: seed.system, messages: seed.messages, max_tokens: 8192 }
        : dialect === 'responses'
          ? { instructions: seed.instructions, input: seed.input, max_output_tokens: 8192 }
          : { messages: seed.messages }),
      tools: stubTools(dialect),
    };
    const url =
      dialect === 'anthropic'
        ? `${this.inferenceRoot}/v1/messages`
        : dialect === 'responses'
          ? `${this.openAiRoot}/v1/responses`
          : `${this.openAiRoot}/v1/chat/completions`;

    const res = await this.#zenFetch(url, { method: 'POST', body, session, dialect, timeoutMs, signal });
    if (!res.ok) throw this.#mapUpstreamError(res.status, res.text);
    const gathered = this.#gather(dialect, res.text);
    if (!gathered.events) {
      throw new BridgeError(
        `zen 返回了 HTTP 200 但没有任何流式事件，看不懂它给了什么：${res.text.slice(0, 200)}`,
        502,
        'zen_empty_stream',
      );
    }
    return gathered;
  }

  /**
   * 按方言带对应版本的伪装头（收齐整个响应体；上游是流式的，但我们本就要收全再还）。
   * session 可以是真 ses_ id（原样复用），也可以是任意 seed（注册表换真形状的）。
   */
  async #zenFetch(url, { method = 'GET', body, session, dialect = 'chat', timeoutMs = 30_000, signal } = {}) {
    const sessionID = this.#sessions.forSeed(session ?? '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new BridgeError(`等 zen 响应超过 ${Math.round(timeoutMs / 1000)} 秒，已放弃。`, 504, 'upstream_timeout')), timeoutMs);
    const relay = () => {
      if (!controller.signal.aborted) controller.abort(signal?.reason);
    };
    if (signal) {
      if (signal.aborted) relay();
      else signal.addEventListener('abort', relay, { once: true });
    }
    try {
      const res = await fetch(url, {
        method,
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...impersonationHeaders(sessionID, { legacy: dialect === 'anthropic' }),
          // 匿名密钥按方言带（anthropic 多 x-api-key 和版本头）；
          // 这里绝不带任何用户凭据
          ...this.#authHeadersFor(dialect),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, ok: res.ok, text };
    } catch (error) {
      if (signal?.aborted) {
        throw new BridgeError('请求被调用方取消。', 499, 'client_closed_request');
      }
      if (error instanceof BridgeError) throw error;
      throw new BridgeError(
        `连不上 zen（${url}）：${error?.message ?? error}。请检查网络，或切回内嵌模式。`,
        502,
        'upstream_unreachable',
      );
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', relay);
    }
  }

  #authHeadersFor(dialect) {
    const headers = { authorization: `Bearer ${OPENCODE_ANONYMOUS_KEY}` };
    if (dialect === 'anthropic') {
      headers['x-api-key'] = OPENCODE_ANONYMOUS_KEY;
      headers['anthropic-version'] = '2023-06-01';
    }
    return headers;
  }

  /** 把上游的失败翻成能看懂的人话；原文保留片段 */
  #mapUpstreamError(status, text) {
    const detail = this.#errorDetail(text);
    if (status === 403) {
      return new BridgeError(
        `zen 拒绝了这次免费请求${detail ? `（${detail}）` : ''}。模型可能刚被轮下线，或者请求形状被认出；可以稍后重试，或切回内嵌模式。`,
        502,
        'zen_forbidden',
      );
    }
    if (status === 426) {
      return new BridgeError(
        `zen 停收当前伪装的 OpenCode 版本${detail ? `（${detail}）` : ''}。需要更新 src/zen-impersonate.js 里的 OPENCODE_VERSION。`,
        502,
        'zen_version_rejected',
      );
    }
    if (status === 410) {
      return new BridgeError(`这个模型已被 zen 弃用${detail ? `：${detail}` : ''}。请换一个模型（目录刷新后会反映）。`, 502, 'zen_model_deprecated');
    }
    if (status === 429) {
      return new BridgeError(`zen 限流了${detail ? `（${detail}）` : ''}。稍等片刻再试。`, 429, 'zen_rate_limited');
    }
    return new BridgeError(`模型这次没能给出回答（zen HTTP ${status}）${detail ? `：${detail}` : '，上游没有给出可读的说明'}`, 502, 'upstream_error');
  }

  /** 两种错误体都见过：{error:{message}} 与 {type:'error',error:{message}} */
  #errorDetail(text) {
    try {
      const parsed = JSON.parse(text);
      const err = parsed?.error ?? parsed;
      const message = err?.message ?? err?.data?.message;
      if (typeof message === 'string' && message.trim()) return message.slice(0, 300);
      if (typeof err?.type === 'string' && err.type) return err.type;
    } catch {
      /* 不是 JSON 就用原文 */
    }
    return typeof text === 'string' && text.trim() ? text.slice(0, 300) : '';
  }

  /* ------------------------------------------------------------------ */
  /* 内部：流式回复收齐（三种方言）                                        */
  /* ------------------------------------------------------------------ */

  /** 统一产出 {text, calls:[{id,name,arguments}], tokens, events} */
  #gather(dialect, raw) {
    const events = [];
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        events.push(JSON.parse(data));
      } catch {
        /* 单条事件坏掉不影响其余 */
      }
    }
    if (dialect === 'anthropic') return { ...this.#gatherAnthropic(events), events: events.length };
    if (dialect === 'responses') return { ...this.#gatherResponses(events), events: events.length };
    return { ...this.#gatherChat(events), events: events.length };
  }

  /** chat completions：choices[0].delta.content / delta.tool_calls / usage */
  #gatherChat(events) {
    let text = '';
    let tokens = null;
    const calls = [];
    for (const chunk of events) {
      if (chunk.usage) tokens = this.#chatTokens(chunk.usage);
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === 'string') text += delta.content;
      for (const call of delta.tool_calls ?? []) {
        const index = typeof call.index === 'number' ? call.index : calls.length;
        const slot = calls[index] ?? { id: '', name: '', args: '' };
        if (call.id) slot.id = call.id;
        if (call.function?.name) slot.name += call.function.name;
        if (call.function?.arguments) slot.args += call.function.arguments;
        calls[index] = slot;
      }
    }
    return { text, calls: this.#parseCalls(calls), tokens };
  }

  #chatTokens(usage) {
    return {
      input: usage.prompt_tokens ?? 0,
      output: usage.completion_tokens ?? 0,
      cache: { read: usage.prompt_tokens_details?.cached_tokens ?? 0, write: 0 },
      reasoning: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    };
  }

  /** Anthropic Messages：content_block_start/delta（text 与 input_json_delta）、message_* 带 usage */
  #gatherAnthropic(events) {
    let text = '';
    let tokens = null;
    const blocks = [];
    for (const ev of events) {
      const kind = ev?.type;
      if (kind === 'message_start') {
        const usage = ev.message?.usage;
        if (usage) tokens = { input: usage.input_tokens ?? 0, output: 0, cache: { read: usage.cache_read_input_tokens ?? 0, write: usage.cache_creation_input_tokens ?? 0 } };
      } else if (kind === 'content_block_start') {
        const block = ev.content_block ?? {};
        blocks[ev.index ?? blocks.length] = { type: block.type, id: block.id ?? '', name: block.name ?? '', text: '', args: '' };
      } else if (kind === 'content_block_delta') {
        const slot = blocks[ev.index];
        if (!slot) continue;
        const delta = ev.delta ?? {};
        if (delta.type === 'text_delta' && typeof delta.text === 'string') slot.text += delta.text;
        if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') slot.args += delta.partial_json;
      } else if (kind === 'message_delta') {
        const usage = ev.usage;
        if (usage && tokens) {
          tokens.output = usage.output_tokens ?? tokens.output;
          if (usage.cache_read_input_tokens !== undefined) tokens.cache.read = usage.cache_read_input_tokens;
        } else if (usage) {
          tokens = { input: 0, output: usage.output_tokens ?? 0, cache: { read: 0, write: 0 } };
        }
      }
    }
    for (const slot of blocks) {
      if (!slot) continue;
      if (slot.type === 'text') text += slot.text;
    }
    const calls = blocks
      .filter((slot) => slot && slot.type === 'tool_use')
      .map((slot) => ({ id: slot.id, name: slot.name, arguments: this.#parseArguments(slot.args) }));
    return { text, calls, tokens };
  }

  /** OpenAI Responses：response.output_text.delta / function_call_arguments.delta / response.completed */
  #gatherResponses(events) {
    let text = '';
    let tokens = null;
    const calls = new Map(); // item_id → {id,name,args}
    for (const ev of events) {
      const kind = ev?.type;
      if (kind === 'response.output_text.delta' && typeof ev.delta === 'string') {
        text += ev.delta;
      } else if (kind === 'response.output_item.added' && ev.item?.type === 'function_call') {
        calls.set(ev.item.id ?? ev.item.call_id ?? String(calls.size), {
          id: ev.item.call_id ?? ev.item.id ?? '',
          name: ev.item.name ?? '',
          args: typeof ev.item.arguments === 'string' ? ev.item.arguments : '',
        });
      } else if (kind === 'response.function_call_arguments.delta') {
        const key = ev.item_id ?? '';
        const slot = calls.get(key);
        if (slot && typeof ev.delta === 'string') slot.args += ev.delta;
      } else if (kind === 'response.completed') {
        const usage = ev.response?.usage;
        if (usage) {
          tokens = {
            input: usage.input_tokens ?? 0,
            output: usage.output_tokens ?? 0,
            cache: { read: usage.input_tokens_details?.cached_tokens ?? 0, write: 0 },
            reasoning: usage.output_tokens_details?.reasoning_tokens ?? 0,
          };
        }
      }
    }
    return { text, calls: this.#parseCalls([...calls.values()]), tokens };
  }

  /** 桩调用的参数是字符串形式的 JSON，收齐后统一解开 */
  #parseCalls(slots) {
    return slots
      .filter(Boolean)
      .map((slot) => ({ id: slot.id || `call_${slot.name}`, name: slot.name, arguments: this.#parseArguments(slot.args) }));
  }

  #parseArguments(args) {
    if (!args) return {};
    try {
      const parsed = JSON.parse(args);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {}; // 参数解不开当空对象：转交映射自会因必填缺失而放弃
    }
  }
}
