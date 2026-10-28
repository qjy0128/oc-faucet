/**
 * OpenCode 子进程与 HTTP 客户端。
 *
 * 本模块负责「把 opencode serve 这头牛牵好」：
 *   - 找到可执行文件、起服务、等它健康、退出时把进程树收拾干净；
 *   - 把上面几件事包成几个直白的 HTTP 方法给上层用。
 *
 * 两条实测得来的硬规矩（不要"优化"掉）：
 *   1. opencode 1.19.3 的 `--port 0` **不会**随机分配端口，而是回落到固定 4096。
 *      所以这里先用 net 模块探一个真正空闲的端口，再显式传进去。
 *   2. 上游出错时不一定走 `info.error`：模型/供应商不存在会直接回 HTTP 500，
 *      body 形如 `{"name":"UnknownError","data":{"message":"..."}}`，且完全没有 `info`。
 *      因此非 2xx 响应必须当成失败抛出，否则会返回空文本、让上层以为模型答了个空。
 */
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import net from 'node:net';
import { BridgeError } from './errors.js';
import { handoffInput, rejectFeedback } from './handoff.js';
import { permissionPayload, promptPayload, providersPayload } from './oc-v2.js';
import {
  basicAuthHeader,
  buildIsolatedEnv,
  ensureRuntimeDirs,
  isolatedConfig,
  randomPassword,
  runtimeRoot,
  ISOLATED_AGENT,
} from './oc-isolation.js';

/** 等健康检查的总时长 */
const DEFAULT_READY_TIMEOUT_MS = 30_000;
/** 单条消息的默认等待时长 */
const DEFAULT_PROMPT_TIMEOUT_MS = 180_000;
/** SIGTERM 之后给多少毫秒，再不退就 SIGKILL */
const KILL_GRACE_MS = 3_000;
/** 健康检查轮询间隔 */
const POLL_INTERVAL_MS = 250;

/** Windows 的 .cmd/.bat 不是可执行映像，必须经 shell；给路径加引号保住其中的空格。 */
function spawnOpencode(found, args, options = {}) {
  const shell = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(found);
  return spawn(shell ? `"${found}"` : found, args, { ...options, shell });
}

/** Windows 没有 POSIX 信号语义，taskkill /T 才能把 cmd.exe 下面的 OpenCode 一起收掉。 */
function killWindowsTree(child) {
  return new Promise((resolve) => {
    if (!child?.pid) {
      try { child?.kill(); } catch {}
      resolve();
      return;
    }
    let killer;
    let settled = false;
    const timer = setTimeout(finish, KILL_GRACE_MS);
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    }
    try {
      killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      killer.once('error', finish);
      killer.once('exit', finish);
    } catch {
      finish();
    }
  });
}

/** 在起服务前读主版本：v1/v2 的启动参数和 HTTP API 不能混用。 */
function detectOpencodeMajor(found) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnOpencode(found, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new BridgeError(`读取 OpenCode 版本失败：${error?.message ?? error}。`, 500, 'runtime_missing'));
      return;
    }
    let output = '';
    let settled = false;
    const finish = (error, major) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(major);
    };
    const timer = setTimeout(() => {
      if (process.platform === 'win32') void killWindowsTree(child);
      else child.kill();
      finish(new BridgeError(`读取 OpenCode 版本超时。请确认 ${found} 能正常执行。`, 500, 'runtime_missing'));
    }, 5_000);
    child.stdout?.on('data', (chunk) => { output = `${output}${chunk}`.slice(-4_000); });
    child.stderr?.on('data', (chunk) => { output = `${output}${chunk}`.slice(-4_000); });
    child.once('error', (error) => {
      finish(new BridgeError(`读取 OpenCode 版本失败：${error.message}。请确认 ${found} 能正常执行。`, 500, 'runtime_missing'));
    });
    child.once('exit', (code) => {
      const match = /\bv?(\d+)\.\d+(?:\.\d+)?/.exec(output);
      if (code === 0 && match) {
        finish(null, Number(match[1]));
        return;
      }
      finish(new BridgeError(
        `无法识别 OpenCode 版本（退出码 ${code}）：${output.trim() || '没有版本输出'}`,
        500,
        'runtime_missing',
      ));
    });
  });
}

/** 日志行里抓实际端口用；两种写法都认 */
const PORT_PATTERNS = [
  /listening on https?:\/\/[^:]+:(\d+)/i,
  /https?:\/\/127\.0\.0\.1:(\d{2,5})/,
  /port[^0-9]{0,12}(\d{2,5})/i,
];

/**
 * 按契约顺序找出 opencode 可执行文件。
 *
 * 注意最后一次"找 PATH"必须真的挨个目录去看，不能因为系统里有 PATH 就认定它存在——
 * 否则用户没装 OpenCode 时我们会假装找到了，然后在 spawn 阶段才炸得莫名其妙。
 *
 * @param {string|undefined} explicit
 * @returns {{found: string|null, searched: string[]}}
 */
function discoverOpencode(explicit, pathEnv = process.env.PATH ?? '', home = homedir()) {
  const searched = [];
  const named = (value) => typeof value === 'string' && value.length > 0;
  const windows = process.platform === 'win32';

  const tryFile = (candidate) => {
    if (!named(candidate)) return null;
    searched.push(candidate);
    // Windows 的 X_OK 只看文件是否存在，无扩展名的 bash shim 必须在这里挡掉
    if (windows && !/\.(?:exe|cmd|bat)$/i.test(candidate)) return null;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      return null;
    }
  };

  // 1) 显式指定
  const explicitHit = tryFile(explicit);
  if (explicitHit) return { found: explicitHit, searched };

  // 2) 环境变量
  const envHit = tryFile(process.env.OCF_OPENCODE_PATH);
  if (envHit) return { found: envHit, searched };

  // 3) 家目录下的默认安装位置
  const homeHit = tryFile(join(home, '.opencode', 'bin', windows ? 'opencode.exe' : 'opencode'));
  if (homeHit) return { found: homeHit, searched };

  const pathDirs = pathEnv.split(delimiter).filter(named);
  if (windows) {
    // npm 的外层 .cmd 只是启动器，真身在包内。所有目录先找 exe，再回退批处理。
    const npmRoots = named(process.env.APPDATA) ? [join(process.env.APPDATA, 'npm'), ...pathDirs] : pathDirs;
    for (const dir of npmRoots) {
      const hit = tryFile(join(dir, 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'));
      if (hit) return { found: hit, searched };
    }
    for (const ext of ['.exe', '.cmd', '.bat']) {
      for (const dir of pathDirs) {
        const hit = tryFile(join(dir, `opencode${ext}`));
        if (hit) return { found: hit, searched };
      }
    }
    return { found: null, searched };
  }

  // 4) POSIX PATH
  for (const dir of pathDirs) {
    const hit = tryFile(join(dir, 'opencode'));
    if (hit) return { found: hit, searched };
  }
  return { found: null, searched };
}

/**
 * 让系统发一张"空位号牌"：把一个探测用的 server 绑到 127.0.0.1 上再立刻关掉，
 * 拿到端口号后那个监听已经释放，窗口极小。
 *
 * 为什么不直接 `--port 0`：实测 opencode 1.19.3 把 0 当成"用默认值"，
 * 会回落到固定 4096，撞车就起不来。
 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      server.close(() => resolve(port));
    });
  });
}

/**
 * 把任意 body 里的人类可读信息挖出来，供拼错误文案用。
 * 尽量保留上游给的 `name` 和 `data.message`——排障时这两个字段最有用。
 */
function describeErrorBody(body) {
  if (!body) return '';
  if (typeof body === 'string') return body.slice(0, 300);

  const data = body.data;
  const name = typeof body.name === 'string' ? body.name : '';
  let message = '';
  if (data && typeof data.message === 'string') message = data.message;
  else if (typeof body.message === 'string') message = body.message;
  else if (typeof body.error === 'string') message = body.error;
  else if (body.error && typeof body.error.message === 'string') message = body.error.message;

  if (name && message) {
    const ref = data && typeof data.ref === 'string' ? `（参考号 ${data.ref}）` : '';
    return `${name}: ${message}${ref}`;
  }
  if (message) return message;
  if (name) return name;
  try {
    return JSON.stringify(body).slice(0, 300);
  } catch {
    return String(body);
  }
}

/** 把 AbortSignal 拼起来：任一触发就都触发 */
function mergeSignals(timeoutMs, signal) {
  const timer = AbortSignal.timeout(timeoutMs);
  if (!signal) return { signal: timer, timeoutSignal: timer };

  const controller = new AbortController();
  const relay = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const onCallerAbort = () => relay(signal.reason);
  const onTimeout = () => relay(timer.reason);

  if (signal.aborted) {
    relay(signal.reason);
  } else {
    signal.addEventListener('abort', onCallerAbort, { once: true });
    timer.addEventListener('abort', onTimeout, { once: true });
  }

  return {
    signal: controller.signal,
    timeoutSignal: timer,
    cleanup: () => {
      signal.removeEventListener('abort', onCallerAbort);
      timer.removeEventListener('abort', onTimeout);
    },
  };
}

/** 一个带超时的 fetch，超时/主动取消都翻成 BridgeError */
async function request(url, { method = 'GET', body, timeoutMs = 30_000, signal, headers } = {}) {
  const merged = mergeSignals(timeoutMs, signal);
  const allHeaders = { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(headers ?? {}) };
  try {
    const res = await fetch(url, {
      method,
      headers: Object.keys(allHeaders).length ? allHeaders : undefined,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: merged.signal,
    });
    const text = await res.text();
    let parsed = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    return { status: res.status, ok: res.ok, text, json: parsed };
  } catch (error) {
    const abortedByCaller = Boolean(signal?.aborted);
    const reason = merged.timeoutSignal?.aborted && !abortedByCaller ? 'timeout' : 'aborted';
    if (abortedByCaller) {
      throw new BridgeError(
        `请求 ${url} 被调用方取消，可能上层已经不等结果了。`,
        499,
        'client_closed_request',
      );
    }
    if (reason === 'timeout') {
      throw new BridgeError(
        `等上游响应超过 ${Math.round(timeoutMs / 1000)} 秒还没回来，已放弃。` +
          `如果是大模型太慢，可以把超时调大一点；如果是服务卡死了，重启一下 OpenCode。`,
        504,
        'upstream_timeout',
      );
    }
    throw new BridgeError(
      `连不上本机 OpenCode（${url}）：${error?.message ?? error}。` +
        `请确认 OpenCode 服务还在跑，或者重启一下 OC Faucet。`,
      502,
      'upstream_unreachable',
    );
  } finally {
    merged.cleanup?.();
  }
}

export class OcClient {
  /**
   * @param {object} o
   * @param {string} o.dataDir        数据目录绝对路径
   * @param {string} [o.opencodePath] opencode 可执行文件；默认自动发现
   * @param {number} [o.port]         监听端口；0 = 让系统分配
   * @param {string} [o.workdir]      OpenCode 会话的工作目录；默认 `${dataDir}/workspace`
   * @param {object} [o.env]          额外环境变量
   * @param {(line:string)=>void} [o.onLog]
   */
  constructor(o = {}) {
    if (!o || typeof o.dataDir !== 'string' || o.dataDir.length === 0) {
      throw new BridgeError(
        'OcClient 需要一个 dataDir（数据目录的绝对路径），现在没给。请先确定 OC Faucet 把数据放哪。',
        400,
        'invalid_request',
      );
    }

    this.dataDir = o.dataDir;
    this.opencodePath = o.opencodePath;
    this.requestedPort = Number.isInteger(o.port) && o.port >= 0 ? o.port : 0;
    // 隔离模式下 OpenCode 跑在自己的目录里；OCF_ISOLATE=0 只给排障使用，显式参数优先。
    this.isolate = typeof o.isolate === 'boolean' ? o.isolate : process.env.OCF_ISOLATE !== '0';
    this.runtimeRoot = runtimeRoot(o.dataDir);
    this.serverPassword = this.isolate ? randomPassword() : null;
    this.serverUsername = 'opencode';
    this.workdir = o.workdir ?? (this.isolate ? join(this.runtimeRoot, 'project') : join(o.dataDir, 'workspace'));
    this.env = o.env && typeof o.env === 'object' ? o.env : {};
    this.onLog = typeof o.onLog === 'function' ? o.onLog : () => {};

    this.child = null;
    this.port = null;
    this.started = false;
    this.exited = false;
    // 直接调用 HTTP 方法的旧测试/排障代码默认走 v1；start() 会按真实二进制覆盖
    this.apiMajor = 1;
    this._latestToolCalls = new Map();

    /** 正在进行的 start()，用来让并发调用共享同一次启动 */
    this._starting = null;
    /** 正在进行的 stop()，让 stop 也幂等 */
    this._stopping = null;
    /** 最近抓到的日志行，启动失败时用来拼错误文案 */
    this._logTail = [];

    // ---- 转交（handoff）支持 ----
    /** 事件流里缓存的工具 part：callID → {sessionID, tool, input}（被审批闸门拦下的调用名与参数） */
    this._toolParts = new Map();
    /** 有几个在途 prompt 需要事件流（引用计数，归零就断开 SSE） */
    this._eventDemand = 0;
    /** 事件流的 AbortController；null = 现在没有连接 */
    this._eventAbort = null;
    this._eventReady = null;
  }

  /** start() 成功且未 stop */
  get ready() {
    return this.started && !this.exited;
  }

  /** 形如 http://127.0.0.1:41234（未启动时抛错） */
  get baseUrl() {
    if (!this.port) {
      throw new BridgeError(
        'OpenCode 还没启动，现在拿不到地址。请先调用 start() 把它起起来。',
        503,
        'upstream_not_ready',
      );
    }
    return `http://127.0.0.1:${this.port}`;
  }

  /**
   * 子进程该拿到的环境变量。
   *
   * 隔离模式下只给白名单 + XDG 指向隔离目录 + 口令，
   * 用户自己 OpenCode 里的供应商凭据一个都不带过去（见 oc-isolation.js）。
   */
  _childEnv() {
    if (!this.isolate) return { ...process.env, ...this.env };
    const env = buildIsolatedEnv({
      root: this.runtimeRoot,
      baseEnv: process.env,
      password: this.serverPassword,
      username: this.serverUsername,
      extraEnv: this.env,
    });
    if (this.apiMajor >= 2) {
      // v2 会直接读 HOME 下的技能/配置，XDG 白名单已经挡不住，必须连 HOME 一起隔离。
      env.HOME = join(this.runtimeRoot, 'home');
      env.USERPROFILE = env.HOME;
      env.OPENCODE_CONFIG_DIR = dirname(this._v2ConfigFile());
      delete env.OPENCODE_CONFIG_CONTENT;
    }
    return env;
  }

  _v2ConfigFile() {
    return join(this.runtimeRoot, 'config', 'opencode', 'opencode.json');
  }

  _readV2Config() {
    const file = this._v2ConfigFile();
    if (!existsSync(file)) return {};
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      throw new BridgeError(`读取 OpenCode 隔离配置失败：${error?.message ?? error}`, 500, 'upstream_config_error');
    }
  }

  _writeV2Config(config) {
    const file = this._v2ConfigFile();
    const tmp = `${file}.tmp`;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  }

  _prepareV2Config() {
    if (!this.isolate || this.apiMajor < 2) return;
    const existing = this._readV2Config();
    this._writeV2Config({
      ...existing,
      ...isolatedConfig,
      agent: { ...(existing.agent ?? {}), ...isolatedConfig.agent },
    });
  }

  /** 调这只 OpenCode 时要带的认证头（不隔离时为空） */
  _authHeaders() {
    if (!this.serverPassword) return {};
    return { authorization: basicAuthHeader(this.serverUsername, this.serverPassword) };
  }

  /** 带认证的 request()：所有对上游的调用都走这里，免得漏掉一处 */
  _request(url, opts = {}) {
    return request(url, { ...opts, headers: { ...(opts.headers ?? {}), ...this._authHeaders() } });
  }

  /**
   * ------------------------------------------------------------------
   * 转交（handoff）支撑：事件流 + 审批处理
   * ------------------------------------------------------------------
   *
   * 背景：隔离实例里没人点批准。模型不听信封协议、直接调真实工具时，审批挂住 =
   * 整回合挂死（实测 90 秒超时）。处理有两条路：
   *   - 翻译得出（handoff 回调返回调用）→ 拒批 + 让回合收尾 + 把翻译结果当答案；
   *   - 翻译不出 → 带工具名的纠正性拒批，模型退回信封作答（已验证的行为）。
   *
   * 被拦动作的工具名和参数**只能从 SSE 事件流拿**：工具 part 事件（message.part.updated）
   * 比审批先到，且在途 part 用 HTTP 列消息查不到（真机实测，opencode 1.19.x）；
   * 审批载荷里只有 callID 和少量 metadata。所以有转交需求的 prompt 会短暂共用一条
   * /event 长连接（引用计数，归零即断）。所有失败都吞掉：这些是保险丝，
   * 绝不能反过来把 prompt 搞挂。
   */

  /** 需要事件流时计数 +1；返回释放函数（-1，归零断开），ready 等首次连接就绪 */
  _watchEvents() {
    this._eventDemand += 1;
    if (this._eventDemand === 1) this._startEventStream();
    const release = () => {
      this._eventDemand = Math.max(0, this._eventDemand - 1);
      if (this._eventDemand === 0) this._stopEventStream();
    };
    release.ready = this._eventReady;
    return release;
  }

  /** 维持一条 /event 长连接：断了 1 秒后重连，直到需求归零 */
  _startEventStream() {
    const controller = new AbortController();
    this._eventAbort = controller;
    let opened;
    this._eventReady = new Promise((resolve) => {
      opened = resolve;
      // 事件流只是 handoff 的保险丝，连不上不能反过来把 prompt 永久挂住
      setTimeout(() => resolve(false), 2_000).unref?.();
    });
    (async () => {
      while (!controller.signal.aborted) {
        try {
          await this._streamEvents(controller.signal, () => opened(true));
        } catch (error) {
          if (!controller.signal.aborted) {
            this._log(`[OC Faucet] 事件流断开，稍后重连：${error?.message ?? error}`);
          }
        }
        if (controller.signal.aborted) return;
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 1_000);
          timer.unref?.();
        });
      }
    })().catch(() => {});
  }

  _stopEventStream() {
    this._eventAbort?.abort();
    this._eventAbort = null;
    this._eventReady = null;
  }

  /** 一条事件 SSE 连接：只挑工具调用缓存，别的事件一概忽略 */
  _streamEvents(signal, onOpen = () => {}) {
    return new Promise((resolve, reject) => {
      const path = this.apiMajor >= 2 ? '/api/event' : '/event';
      const url = new URL(`${this.baseUrl}${path}`);
      const req = httpRequest(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'GET',
          signal,
          headers: { ...this._authHeaders(), accept: 'text/event-stream' },
        },
        (response) => {
          if (response.statusCode !== 200) {
            response.resume();
            reject(new BridgeError(`事件流 HTTP ${response.statusCode}`, 502, 'upstream_error'));
            return;
          }
          onOpen();
          let buffer = '';
          response.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
              if (!line.startsWith('data:')) continue;
              try {
                this._handleEvent(JSON.parse(line.slice(5).trim()));
              } catch {
                /* 单条事件解析失败不影响后续 */
              }
            }
          });
          response.on('error', reject);
          response.on('end', resolve);
        },
      );
      req.on('error', reject);
      // 长连接不该被空闲超时掐掉
      req.setTimeout(0);
      req.end();
    });
  }

  /** 同时识别 v1 的 tool part 和 v2 的 session.tool.* 事件。 */
  _handleEvent(wrapper) {
    const event = wrapper?.payload ?? wrapper;
    if (this.apiMajor >= 2) {
      if (event?.type === 'session.tool.input.started' && event.id) {
        this._toolParts.set(event.id, { sessionID: event.sessionID, tool: event.name ?? null, input: {} });
        this._latestToolCalls.set(event.sessionID, event.id);
      } else if (event?.type === 'session.tool.input.ended' && event.id) {
        const previous = this._toolParts.get(event.id);
        if (previous) {
          try {
            const input = JSON.parse(event.text);
            if (input && typeof input === 'object' && !Array.isArray(input)) previous.input = input;
          } catch {
            // called 事件还会带结构化 input，这里解析不到不影响后续
          }
        }
      } else if (event?.type === 'session.tool.called' && event.id) {
        const previous = this._toolParts.get(event.id) ?? {};
        this._toolParts.set(event.id, {
          sessionID: event.sessionID,
          tool: previous.tool ?? null,
          input: event.input ?? previous.input ?? {},
        });
        this._latestToolCalls.set(event.sessionID, event.id);
      }
    } else {
      const part = event?.type === 'message.part.updated' ? event.properties?.part : undefined;
      if (!part || typeof part !== 'object' || part.type !== 'tool' || !part.callID) return;
      this._toolParts.set(part.callID, {
        sessionID: event.properties?.sessionID,
        tool: typeof part.tool === 'string' ? part.tool : null,
        input: part.state?.input ?? {},
      });
    }
    if (this._toolParts.size > 100) this._toolParts.delete(this._toolParts.keys().next().value);
  }

  /**
   * 从事件缓存里捞被拦下的调用。工具 part 通常比审批先到，但两者是两条通路，
   * 有小幅竞态：短重试几轮，等不到就认（调用方退回纠正性拒批）。
   * @returns {Promise<{tool:string, input:object}|null>}
   */
  async _blockedAction(callID, sessionID) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const cached = this._toolParts.get(callID);
      if (
        cached &&
        typeof cached.tool === 'string' &&
        cached.tool &&
        (!cached.sessionID || cached.sessionID === sessionID)
      ) {
        return { tool: cached.tool, input: cached.input ?? {} };
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 120);
        timer.unref?.();
      });
    }
    return null;
  }

  /**
   * 处理一条审批：先问 handoff 回调能不能翻译，再决定「转交式拒批」还是「纠正性拒批」。
   * 无论走哪条路，这条审批都计入 stats.nativeBlocked——「真调过本机工具」本身就是
   * 工具能力的证明（体检据此把绕过信封的模型判成 tool 而不是 chat）。
   * @returns {Promise<{handoff:{name:string,arguments:object}}|null>}
   */
  async _resolveOne(p, handoff, stats) {
    if (typeof handoff === 'function') {
      const callID = p?.tool?.callID ?? this._latestToolCalls.get(p.sessionID);
      const action = typeof callID === 'string' && callID ? await this._blockedAction(callID, p.sessionID) : null;
      let translated = null;
      if (action) {
        try {
          translated = handoff({ native: action.tool, input: handoffInput(action, p) });
        } catch {
          translated = null; // 回调炸了不能拦住拒批，按翻译失败走
        }
      }
      if (translated && typeof translated.name === 'string' && translated.name &&
          translated.arguments && typeof translated.arguments === 'object' && !Array.isArray(translated.arguments)) {
        await this._replyPermission(p, '此动作已转交给外部客户端执行，不需要你在本机完成。').catch(() => {});
        return { handoff: { name: translated.name, arguments: translated.arguments } };
      }
      const native = action?.tool ?? (p?.metadata?.command ? 'bash' : (typeof p?.permission === 'string' ? p.permission : null));
      const reason = !action
        ? '这次调用没能从事件流里读到名字与参数，无法匹配外部工具'
        : '它的参数映射不到本次请求申报的外部工具';
      await this._replyPermission(p, rejectFeedback(native, reason)).catch(() => {});
      return null;
    }
    // 没有转交回调（体检、无工具请求）：同样点名工具、指回信封——
    // 含糊的拒批文案会让会调工具的模型交不出合格信封，被误判成"只能聊天"（实测）。
    const native = p?.metadata?.command ? 'bash' : (typeof p?.permission === 'string' ? p.permission : null);
    await this._replyPermission(
      p,
      rejectFeedback(native, '本会话没有可用的外部工具'),
    ).catch(() => {});
    return null;
  }

  /** 拒掉一条审批（失败由调用方吞） */
  _replyPermission(p, message) {
    if (this.apiMajor >= 2) {
      return this._request(
        `${this.baseUrl}/api/session/${encodeURIComponent(p.sessionID)}/permission/${encodeURIComponent(p.id)}/reply`,
        { method: 'POST', body: { decision: 'reject', message }, timeoutMs: 5_000 },
      );
    }
    return this._request(`${this.baseUrl}/permission/${encodeURIComponent(p.id)}/reply`, {
      method: 'POST',
      body: { reply: 'reject', message },
      timeoutMs: 5_000,
    });
  }

  /**
   * 回合期间处理本会话的权限请求，返回停止函数（async，做最后一轮收尾轮询）。
   *
   * 轮询而非每回合常驻监听：一次体检/转发就几秒到几分钟，犯不上多养状态机；
   * 400ms 的节奏足够把「审批挂住 = 回合挂死」的风险摁住。
   * 消息落地后还有一次收尾轮询（只拒批、不再转交），关掉「响应落地前一刻
   * 冒出审批」的竞态窗口——转交只打断在途回合，不覆盖已经完成的回复
   * （模型的最终信封是它被纠正后的完整答案，可能比中途被拦的动作更对）。
   *
   * @param {string} sessionID
   * @param {object} [o]
   * @param {((blocked:{native:string, input:object})=>({name:string,arguments:object}|null))|null} [o.handoff]
   * @param {(call:{name:string,arguments:object})=>void} [o.onHandoff]
   * @param {{nativeBlocked:number}} [o.stats] 每拦下一次本机调用 +1（体检用它识别"会调工具"的模型）
   */
  _handlePermissions(sessionID, { handoff = null, onHandoff = null, stats = null } = {}) {
    const seen = new Set();
    let active = true;

    const sweep = async ({ final = false } = {}) => {
      let pending;
      try {
        const path = this.apiMajor >= 2 ? '/api/permission/request' : '/permission';
        const res = await this._request(`${this.baseUrl}${path}`, { timeoutMs: 5_000 });
        pending = this.apiMajor >= 2
          ? (Array.isArray(res.json?.data) ? res.json.data.map(permissionPayload) : [])
          : (Array.isArray(res.json) ? res.json : []);
      } catch {
        return; // 问不出来就等下一轮；收尾轮询问不出来就算了
      }
      for (const p of pending) {
        if (!active && !final) break; // 转交已命中，别再碰新的审批
        if (!p || p.sessionID !== sessionID || typeof p.id !== 'string' || seen.has(p.id)) continue;
        seen.add(p.id);
        if (stats) stats.nativeBlocked += 1;
        const outcome = await this._resolveOne(p, final ? null : handoff).catch(() => null);
        if (outcome?.handoff) {
          if (!final) active = false; // 转交命中：回合马上收工，余下审批留给收尾轮询拒掉
          onHandoff?.(outcome.handoff);
          if (!final) break;
        }
      }
    };

    const timer = setInterval(() => {
      if (active) void sweep().catch(() => {});
    }, 400);
    timer.unref?.();
    void sweep().catch(() => {});

    return async () => {
      active = false;
      clearInterval(timer);
      await sweep({ final: true }).catch(() => {});
    };
  }

  /** 让在途回合立刻收尾（转交命中后不再等模型把话说完）；失败由调用方吞 */
  _abortSession(sessionID) {
    const path = this.apiMajor >= 2
      ? `/api/session/${encodeURIComponent(sessionID)}/interrupt`
      : `/session/${encodeURIComponent(sessionID)}/abort`;
    return this._request(`${this.baseUrl}${path}`, {
      method: 'POST',
      timeoutMs: 5_000,
    });
  }

  /** 转交回合的 token 尽力而为：取会话里最后一条助手消息的统计，拿不到就 null */
  async _lastAssistantTokens(sessionID) {
    try {
      const prefix = this.apiMajor >= 2 ? '/api/session' : '/session';
      const res = await this._request(
        `${this.baseUrl}${prefix}/${encodeURIComponent(sessionID)}/message?limit=1`,
        { timeoutMs: 5_000 },
      );
      const messages = this.apiMajor >= 2 ? res.json?.data : res.json;
      if (!res.ok || !Array.isArray(messages)) return null;
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (this.apiMajor >= 2 && messages[i]?.type === 'assistant') return messages[i].tokens ?? null;
        const info = messages[i]?.info;
        if (info && info.role === 'assistant') return info.tokens ?? null;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** 把一行日志同时送去 onLog 和内部尾巴缓冲 */
  _log(line) {
    const text = String(line).replace(/\s+$/, '');
    if (!text) return;
    this._logTail.push(text);
    if (this._logTail.length > 40) this._logTail.shift();
    try {
      this.onLog(text);
    } catch {
      // 调用方的 onLog 自己炸了不该拖垮我们
    }
  }

  /**
   * 起 `opencode serve`，轮询直到健康或超时（默认 30s）。已启动则幂等返回。
   * @returns {Promise<void>}
   */
  async start() {
    if (this.ready) return;
    if (this._starting) return this._starting;

    this._starting = this._start().finally(() => {
      this._starting = null;
    });
    return this._starting;
  }

  async _start() {
    const { found, searched } = discoverOpencode(this.opencodePath);
    if (!found) {
      throw new BridgeError(
        `找不到 OpenCode 程序。我依次找过这些地方：${searched.join('、')}。` +
          `请确认已经装好 OpenCode，或者用环境变量 OCF_OPENCODE_PATH 直接告诉 OC Faucet 它在哪。`,
        500,
        'runtime_missing',
      );
    }

    this.apiMajor = await detectOpencodeMajor(found);

    // 工作目录要先存在，否则 opencode 起来后会到处报奇怪错
    try {
      // 隔离模式下还要把 config/data/cache/state 一起建出来，
      // 否则 OpenCode 会回落到用户自己的 XDG 目录，隔离就白做了。
      if (this.isolate) ensureRuntimeDirs(this.runtimeRoot);
      mkdirSync(this.workdir, { recursive: true });
      this._prepareV2Config();
    } catch (error) {
      throw new BridgeError(
        `建不出工作目录 ${this.workdir}：${error?.message ?? error}。请检查该路径有没有写入权限。`,
        500,
        'internal_error',
      );
    }

    // 端口：显式指定就用它，否则自己探一个空闲的
    // （不能用 --port 0——实测它会回落到固定 4096，撞车就起不来）
    const autoPort = !this.requestedPort;
    let port = this.requestedPort;
    let lastError = null;

    // 自动选端口时最多试两次：第一次的端口可能刚好被别人抢走
    for (let attempt = 0; attempt < (autoPort ? 2 : 1); attempt += 1) {
      if (autoPort) {
        try {
          port = await findFreePort();
        } catch (error) {
          throw new BridgeError(
            `找空闲端口失败：${error?.message ?? error}。请检查本机网络状态后重试。`,
            500,
            'internal_error',
          );
        }
      }

      try {
        await this._spawnAndWait(found, port);
        return;
      } catch (error) {
        lastError = error;
        // 启动没成功 → 先确保没留孤儿进程，再决定要不要换端口重试
        await this._killChild();
        this.started = false;
        // 程序本身有问题（找不到/跑不起来）换端口也没用，直接抛
        if (error?.code === 'runtime_missing') throw error;
        if (!autoPort) throw error;
        this._log(`[OC Faucet] 用端口 ${port} 启动失败，换一个端口再试一次`);
      }
    }

    throw lastError ?? new BridgeError('OpenCode 启动失败，原因不明。', 500, 'upstream_not_ready');
  }

  /** 起一次子进程并等它健康；失败时抛出（由 _start 决定是否重试） */
  async _spawnAndWait(found, port) {
    this._logTail = [];
    this.exited = false;

    let child;
    try {
      const args = ['serve', '--port', String(port), '--hostname', '127.0.0.1'];
      // v1 用 --pure 关插件；v2 已移除这个参数，隔离 HOME 在 _childEnv 里处理
      if (this.isolate && this.apiMajor < 2) args.push('--pure');
      child = spawnOpencode(found, args, {
        cwd: this.workdir,
        env: this._childEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });
    } catch (error) {
      throw new BridgeError(
        `启动 OpenCode 失败：${error?.message ?? error}。请确认 ${found} 能正常执行。`,
        500,
        'runtime_missing',
      );
    }

    this.child = child;
    this.port = port;
    this.started = false;

    const onData = (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim()) this._log(line);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    let spawnError = null;
    child.once('error', (error) => {
      spawnError = error;
      this.exited = true;
    });
    child.once('exit', (code, signal) => {
      this.exited = true;
      this.started = false;
      this._log(`[opencode 退出] code=${code} signal=${signal}`);
    });

    const deadline = Date.now() + DEFAULT_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (spawnError) {
        throw new BridgeError(
          `启动 OpenCode 失败：${spawnError.message}。请确认 ${found} 是能跑的程序。`,
          500,
          spawnError.code === 'ENOENT' ? 'runtime_missing' : 'internal_error',
        );
      }
      if (this.exited) {
        throw new BridgeError(
          `OpenCode 启动后立刻退出了，没能提供服务。最近的输出：${this._logTail.slice(-5).join(' | ') || '（没有输出）'}`,
          500,
          'upstream_not_ready',
        );
      }

      // 日志里若出现别的端口，说明我们传的端口没被采纳，跟随日志修正
      for (const line of this._logTail) {
        const match = PORT_PATTERNS.map((re) => re.exec(line)).find(Boolean);
        if (match) {
          const logged = Number(match[1]);
          if (Number.isInteger(logged) && logged > 0 && logged !== this.port) {
            this.port = logged;
          }
          break;
        }
      }

      try {
        const healthPath = this.apiMajor >= 2 ? '/api/provider' : '/config/providers';
        const res = await this._request(`${this.baseUrl}${healthPath}`, { timeoutMs: 3_000 });
        if (res.ok) {
          this.started = true;
          this._log(`[OC Faucet] OpenCode 已就绪：${this.baseUrl}`);
          return;
        }
      } catch {
        // 还没起来，继续等
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new BridgeError(
      `等了 ${Math.round(DEFAULT_READY_TIMEOUT_MS / 1000)} 秒，OpenCode 还是没起来（${this.baseUrl}）。` +
        `最近的输出：${this._logTail.slice(-5).join(' | ') || '（没有输出）'}`,
      504,
      'upstream_not_ready',
    );
  }

  /** 停服：先 SIGTERM，3s 后 SIGKILL；幂等 */
  async stop() {
    if (this._stopping) return this._stopping;
    this._stopping = this._stop().finally(() => {
      this._stopping = null;
    });
    return this._stopping;
  }

  async _stop() {
    await this._killChild();
    // 事件流也一并掐掉：服务都没了，缓存里的工具 part 一并作废
    this._stopEventStream();
    this._toolParts.clear();
    this.started = false;
  }

  /** 收尸：Windows 清整棵树；POSIX 走 SIGTERM → 等 3 秒 → SIGKILL */
  async _killChild() {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      // 进程早就没了（或者压根没起过）
      this.exited = true;
      return;
    }
    if (process.platform === 'win32') {
      await killWindowsTree(child);
      this.exited = true;
      return;
    }

    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };

      child.once('exit', finish);

      // 先来软的
      try {
        child.kill('SIGTERM');
      } catch {
        finish();
        return;
      }

      const timer = setTimeout(() => {
        if (settled) return;
        this._log('[OC Faucet] OpenCode 没理 SIGTERM，改用 SIGKILL 强杀');
        try {
          child.kill('SIGKILL');
        } catch {
          /* 已经退出 */
        }
        // 兜底：SIGKILL 之后还不回就再等一小会
        setTimeout(finish, 1_000);
      }, KILL_GRACE_MS);
    });

    this.exited = true;
  }

  /** 模型清单统一返回 v1 形状；v2 的 provider/model 两个接口在这里合并。 */
  async providers() {
    if (this.apiMajor >= 2) {
      const responses = await Promise.all(
        ['/api/provider', '/api/model', '/api/model/default'].map((path) =>
          this._request(`${this.baseUrl}${path}`, { timeoutMs: 15_000 })),
      );
      const failed = responses.find((res) => !res.ok);
      if (failed) {
        throw new BridgeError(
          `问 OpenCode 要模型清单失败（HTTP ${failed.status}）：${describeErrorBody(failed.json ?? failed.text)}`,
          502,
          'upstream_error',
        );
      }
      return providersPayload(responses[0].json?.data, responses[1].json?.data, responses[2].json?.data);
    }

    const res = await this._request(`${this.baseUrl}/config/providers`, { timeoutMs: 15_000 });
    if (!res.ok) {
      throw new BridgeError(
        `问 OpenCode 要模型清单失败（HTTP ${res.status}）：${describeErrorBody(res.json ?? res.text)}`,
        502,
        'upstream_error',
      );
    }
    return res.json;
  }

  /**
   * 更新 OpenCode 隔离环境中的模型上下文限制。
   * v1 走全局配置 API；v2 只写隔离配置文件并重载 location，都不需要重启 serve 进程。
   * @param {Array<{modelID:string,limit:{context:number,input?:number,output:number}}>} entries
   */
  async setModelContextWindows(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return { ok: true };
    const models = Object.create(null);
    for (const entry of entries) {
      const modelID = entry?.modelID;
      const limit = entry?.limit;
      if (
        typeof modelID !== 'string' ||
        !modelID ||
        !limit ||
        !Number.isSafeInteger(limit.context) ||
        limit.context <= 0 ||
        !Number.isSafeInteger(limit.output) ||
        limit.output <= 0 ||
        (limit.input !== undefined && (!Number.isSafeInteger(limit.input) || limit.input < 0))
      ) {
        throw new BridgeError('模型上下文设置不完整，无法安全写入 OpenCode。', 400, 'invalid_context_window');
      }
      const modelLimit = { context: limit.context };
      if (limit.input !== undefined) modelLimit.input = limit.input;
      modelLimit.output = limit.output;
      models[modelID] = { limit: modelLimit };
    }

    if (this.apiMajor >= 2) {
      if (!this.isolate) {
        throw new BridgeError('OpenCode v2 只允许在隔离模式下修改模型上下文，未改动任何配置。', 400, 'upstream_config_error');
      }
      const config = this._readV2Config();
      const provider = { ...(config.provider ?? {}) };
      const opencode = { ...(provider.opencode ?? {}) };
      opencode.models = { ...(opencode.models ?? {}), ...models };
      provider.opencode = opencode;
      config.provider = provider;
      this._writeV2Config(config);

      const reloaded = await this._request(`${this.baseUrl}/api/location/reload`, {
        method: 'POST',
        timeoutMs: 15_000,
      });
      if (!reloaded.ok) {
        throw new BridgeError(
          `OpenCode 已保存模型上下文设置，但重新载入模型失败（HTTP ${reloaded.status}）：${describeErrorBody(reloaded.json ?? reloaded.text)}`,
          502,
          'upstream_dispose_error',
        );
      }
      return { ok: true };
    }

    const patch = await this._request(`${this.baseUrl}/global/config`, {
      method: 'PATCH',
      body: { provider: { opencode: { models } } },
      timeoutMs: 15_000,
    });
    if (!patch.ok) {
      throw new BridgeError(
        `OpenCode 没接受模型上下文设置（HTTP ${patch.status}）：${describeErrorBody(patch.json ?? patch.text)}`,
        502,
        'upstream_config_error',
      );
    }

    const disposed = await this._request(`${this.baseUrl}/global/dispose`, {
      method: 'POST',
      timeoutMs: 15_000,
    });
    if (!disposed.ok) {
      throw new BridgeError(
        `OpenCode 已保存模型上下文设置，但重新载入模型失败（HTTP ${disposed.status}）：${describeErrorBody(disposed.json ?? disposed.text)}`,
        502,
        'upstream_dispose_error',
      );
    }
    return { ok: true };
  }

  /** agent 清单统一返回数组。 */
  async agents() {
    const path = this.apiMajor >= 2 ? '/api/agent' : '/agent';
    const res = await this._request(`${this.baseUrl}${path}`, { timeoutMs: 15_000 });
    if (!res.ok) {
      throw new BridgeError(
        `问 OpenCode 要 agent 清单失败（HTTP ${res.status}）：${describeErrorBody(res.json ?? res.text)}`,
        502,
        'upstream_error',
      );
    }
    return this.apiMajor >= 2
      ? (Array.isArray(res.json?.data) ? res.json.data : [])
      : (Array.isArray(res.json) ? res.json : []);
  }

  /**
   * 建一个一次性会话。调用方负责在用完后 deleteSession。
   * @returns {Promise<string>} sessionID
   */
  async createSession({ title, directory } = {}) {
    const body = {};
    if (title !== undefined) body.title = title;
    if (this.apiMajor >= 2) {
      if (this.isolate) body.agent = ISOLATED_AGENT;
      if (typeof directory === 'string' && directory) body.location = { directory };
    }
    // v1 的 directory 参数没有实际效果，继续不往旧接口里塞。

    const path = this.apiMajor >= 2 ? '/api/session' : '/session';
    const res = await this._request(`${this.baseUrl}${path}`, {
      method: 'POST',
      body,
      timeoutMs: 15_000,
    });

    if (!res.ok) {
      throw new BridgeError(
        `建会话失败（HTTP ${res.status}）：${describeErrorBody(res.json ?? res.text)}`,
        502,
        'upstream_error',
      );
    }
    const id = this.apiMajor >= 2 ? res.json?.data?.id : res.json?.id;
    if (typeof id !== 'string' || !id) {
      throw new BridgeError(
        `OpenCode 建会话的返回里没有 id，看不懂它给的是什么：${res.text.slice(0, 200)}`,
        502,
        'upstream_error',
      );
    }
    return id;
  }

  /** 删除会话；失败不抛（只记日志） */
  async deleteSession(sessionID) {
    const prefix = this.apiMajor >= 2 ? '/api/session' : '/session';
    const res = await this._request(
      `${this.baseUrl}${prefix}/${encodeURIComponent(sessionID)}`,
      { method: 'DELETE', timeoutMs: 15_000 },
    ).catch((error) => {
      this._log(`[OC Faucet] 删会话 ${sessionID} 失败：${error?.message ?? error}`);
      return null;
    });
    if (res && !res.ok) {
      this._log(
        `[OC Faucet] 删会话 ${sessionID} 失败（HTTP ${res.status}）：${describeErrorBody(res.json ?? res.text)}`,
      );
    }
  }

  /** v2 的 prompt 只负责入队：先选模型，再等 idle，最后把 assistant 投影回旧响应形状。 */
  async _promptV2(sessionID, body, { timeoutMs, signal }) {
    const prefix = `${this.baseUrl}/api/session/${encodeURIComponent(sessionID)}`;
    const deadline = Date.now() + timeoutMs;
    const call = (path, { method = 'GET', payload } = {}) => this._request(path, {
      method,
      body: payload,
      timeoutMs: Math.max(1, deadline - Date.now()),
      signal,
    });

    const model = { providerID: body.model.providerID, id: body.model.modelID };
    if (body.variant) model.variant = body.variant;
    const selected = await call(`${prefix}/model`, { method: 'POST', payload: { model } });
    if (!selected.ok) return selected;

    const userText = body.parts
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
    // v2 的系统词挂在 agent 配置上；每次请求不同的信封指令只能随本条输入一起下发。
    const text = body.system ? `${body.system}\n\n${userText}` : userText;
    const submitted = await call(`${prefix}/prompt`, { method: 'POST', payload: { text } });
    if (!submitted.ok) return submitted;

    const waited = await call(`${this.baseUrl}/api/experimental/session/${encodeURIComponent(sessionID)}/wait`, {
      method: 'POST',
    });
    if (!waited.ok) return waited;

    const messages = await call(`${prefix}/message?limit=1&type=assistant`);
    if (!messages.ok) return messages;
    const assistant = Array.isArray(messages.json?.data)
      ? messages.json.data.find((message) => message?.type === 'assistant')
      : null;
    const json = promptPayload(assistant);
    return { ok: true, status: 200, json, text: JSON.stringify(json) };
  }

  /**
   * 发一条消息并等完整回复（非流式）。
   *
   * @param {object} o
   * @param {string} o.sessionID
   * @param {string} o.providerID
   * @param {string} o.modelID
   * @param {string} o.system
   * @param {string} o.text
   * @param {string} [o.variant] 推理档位（OpenCode 的 variant 键名；不传走模型默认）
   * @param {(blocked:{native:string,input:object})=>({name:string,arguments:object}|null)|null} [o.handoff]
   *        转交裁决回调：模型真调本机工具被拦时，用它把动作翻译成客户端工具调用；
   *        返回 {name,arguments} = 转交命中（本回合立刻收工，翻译结果当答案），
   *        返回 null = 翻不了，退回纠正性拒批。不传就是纯拒批（体检、无工具请求）。
   * @param {number} [o.timeoutMs] 默认 180000
   * @param {AbortSignal} [o.signal]
   * @returns {Promise<{text:string, tokens:object|null, handoff:{name:string,arguments:object}|null, nativeBlocked:number}>}
   *          转交命中时 text 为空串、handoff 为翻译出的调用；nativeBlocked 是本回合
   *          拦下的本机工具调用次数（体检用它识别"会调工具"的模型）。
   */
  async prompt(o) {
    const {
      sessionID,
      providerID,
      modelID,
      system,
      text,
      variant,
      handoff,
      timeoutMs = DEFAULT_PROMPT_TIMEOUT_MS,
      signal,
    } = o;

    const body = {
      model: { providerID, modelID },
      parts: [{ type: 'text', text }],
      // tools:{} 只是"没有逐项开关"，并不会真的关掉工具——模型仍可能直接调 OpenCode
      // 自带的 read/bash（实测 minimax、nemotron 会）。真正的拦截链是：permission 全标
      // ask（工具表照常申报给上游，全 deny 会让免费池 403）+ 回合期间的审批处理
      // （拒批，或在带 handoff 回调时转交）。
      tools: {},
    };
    // 推理强度：OpenCode 认的是 variant 键名（不是 reasoningEffort 的值）
    if (typeof variant === 'string' && variant) body.variant = variant;
    if (system !== undefined && system !== null && system !== '') body.system = system;

    const wantHandoff = typeof handoff === 'function';

    // 转交需要事件流拿被拦动作的名字与参数；纯拒批路径不养长连接
    const stopEvents = wantHandoff ? this._watchEvents() : null;
    // 消息 POST 的总闸：调用方信号和转交命中都从这里掐
    const fetchAbort = new AbortController();
    let detachCallerAbort = null;
    if (signal) {
      const relay = () => {
        if (!fetchAbort.signal.aborted) fetchAbort.abort(signal.reason);
      };
      if (signal.aborted) relay();
      else {
        signal.addEventListener('abort', relay, { once: true });
        detachCallerAbort = () => signal.removeEventListener('abort', relay);
      }
    }

    let handoffCall = null;
    let settleHandoff = null;
    const handoffWon = new Promise((resolve) => {
      settleHandoff = resolve;
    });
    // 本回合拦下了几次本机调用：体检据此把"绕过信封真调工具"的模型判成 tool
    const turnStats = { nativeBlocked: 0 };
    const stopWatch = this._handlePermissions(sessionID, {
      handoff: wantHandoff ? handoff : null,
      onHandoff: (call) => {
        handoffCall = call;
        settleHandoff(true);
      },
      stats: turnStats,
    });

    try {
      if (stopEvents?.ready) await stopEvents.ready;
      const messagePromise = this.apiMajor >= 2
        ? this._promptV2(sessionID, body, { timeoutMs, signal: fetchAbort.signal })
        : this._request(`${this.baseUrl}/session/${encodeURIComponent(sessionID)}/message`, {
          method: 'POST',
          body,
          timeoutMs,
          signal: fetchAbort.signal,
        });

      let res = null;
      if (wantHandoff) {
        // 消息完成与转交命中，先到先得：转交赢了就不再等模型把话说完
        res = await Promise.race([messagePromise, handoffWon.then(() => null)]);
      } else {
        res = await messagePromise;
      }

      if (!res) {
        // 转交命中（拒批已在审批处理里做完）。先让回合在服务端收尾，再给在途的
        // 消息 POST 一点时间自然返回（abort 会让它落地）；5 秒还不回就掐断 fetch
        // 兜底。它的内容不再重要——race 已替它挂了拒绝处理，不会留未处理拒绝。
        await this._abortSession(sessionID).catch(() => {});
        await Promise.race([
          messagePromise.then(() => {}, () => {}),
          new Promise((resolve) => {
            const timer = setTimeout(resolve, 5_000);
            timer.unref?.();
          }),
        ]);
        fetchAbort.abort();
        const tokens = await this._lastAssistantTokens(sessionID);
        return { text: '', tokens, handoff: handoffCall, nativeBlocked: turnStats.nativeBlocked };
      }

      const parsed = await this._parsePromptResponse(res, sessionID);
      return { ...parsed, handoff: null, nativeBlocked: turnStats.nativeBlocked };
    } finally {
      detachCallerAbort?.();
      await stopWatch();
      stopEvents?.();
    }
  }

  /** 把 v1/v2 的完成响应统一翻成 {text, tokens}；失败按原有口径抛 BridgeError */
  async _parsePromptResponse(res, sessionID) {

    // 上游报错时不一定有 info（实测模型不存在直接是 HTTP 500 + {name,data}），
    // 所以先看 HTTP 状态，再看 info.error。
    if (!res.ok) {
      const detail = describeErrorBody(res.json ?? res.text);

      // 404 = 会话没了（可能被上层提前删了，或者 opencode 重启过）
      if (res.status === 404) {
        throw new BridgeError(
          `会话 ${sessionID} 在 OpenCode 里已经不存在了，这条消息没法发出去。` +
            `请重新建一个会话再试。${detail ? `（上游原话：${detail}）` : ''}`,
          502,
          'session_not_found',
        );
      }

      const hint =
        res.json?.name === 'UnknownError'
          ? '（多半是这个模型或供应商在本机 OpenCode 里没配好）'
          : '';
      throw new BridgeError(
        `模型这次没能给出回答（HTTP ${res.status}）${hint}：${detail || '上游没有返回可读的说明'}`,
        502,
        'upstream_error',
      );
    }

    const payload = res.json;
    if (!payload || typeof payload !== 'object') {
      throw new BridgeError(
        `OpenCode 返回的不是一个 JSON 对象，看不懂：${res.text.slice(0, 200)}`,
        502,
        'upstream_error',
      );
    }

    const info = payload.info;
    if (info && info.error) {
      throw new BridgeError(
        `模型这次报错了：${describeErrorBody(info.error) || JSON.stringify(info.error).slice(0, 300)}`,
        502,
        'upstream_error',
      );
    }

    // 把所有 text part 按顺序拼接——实测可能被切成好几段，漏拼会丢内容
    const parts = Array.isArray(payload.parts) ? payload.parts : [];
    const textOut = parts
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');

    // token 取最后一个 step-finish
    let tokens = null;
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const part = parts[i];
      if (part && part.type === 'step-finish' && part.tokens) {
        tokens = part.tokens;
        break;
      }
    }

    return { text: textOut, tokens };
  }
}
