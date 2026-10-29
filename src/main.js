/**
 * OC Faucet 的编排层。
 *
 * 它把四块拼起来：
 *   OcClient（跟隔离的 OpenCode 说话）
 *   probe   （体检哪些模型真能按协议干活）
 *   server  （本机转发口，各接入工具从这里进来）
 *   信封     （把只会聊天的模型翻译成会说 Anthropic 协议的模型）
 *
 * 并对外暴露一个 Bridge 门面给桌面界面用。
 */
import { BridgeError } from './errors.js';
import { OcClient } from './oc-client.js';
import { ZenClient } from './zen-client.js';
import { collectModels, faucetModels, interleaveByProvider, parseModelId } from './models.js';
import { describeReasoning } from './efforts.js';
import { PROBE_FINGERPRINT, probeMany } from './probe.js';
import { ProbeCache } from './probe-cache.js';
import { createServer } from './server.js';
import { startWebUi } from './webui.js';
import { buildSystem, decodeEnvelope } from './envelope.js';
import { buildHandoff } from './handoff.js';
import { prepareAnthropic, prepareOpenAI, prepareResponses } from './protocol.js';
import * as zcode from './zcode-config.js';
import { createTargets } from './targets.js';
import * as settings from './settings.js';
import { clearServiceInfo, writeServiceInfo } from './service-control.js';
import { appendFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** 仓库根目录（本文件在 src/ 下） */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** 一次可用的模型判定 */
function usable(entry) {
  return entry && (entry.verdict === 'tool' || entry.verdict === 'chat');
}

/** 组装 OpenCode 的 limit；没有原始 input 时继续省略，恢复时也不会发 null。 */
function contextLimitFor(baseline, context) {
  return {
    context: context ?? baseline.context,
    ...(baseline.input !== undefined ? { input: context ?? baseline.input } : {}),
    output: baseline.output,
  };
}

/** 比较 OpenCode 实际返回的 context/input/output，包含字段是否缺省。 */
function contextLimitsMatch(actual, expected) {
  return ['context', 'input', 'output'].every((key) => {
    const expectedHas = Object.hasOwn(expected, key);
    const actualHas = Object.hasOwn(actual ?? {}, key);
    return expectedHas === actualHas && (!expectedHas || actual[key] === expected[key]);
  });
}

function usableContextLimit(baseline, context) {
  return Number.isSafeInteger(baseline?.context) && baseline.context > 0 &&
    Number.isSafeInteger(baseline?.output) && baseline.output > 0
    ? contextLimitFor(baseline, context)
    : null;
}

export class Bridge {
  constructor({ log = () => {}, targets, makeClient, autoRetryIntervalMs } = {}) {
    this.log = log;
    this.client = null;
    this.server = null;
    this.cache = null;
    this.activePromptCount = 0;
    this.activeRefreshCount = 0;
    this.contextWindowChangeInFlight = false;
    this.contextWindowChangePromise = null;
    this.resolveContextWindowChange = null;
    // 接入目标注册表：构造时建好，界面与动作面向它编程，不认具体目标。
    // targets 参数是留给测试的缝（塞假目标），正常情况用默认注册表。
    this.targets = targets ?? createTargets();
    // 上游客户端工厂：默认按方案造真的（内嵌 OpenCode / Bun 侧车直连 zen）；
    // makeClient 参数是留给测试的另一条缝（塞假客户端，不触网不起进程）
    this.#clientFactory = makeClient ?? ((mode) => this.#makeClient(mode));
    // 失败自动重试的节奏（默认 10 分钟，与失败判定的短 TTL 对齐；测试可调小）
    this.autoRetryIntervalMs =
      Number.isFinite(autoRetryIntervalMs) && autoRetryIntervalMs > 0 ? autoRetryIntervalMs : 10 * 60 * 1000;
    this.state = {
      phase: 'idle', // idle | starting | ready | probing | error
      error: null,
      // 上游方案：embedded = 内嵌隔离 OpenCode；masquerade = Bun 侧车逐字节伪装并直连 zen
      mode: 'embedded',
      models: [], // 全部模型（含未通过的）
      verdicts: new Map(), // modelId -> {verdict, note, checkedAt, elapsedMs, cached}
      port: null,
      apiKey: null,
      // 路由器广播：true = 转发口绑 0.0.0.0，局域网设备凭密钥接入
      lanAccess: false,
      upstream: { ready: false, baseUrl: null },
      startedAt: Date.now(),
      progress: null, // {done, total}
      targets: null, // 逐目标状态，见 listTargetStates()；没读过就是 null
    };
  }

  /** 给界面看的状态快照（可安全 JSON 序列化） */
  snapshot() {
    return {
      phase: this.state.phase,
      error: this.state.error,
      mode: this.state.mode,
      lanAccess: this.state.lanAccess === true,
      port: this.state.port,
      apiKey: null, // 绝不把密钥发给渲染进程
      hasApiKey: Boolean(this.state.apiKey),
      upstream: this.state.upstream,
      startedAt: this.state.startedAt,
      progress: this.state.progress,
      zcode: this.state.zcode ?? null,
      // 逐目标状态是 listTargetStates() 最近一次实读的缓存；桌面端同步调本方法，不能现读文件
      targets: this.state.targets ?? [],
      models: this.state.models.map((m) => this.#view(m)),
    };
  }

  #view(model) {
    const v = this.state.verdicts.get(model.id);
    // 推理档位明细直接复用 efforts 模块的描述：非推理模型拿到空列表/null/false，不报错
    const r = describeReasoning(model);
    return {
      id: model.id,
      name: model.name,
      providerID: model.providerID,
      modelID: model.modelID,
      free: model.free,
      reasoning: model.reasoning,
      images: model.images,
      video: model.video === true,
      pdf: model.pdf === true,
      upstreamContextWindow: model.upstreamContextWindow ?? model.contextWindow ?? null,
      contextWindowOverride: model.contextWindowOverride ?? null,
      contextWindow: model.contextWindow ?? model.upstreamContextWindow ?? null,
      contextWindowPending: model.contextWindowPending === true,
      deprecated: model.deprecated,
      supportedEfforts: r.supportedEfforts,
      defaultEffort: r.defaultEffort,
      canDisableThinking: r.canDisableThinking,
      verdict: v?.verdict ?? 'unknown',
      note: v?.note ?? '',
      elapsedMs: v?.elapsedMs ?? null,
      checkedAt: v?.checkedAt ?? null,
      cached: v?.cached ?? false,
    };
  }

  /** 只把「能用」的模型给接入工具，并把「只能聊天」的模型工具关掉 */
  getModels() {
    return [...this.state.verdicts.entries()]
      .filter(([, v]) => usable(v))
      .map(([id, v]) => {
        const m = this.state.models.find((x) => x.id === id);
        return m ? { ...m, chatOnly: v.verdict === 'chat' } : null;
      })
      .filter(Boolean);
  }

  #clientFactory;
  #autoRetryTimer = null;

  /** 按当前方案造一个上游客户端（内嵌 OpenCode，或 Bun 侧车直连 zen） */
  #makeClient(mode) {
    if (mode === 'masquerade') {
      return new ZenClient({ onLog: (line) => this.log(line) });
    }
    return new OcClient({
      dataDir: settings.dataDir(),
      workdir: settings.workspaceDir(),
      onLog: (line) => this.log(line),
    });
  }

  /** 启动：准备目录 → 起上游（按方案）→ 起转发口 */
  async start() {
    this.state.phase = 'starting';
    try {
      await settings.ensureLayout();
      this.state.apiKey = await settings.apiKey();
      this.cache = new ProbeCache({ file: settings.probeCacheFile() });
      await this.cache.load();

      const settingsNow = await settings.readSettings();
      this.state.mode = settingsNow.upstreamMode === 'masquerade' ? 'masquerade' : 'embedded';
      this.client = this.#clientFactory(this.state.mode);
      await this.client.start();
      // 伪装模式 isolate=false，这一步自动跳过（它没有 OpenCode 全局配置可写）
      await this.#applyPersistedContextWindows();
      this.state.upstream = { ready: true, baseUrl: this.client.baseUrl };

      const port = await settings.resolvePort();
      // 路由器广播：默认只绑回环；开了才绑全地址（密钥与 Origin 围栏照旧）
      this.state.lanAccess = settingsNow.lanAccess === true;
      const host = this.state.lanAccess ? '0.0.0.0' : '127.0.0.1';
      this.server = createServer({
        bridge: this,
        apiKey: this.state.apiKey,
        dataDir: settings.dataDir(),
        log: (m) => this.log(m),
        lanAccess: this.state.lanAccess,
      });
      await new Promise((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(port, host, resolve);
      });
      this.state.port = this.server.address().port;

      this.state.zcode = await zcode.status();
      // 顺带把逐目标状态也实读一遍：崩溃重启后，快照按配置文件的真实内容显示
      await this.listTargetStates();
      this.state.phase = 'ready';
      this.log(`OC Faucet 已就绪：转发口 http://127.0.0.1:${this.state.port}`);
      this.#startAutoRetry();

      // 端口先开着，再用缓存里的体检结论把模型恢复出来（不发请求、不花额度）。
      // 放在 listen 之后：这一步要问上游，失败了也不该让端口起不来。
      try {
        const restored = await this.restore();
        await this.#syncPendingContextWindowTargets();
        const available = this.getModels().length;
        if (available) {
          this.log(`  可用模型 ${available} 个${restored ? `（其中 ${restored} 个来自上次体检）` : ''}。`);
        } else {
          this.log('  还没有可用的模型——接入工具现在提问会提示模型不存在。');
          this.log('  先体检一次：npm start -- --probe 12 --import');
        }
      } catch (error) {
        this.log(`  恢复模型失败：${error?.message ?? error}`);
      }
    } catch (error) {
      this.state.phase = 'error';
      this.state.error = error?.message ?? String(error);
      throw error;
    }
  }

  /**
   * 重启：把转发口和 OpenCode 整个先关再开，控制面板不受影响。
   *
   * 页面上那个「重启服务」按钮就是调它。**不动各接入目标的配置**（停服摘除只在
   * 真正停服时做）——端口和密钥都没变，重启后那些工具照常能用。
   */
  async restart() {
    await this.stop({ uninstall: false });
    await this.start();
    return this.snapshot();
  }

  /**
   * 切换上游方案（内嵌 OpenCode ⇄ Bun 侧车直连 zen）。
   *
   * 端口、密钥、各接入目标里已写入的配置一概不动（模型 id 两方案同款）。
   * 服务在跑就热切换：**先把新方案起起来**，成了再停旧的——新方案起不来时
   * 原地回滚（设置、客户端、判定都退回去），绝不留一个两头都不可用的状态。
   * 有在途请求/体检/上下文变更时拒绝切换（409），等它们做完再来。
   * @param {'embedded'|'masquerade'} mode
   */
  async setUpstreamMode(mode) {
    if (mode !== 'embedded' && mode !== 'masquerade') {
      throw new BridgeError(
        `没有叫「${mode}」的上游方案。现在支持的是：embedded（内嵌）、masquerade（伪装）。`,
        400,
        'invalid_upstream_mode',
      );
    }
    if (this.contextWindowChangeInFlight || this.activePromptCount > 0 || this.activeRefreshCount > 0) {
      throw new BridgeError(
        '有请求或体检正在跑，暂时不能切换方案；等它们结束再试。',
        409,
        'upstream_mode_busy',
      );
    }

    const settingsNow = await settings.readSettings();
    if (settingsNow.upstreamMode === mode) {
      this.state.mode = mode;
      return { ok: true, mode, changed: false };
    }

    const previousMode = this.state.mode;
    const previousClient = this.client;
    const running = Boolean(previousClient?.ready);

    await settings.writeSettings({ upstreamMode: mode });
    this.state.mode = mode;

    // 没在跑：只落盘，下次启动按新方案起
    if (!running) return { ok: true, mode, changed: true };

    // 热切换：先起新的，成了再停旧的；失败原地回滚
    let nextClient;
    try {
      nextClient = this.#clientFactory(mode);
      await nextClient.start();
    } catch (error) {
      await nextClient?.stop().catch(() => {});
      await settings.writeSettings({ upstreamMode: previousMode });
      this.state.mode = previousMode;
      this.client = previousClient;
      throw new BridgeError(
        `切换到${mode === 'masquerade' ? '伪装' : '内嵌'}方案失败，已退回原来的${previousMode === 'masquerade' ? '伪装' : '内嵌'}方案：${error?.message ?? error}`,
        502,
        'upstream_mode_switch_failed',
      );
    }

    this.client = nextClient;
    await previousClient.stop().catch(() => {});
    this.state.upstream = { ready: true, baseUrl: nextClient.baseUrl };

    // 判定按方案分开记：清掉旧的，从缓存按新方案的指纹恢复（不发请求、不花额度）
    this.state.verdicts.clear();
    try {
      const restored = await this.restore();
      const available = this.getModels().length;
      this.log(`已切换到${mode === 'masquerade' ? '伪装' : '内嵌'}方案，可用模型 ${available} 个${restored ? `（其中 ${restored} 个来自该方案上次的体检结论）` : ''}。`);
    } catch (error) {
      this.log(`方案已切换，但恢复模型清单失败：${error?.message ?? error}`);
    }
    return { ok: true, mode, changed: true };
  }

  /**
   * 路由器广播：开/关转发口对局域网的可见性。
   *
   * 默认转发口只绑 127.0.0.1（别的机器连不进来）；开启后绑 0.0.0.0，
   * 局域网设备凭密钥接入——密钥与 Origin 围栏（浏览器页面照样 403）都不变。
   * 端口保持不变：先关旧口再用同一个端口重绑（中间只有几毫秒的空窗，
   * 换端口会害得所有已写入工具集体 404，不值当）。有在途请求/体检时 409 拒绝。
   * @param {boolean} enabled
   */
  async setLanAccess(enabled) {
    if (typeof enabled !== 'boolean') {
      throw new BridgeError('路由器广播开关只接受 true / false。', 400, 'invalid_lan_access');
    }
    if (this.contextWindowChangeInFlight || this.activePromptCount > 0 || this.activeRefreshCount > 0) {
      throw new BridgeError('有请求或体检正在跑，暂时不能切换局域网访问；等它们结束再试。', 409, 'lan_access_busy');
    }

    const current = await settings.readSettings();
    if (current.lanAccess === enabled) {
      this.state.lanAccess = enabled;
      return { ok: true, lanAccess: enabled, changed: false };
    }
    await settings.writeSettings({ lanAccess: enabled });
    this.state.lanAccess = enabled;

    // 转发口没在跑：只落盘，下次启动按新设置绑
    if (!this.server) {
      this.log(enabled ? '路由器广播已开启（服务未运行，下次启动生效）' : '路由器广播已关闭（服务未运行，下次启动生效）');
      return { ok: true, lanAccess: enabled, changed: true };
    }

    // 热重绑：同一个端口，先关旧口再绑新口。绑定失败时按原设置尽力拉回来。
    const old = this.server;
    const port = old.address().port;
    this.server = null;
    await this.#closeServer(old);
    try {
      this.server = await this.#listenServer(port, enabled);
      this.state.port = this.server.address().port;
    } catch (error) {
      await settings.writeSettings({ lanAccess: !enabled });
      this.state.lanAccess = !enabled;
      try {
        this.server = await this.#listenServer(port, !enabled);
        this.state.port = this.server.address().port;
      } catch (restoreError) {
        this.log(`转发口重绑失败后回滚也失败了（端口 ${port}）：${restoreError?.message ?? restoreError}`);
      }
      throw new BridgeError(
        `转发口重绑失败（端口 ${port} 可能被占）：${error?.message ?? error}。已按原设置回滚。`,
        500,
        'lan_access_rebind_failed',
      );
    }
    const addresses = this.#lanAddresses();
    this.log(
      enabled
        ? `路由器广播已开启：局域网设备可用 ${addresses.map((a) => `http://${a.address}:${this.state.port}`).join('、')} 接入（凭密钥）`
        : '路由器广播已关闭：转发口回到只听本机（127.0.0.1）',
    );
    return { ok: true, lanAccess: enabled, changed: true };
  }

  /** 建一个按当前密钥/配置的转发口并监听到指定地址（内部 helper，失败抛原错误） */
  #listenServer(port, lanAccess) {
    const server = createServer({
      bridge: this,
      apiKey: this.state.apiKey,
      dataDir: settings.dataDir(),
      log: (m) => this.log(m),
      lanAccess,
    });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, lanAccess ? '0.0.0.0' : '127.0.0.1', () => resolve(server));
    });
  }

  /** 关一个转发口：空闲连接先收掉，3 秒还没关完就强拆（与 stop() 同一口径） */
  async #closeServer(server) {
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        server.closeAllConnections?.();
        finish();
      }, 3_000);
      server.close(finish);
      server.closeIdleConnections?.();
    });
  }

  /** 本机在局域网里的 IPv4 地址（跳过回环与虚拟项；192.168 优先排前面） */
  #lanAddresses() {
    const seen = new Set();
    const out = [];
    for (const list of Object.values(networkInterfaces())) {
      for (const ni of list ?? []) {
        if (!ni || ni.internal) continue;
        if (ni.family !== 'IPv4' && ni.family !== 4) continue;
        const address = typeof ni.address === 'string' ? ni.address : '';
        if (!address || seen.has(address)) continue;
        seen.add(address);
        out.push({ address, cidr: ni.cidr ?? null });
      }
    }
    return out.sort((a, b) => {
      const rank = (addr) => (addr.startsWith('192.168.') ? 0 : addr.startsWith('10.') ? 1 : addr.startsWith('172.') ? 2 : 3);
      return rank(a.address) - rank(b.address);
    });
  }

  /**
   * 局域网接入信息（地址清单、密钥、教程要用的模型 id）。
   * 密钥只经这条面板专用通道给，快照 snapshot() 依旧不带。
   */
  async lanInfo() {
    const apiKey = await this.getApiKey();
    const usable = this.getModels().map((m) => m.id);
    return {
      lanAccess: this.state.lanAccess === true,
      port: this.state.port,
      addresses: this.#lanAddresses().map((a) => ({ ...a, url: `http://${a.address}:${this.state.port}` })),
      apiKey,
      modelIds: usable,
    };
  }

  /**
   * 停服：先把各接入目标里我们写入的配置逐个摘掉，再关端口和 OpenCode。
   *
   * 逐目标摘除是对「关服务配置保留」旧行为的有意变更：服务一停，留下的配置
   * 只会指向一个没人听的死端口，不如摘干净；下次要用，启动后重新写入即可。
   * 传 uninstall:false 跳过摘除（面板「重启服务」、启动失败的收摊走这条路）。
   */
  async stop({ uninstall = true } = {}) {
    this.#stopAutoRetry();
    if (uninstall) await this.#uninstallWrittenTargets();
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        // 3 秒还没关完就强拆：重启/停止不该被一个卡住的流式请求拖住。
        // 空闲的 keep-alive 连接会一直挡着 close 回调，先把它们收掉。
        const timer = setTimeout(() => {
          server.closeAllConnections?.();
          finish();
        }, 3_000);
        server.close(finish);
        server.closeIdleConnections?.();
      });
    }
    if (this.client) {
      await this.client.stop();
      this.client = null;
    }
    this.state.port = null;
    this.state.upstream.ready = false;
    this.state.phase = 'idle';
  }

  /**
   * 停服前的统一摘除：实读一遍各目标状态，凡「当前已写入」的逐个摘掉。
   * 未写入的目标一个写动作都不做；单个目标摘失败只记日志、继续摘其余的——
   * 摘不动不该拦着服务关停。崩溃等非常规退出走不到这里；下次启动时
   * 各目标状态一律以配置文件实读为准（见 listTargetStates）。
   */
  async #uninstallWrittenTargets() {
    const states = await this.listTargetStates();
    for (const s of states) {
      if (!s.written) continue;
      try {
        await this.uninstallTarget(s.id);
      } catch (error) {
        this.log(`停服时摘除 ${s.label} 的配置失败：${error?.message ?? error}`);
      }
    }
  }

  /** 体检缓存按方案分指纹：两种上游各自记结论，来回切换互不污染 */
  #probeFingerprint() {
    return this.state.mode === 'masquerade' ? `${PROBE_FINGERPRINT}-zen` : PROBE_FINGERPRINT;
  }

  /**
   * 拉一遍模型目录，再用磁盘上的体检结论回填。**不发任何请求**。
   *
   * 为什么启动时必须做：转发口是各接入工具的入口，它只认「有判定、且判定可用」的模型
   * （见 getModels）。少了这一步，端口虽然开着，却一个模型都不认——接入工具每次
   * 提问都会收到「模型不存在」，而界面上还显示一切正常。
   *
   * 体检很贵（真的发消息、等模型回话），所以这里只读缓存，不替用户花额度。
   *
   * @returns {Promise<number>} 回填了几个模型
   */
  async restore() {
    if (!this.client?.ready) throw new BridgeError('OpenCode 还没起来', 503, 'not_ready');
    // refresh 里会重新加载缓存文件，所以顺序不能反
    const models = await this.refresh();
    let restored = 0;

    for (const model of models) {
      if (this.state.verdicts.has(model.id)) continue; // 内存里已有更新的结论，别覆盖
      let hit = null;
      try {
        hit = this.cache?.get(model.id, this.#probeFingerprint()) || null;
      } catch (error) {
        // 缓存坏了最多让体检重跑一遍，不该拦着端口起来
        this.log(`读体检缓存失败：${error?.message ?? error}`);
        hit = null;
      }
      if (!hit) continue;
      this.state.verdicts.set(model.id, {
        verdict: hit.verdict,
        note: hit.note,
        elapsedMs: null,
        checkedAt: hit.checkedAt,
        cached: true,
      });
      restored += 1;
    }
    return restored;
  }

  /** 拉取模型目录（不体检） */
  async refresh() {
    const waitForChange = this.#reserveRefresh();
    if (waitForChange) await waitForChange;
    try {
      if (!this.client?.ready) throw new BridgeError('OpenCode 还没起来', 503, 'not_ready');
      const payload = await this.client.providers();
      const all = collectModels(payload);
      const settingsNow = await settings.readSettings();
      const canUseOverrides = this.client.isolate !== false;
      // 水龙头只放 OpenCode 官方那家的免费模型；用户在 OpenCode 里另外配的供应商
      //（阿里、OpenAI、智谱……）花的是他自己的钱，不该替他决定（见 faucetModels）。
      this.state.models = faucetModels(all).map((model) => {
        const override = canUseOverrides ? settingsNow.modelContextWindows[model.id] ?? null : null;
        const pending = canUseOverrides && Object.hasOwn(settingsNow.modelContextWindowPending, model.id);
        const upstreamLimits = canUseOverrides
          ? settingsNow.modelContextWindowOriginals[model.id] ?? model.upstreamLimits
          : model.upstreamLimits;
        const upstreamContextWindow = upstreamLimits.context ?? model.contextWindow ?? null;
        const desiredContext = pending ? settingsNow.modelContextWindowPending[model.id] : override;
        const expected = desiredContext === null
          ? usableContextLimit(upstreamLimits, null)
          : usableContextLimit(upstreamLimits, desiredContext);
        const contextWindowPending = canUseOverrides && (
          pending || (override !== null && (!expected || !contextLimitsMatch(model.upstreamLimits, expected)))
        );
        return {
          ...model,
          upstreamLimits: { ...model.upstreamLimits },
          upstreamContextWindow,
          contextWindowOverride: override,
          // 只展示 OpenCode 当前实际返回的窗口；本机保存的目标值可能还没同步成功。
          contextWindow: model.contextWindow,
          contextWindowPending,
        };
      });
      this.cache = new ProbeCache({
        file: settings.probeCacheFile(),
        ttlMs: settingsNow.probeTtlMinutes * 60 * 1000,
      });
      await this.cache.load();
      return this.state.models;
    } finally {
      this.activeRefreshCount -= 1;
    }
  }

  #contextWindowBusyError() {
    const message = this.contextWindowChangeInFlight
      ? '正在保存模型上下文设置，请等它完成后再试。'
      : '模型正在处理请求，暂时不能改上下文长度；等请求结束后再试。';
    return new BridgeError(message, 409, 'context_window_busy');
  }

  #reservePrompt() {
    if (this.contextWindowChangeInFlight) {
      return this.contextWindowChangePromise.then(() => this.#reservePrompt());
    }
    this.activePromptCount += 1;
    return null;
  }

  #reserveRefresh() {
    if (this.contextWindowChangeInFlight) {
      return this.contextWindowChangePromise.then(() => this.#reserveRefresh());
    }
    this.activeRefreshCount += 1;
    return null;
  }

  /** 启动时把已保存的期望值重新写回隔离 OpenCode，确保升级或异常退出后仍生效。 */
  async #applyPersistedContextWindows() {
    if (!this.client || this.client.isolate === false) return;
    const saved = await settings.readSettings();
    const ids = new Set([
      ...Object.keys(saved.modelContextWindows),
      ...Object.keys(saved.modelContextWindowPending),
    ]);
    if (!ids.size) return;

    const currentModels = collectModels(await this.client.providers());
    const byId = new Map(currentModels.map((model) => [model.id, model]));
    const entries = [];
    const expectedById = new Map();
    for (const id of ids) {
      const currentModel = byId.get(id);
      if (!currentModel) continue;
      const parsed = parseModelId(id);
      const original = saved.modelContextWindowOriginals[id];
      const context = Object.hasOwn(saved.modelContextWindowPending, id)
        ? saved.modelContextWindowPending[id]
        : saved.modelContextWindows[id];
      const expected = usableContextLimit(original, context ?? null);
      if (parsed?.providerID !== 'opencode' || !original) {
        this.log(`跳过模型 ${id} 的上下文恢复：缺少可安全还原的原始限制。`);
        continue;
      }
      if (!expected) {
        this.log(`跳过模型 ${id} 的上下文恢复：缺少可安全还原的原始限制。`);
        continue;
      }
      if (contextLimitsMatch(currentModel.upstreamLimits, expected)) continue;
      entries.push({
        modelID: parsed.modelID,
        limit: expected,
      });
      expectedById.set(id, expected);
    }
    if (!entries.length) return;

    await this.client.setModelContextWindows(entries);
    const after = new Map(collectModels(await this.client.providers()).map((model) => [model.id, model]));
    for (const [id, expected] of expectedById) {
      const updated = after.get(id);
      if (!updated || !contextLimitsMatch(updated.upstreamLimits, expected)) {
        throw new BridgeError(
          `OpenCode 没有确认模型 ${id} 的上下文限制已生效；本机仍保留设置，稍后会重试。`,
          502,
          'context_window_sync_failed',
        );
      }
    }
  }

  /** 重启后模型与端口都恢复后，补做上次未完成的已写入目标同步。 */
  async #syncPendingContextWindowTargets() {
    if (!this.server || !this.client?.ready) return;
    const current = await settings.readSettings();
    const pendingIds = Object.keys(current.modelContextWindowPending);
    if (!pendingIds.length) return;

    const ready = [];
    for (const id of pendingIds) {
      const model = this.state.models.find((item) => item.id === id);
      const baseline = current.modelContextWindowOriginals[id];
      const desired = current.modelContextWindowPending[id];
      const expected = usableContextLimit(baseline, desired);
      if (!model || !expected || !contextLimitsMatch(model.upstreamLimits, expected)) continue;
      ready.push({ id, desired, baseline });
    }
    if (!ready.length) return;

    const failures = await this.#syncWrittenTargets();
    if (failures.length) {
      this.log(`上下文设置已在 OpenCode 确认，但接入目标仍待同步：${failures.join('；')}`);
      return;
    }

    const overrides = { ...current.modelContextWindows };
    const originals = { ...current.modelContextWindowOriginals };
    const pending = { ...current.modelContextWindowPending };
    for (const { id, desired, baseline } of ready) {
      if (desired === null) {
        delete overrides[id];
        delete originals[id];
      } else {
        overrides[id] = desired;
        originals[id] = baseline;
      }
      delete pending[id];
    }
    await settings.writeSettings({
      modelContextWindows: overrides,
      modelContextWindowOriginals: originals,
      modelContextWindowPending: pending,
    });
    for (const { id, desired, baseline } of ready) {
      this.#applyContextWindowState(id, this.state.models.find((item) => item.id === id), baseline, desired, false);
    }
  }

  #applyContextWindowState(id, model, baseline, desired, pending) {
    if (!model) return;
    const updated = {
      ...model,
      upstreamContextWindow: baseline.context,
      contextWindowOverride: desired === null ? null : desired,
      contextWindowPending: pending,
    };
    this.state.models = this.state.models.map((item) => item.id === id ? updated : item);
  }

  /**
   * 体检模型。
   * @param {object} [o]
   * @param {boolean} [o.force] 忽略缓存强制重测
   * @param {number} [o.limit]  只测前 N 个（验证脚本与排障用；不传就是全部）
   * @param {boolean} [o.onlyFailed] 只重测当前判定为 failed 的模型（自动重试用）
   * @param {number} [o.timeoutMs] 单个模型的超时，默认交给 probe.js
   */
  async probe({ force = false, limit, onlyFailed = false, timeoutMs } = {}) {
    const waitForChange = this.#reservePrompt();
    if (waitForChange) await waitForChange;
    try {
      const all = this.state.models.length ? this.state.models : await this.refresh();
      // 只重测失败的那批（自动重试路径）；正常路径测全部
      const pool = onlyFailed
        ? all.filter((m) => this.state.verdicts.get(m.id)?.verdict === 'failed')
        : all;
      if (!pool.length) return [];
      // 现在只有 opencode 一家，摊开其实是个原样复制的空操作；留着是因为：
      // 万一以后放开到多家，这一段能自动按来源轮流取，不会一头撞死在同一个来源上。
      const ordered = interleaveByProvider(pool);
      const models = Number.isInteger(limit) && limit > 0 ? ordered.slice(0, limit) : ordered;
      if (!models.length) return [];
      const settingsNow = await settings.readSettings();
      this.state.phase = 'probing';
      this.state.progress = { done: 0, total: models.length };
      try {
        const results = await probeMany({
          client: this.client,
          models,
          workdir: settings.workspaceDir(),
          concurrency: settingsNow.probeConcurrency,
          cache: this.cache,
          force,
          fingerprint: this.#probeFingerprint(),
          ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
          onProgress: ({ done, total, model, result }) => {
            this.state.progress = { done, total };
            this.state.verdicts.set(model.id, result);
            this.log(`[${done}/${total}] ${model.name} → ${result.verdict}${result.cached ? '（缓存）' : ''}`);
          },
        });
        for (const r of results) this.state.verdicts.set(r.model.id, r);
        return results;
      } finally {
        this.state.progress = null;
        this.state.phase = 'ready';
      }
    } finally {
      this.activePromptCount -= 1;
    }
  }

  /**
   * 失败自动重试：免费池几分钟就轮换一批，「体检失败」多半是"那一刻路由不到"，
   * 不是永久结论。失败判定在缓存里只活 10 分钟；这个定时器到点把仍处失败态的
   * 模型重测一遍（只测失败的，成功的照旧吃长 TTL 缓存）。只在空闲时跑，
   * 绝不和用户手上的请求/体检抢上游。
   */
  #startAutoRetry() {
    this.#stopAutoRetry();
    const timer = setInterval(() => {
      void this.#retryFailed().catch((error) => {
        this.log(`失败自动重试出错（下个周期照常）：${error?.message ?? error}`);
      });
    }, this.autoRetryIntervalMs);
    timer.unref?.();
    this.#autoRetryTimer = timer;
  }

  #stopAutoRetry() {
    if (this.#autoRetryTimer) {
      clearInterval(this.#autoRetryTimer);
      this.#autoRetryTimer = null;
    }
  }

  async #retryFailed() {
    if (this.state.phase !== 'ready' || !this.state.models.length) return;
    if (this.activePromptCount > 0 || this.activeRefreshCount > 0 || this.contextWindowChangeInFlight) return;
    const failed = this.state.models.filter((m) => this.state.verdicts.get(m.id)?.verdict === 'failed');
    if (!failed.length) return;
    this.log(`自动重试 ${failed.length} 个体检失败的模型（池子轮换后它们可能已恢复）……`);
    // onlyFailed 已经筛过"内存里是失败态"，重试就必须真测这批——
    // 不带 force 会撞上还没过期的失败缓存白等一拍（定时器整点醒、TTL 差几秒才到）
    await this.probe({ onlyFailed: true, force: true });
  }

  /** 按 id 找注册表里的目标；不认识就报人话 */
  #target(id) {
    const target = this.targets.find((t) => t.id === id);
    if (!target) {
      const known = this.targets.map((t) => t.id).join('、') || '（空）';
      throw new BridgeError(`没有叫「${id}」的接入目标。现在支持的目标：${known}`, 404, 'target_not_found');
    }
    return target;
  }

  /**
   * 逐目标的真实状态：每次都实读各目标的配置文件，不信内存残留。
   * 结果顺手存进 state.targets，snapshot() 是同步的，只能拿这次实读的缓存。
   */
  async listTargetStates() {
    const states = [];
    for (const target of this.targets) {
      let detected = false;
      let written = false;
      let models = [];
      try {
        detected = target.detect() === true;
        const s = await target.status();
        written = s?.written === true;
        models = Array.isArray(s?.models) ? s.models : [];
      } catch (error) {
        // 单个目标读炸了不该拖垮整份清单
        this.log(`读取接入目标 ${target.id} 的状态失败：${error?.message ?? error}`);
      }
      states.push({
        id: target.id,
        label: target.label,
        detected,
        written,
        models,
        // 界面靠这个标记决定「写入」是直接写还是先让用户勾模型
        selectsModels: target.selectsModels === true,
      });
    }
    this.state.targets = states;
    return states;
  }

  /** 把「能用」的模型写进指定目标；支持目标级模型选择的目标可以指定写哪几个 */
  async installTarget(id, { modelIds } = {}) {
    const target = this.#target(id);
    const models = await this.#selectedForTarget(target, modelIds);
    const result = await target.install(models, { port: this.state.port, apiKey: this.state.apiKey });
    await this.#refreshAfterTargetChange(id);
    return result;
  }

  /**
   * 决定这一次写给目标的模型清单。
   * 界面显式指定就用指定的；没指定时用上次记住的那份（体检后已不可用的自动剔掉）；
   * 从没选过就全部写入。记住选择是为了改密钥、改上下文之后的重写不会偷偷扩大范围。
   */
  async #selectedForTarget(target, modelIds) {
    const usable = this.getModels();
    if (target.selectsModels !== true) return usable;
    const saved = (await settings.readSettings()).targetModels;
    if (Array.isArray(modelIds)) {
      const picked = usable.filter((model) => modelIds.includes(model.id));
      if (!picked.length) {
        throw new BridgeError(
          '至少要选一个可用模型才能写入。请先在模型清单里点「检测全部」，再回来勾选。',
          400,
          'no_models_selected',
        );
      }
      await settings.writeSettings({ targetModels: { ...saved, [target.id]: picked.map((model) => model.id) } });
      return picked;
    }
    const remembered = (saved[target.id] ?? []).length
      ? usable.filter((model) => saved[target.id].includes(model.id))
      : [];
    return remembered.length ? remembered : usable;
  }

  /** 从指定目标里摘掉我们写入的配置 */
  async uninstallTarget(id) {
    const target = this.#target(id);
    const result = await target.uninstall();
    await this.#refreshAfterTargetChange(id);
    return result;
  }

  /** 目标配置变过之后的统一收尾：实读一次各目标状态；ZCode 的旧快照字段界面还在读，一并刷新 */
  async #refreshAfterTargetChange(id) {
    if (id === 'zcode') this.state.zcode = await zcode.status();
    await this.listTargetStates();
  }

  /** 只重写当前实际已写入的目标；状态读失败也要向调用者说明。 */
  async #syncWrittenTargets() {
    const failures = [];
    for (const target of this.targets) {
      let status;
      try {
        status = await target.status();
      } catch (error) {
        failures.push(`${target.label}（读取状态失败：${error?.message ?? error}）`);
        continue;
      }
      if (status?.written !== true) continue;
      try {
        await this.installTarget(target.id);
      } catch (error) {
        failures.push(`${target.label}（${error?.message ?? error}）`);
      }
    }
    await this.listTargetStates();
    return failures;
  }

  /** 把「能用」的模型写进 ZCode（旧入口，界面与 CLI 还在用；等价于 installTarget('zcode')） */
  async import() {
    return this.installTarget('zcode');
  }

  /** 从 ZCode 里摘掉（旧入口，等价于 uninstallTarget('zcode')） */
  async uninstall() {
    return this.uninstallTarget('zcode');
  }

  /**
   * 当前转发口密钥（供带令牌的面板接口用；快照 snapshot() 依旧不携带它）。
   * 桥还没起时读数据目录里那份——没有才会现生成一个随机值，行为同首次安装。
   */
  async getApiKey() {
    if (this.state.apiKey) return this.state.apiKey;
    this.state.apiKey = await settings.apiKey();
    return this.state.apiKey;
  }

  /**
   * 换转发口密钥：校验 → 落盘（0600）→ 转发口立即换用 → 级联重写所有已写入目标。
   *
   * 级联这步不能省：密钥一换旧的全作废，已写入的配置里还是旧密钥，
   * 不重写的话那些工具立刻集体 401。转发口没在跑时只落盘，
   * 不去动目标配置（手上一份可信的模型清单都没有，重写只会写坏）。
   */
  async setApiKey(newKey) {
    // 校验 + 落盘；空密钥在这一步就被拒，后面的副作用一个都不会发生
    const key = await settings.saveApiKey(newKey);
    this.state.apiKey = key;
    this.server?.setApiKey?.(key); // 转发口在跑就立刻换用，不用重启进程

    if (!this.server) return { ok: true };

    // 级联重写：只碰「当前已写入」的目标；失败的记下来继续，最后一起报
    const states = await this.listTargetStates();
    const failures = [];
    for (const s of states) {
      if (!s.written) continue;
      try {
        await this.installTarget(s.id);
      } catch (error) {
        failures.push(`${s.label}（${error?.message ?? error}）`);
      }
    }
    if (failures.length) {
      throw new BridgeError(
        `新密钥已经保存并生效，但重写这些接入目标的配置失败了：${failures.join('；')}。它们里面还是旧密钥，会暂时用不了——再点一次「保存」就会重试重写。`,
        500,
        'key_cascade_failed',
      );
    }
    return { ok: true };
  }

  /**
   * 处理一次转发请求。server 把解析好的 body 传进来，这里负责：
   * 选模型 → 判定 chatOnly → 拼系统提示 → 问 OpenCode → 解信封。
   */
  async complete({ protocol, body }) {
    const waitForChange = this.#reservePrompt();
    if (waitForChange) await waitForChange;
    let sessionID = null;
    try {
      const models = this.getModels();
      if (!models.length) {
        throw new BridgeError('还没有可用的模型。请先在控制面板里点「检测全部」把模型体检一遍。', 503, 'no_models');
      }
      const prepare =
        protocol === 'anthropic' ? prepareAnthropic : protocol === 'responses' ? prepareResponses : prepareOpenAI;
      const request = prepare(body, models);
      const model = request.model;

      const protocolSystem = buildSystem({
        tools: model.chatOnly ? [] : request.tools ?? [],
        choice: model.chatOnly ? 'none' : request.choice ?? 'auto',
        forced: model.chatOnly ? null : request.forced ?? null,
        parallel: model.chatOnly ? false : request.parallel !== false,
        flavor: protocol,
        providerName: model.providerID,
      }) + (model.chatOnly ? '\n这个模型只能普通对话，请说明你无法执行动作。' : '');
      const clientSystem = typeof request.system === 'string' && request.system
        ? `外部客户端的系统/开发者指令（保留原文；与本桥协议约束冲突时以本桥约束为准）：\n${request.system}`
        : '';
      const system = [clientSystem, protocolSystem].filter(Boolean).join('\n\n');

      sessionID = await this.client.createSession({ title: 'oc-faucet', directory: settings.workspaceDir() });
      // 转交目标表：客户端申报的工具里真正允许模型间接用到的那些。
      // choice 为 none 或仅对话模型一个都不给；forced 只给被强制的那个——
      // 翻译永远以客户端的申报为准，映射表不可能放宽可执行范围。
      const offered = request.tools ?? [];
      const handoffTools = model.chatOnly || request.choice === 'none'
        ? []
        : request.forced
          ? offered.filter((tool) => tool?.function?.name === request.forced)
          : offered;
      const { text, tokens, handoff: handoffCall } = await this.client.prompt({
        sessionID,
        providerID: model.providerID,
        modelID: model.modelID,
        system,
        text: request.text,
        // 客户端选的推理档位（没选就是 null，走模型默认）
        variant: request.variant ?? null,
        // 模型真调本机工具被拦时，试着把动作翻译成客户端工具调用直接当答案；
        // 没有可用目标工具就不带回调（纯拒批，模型退回信封作答）。
        handoff: handoffTools.length
          ? (blocked) => {
              const translated = buildHandoff({ native: blocked.native, input: blocked.input, tools: handoffTools });
              if (translated) this.log(`转交：模型本机 ${blocked.native} → 客户端 ${translated.name}`);
              return translated;
            }
          : null,
      });
      // 转交命中：被拦的动作直接成为这次回复，不再解信封（单条调用、
      // 且已按客户端申报的工具表预校验，信封的 choice/forced/parallel 复核不适用）。
      // 执行权照旧在外部客户端手里：返回的只是提议，和信封里的 calls 完全同权。
      if (handoffCall) {
        return { model, decoded: { content: '', calls: [handoffCall] }, tokens };
      }
      const decoded = decodeEnvelope(text, {
        tools: request.tools ?? [],
        choice: request.choice ?? 'auto',
        forced: request.forced ?? null,
        parallel: request.parallel !== false,
      });
      if (model.chatOnly && decoded.calls.length) {
        throw new BridgeError('这个模型只能普通对话，不支持执行动作', 502, 'tools_not_supported');
      }
      return { model, decoded, tokens };
    } finally {
      if (sessionID) this.client.deleteSession(sessionID).catch(() => {});
      this.activePromptCount -= 1;
    }
  }

  /** 记一行请求日志（不含任何密钥） */
  async logRequest(entry) {
    try {
      await appendFile(settings.requestsLogFile(), `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
    } catch {
      /* 日志写不进去不该影响主流程 */
    }
  }

  /* ---------- 给桌面界面用的门面 ---------- */
  /* 界面只能通过这些方法做事，拿不到内部的 client/server，更拿不到密钥。 */

  readSettings() {
    return settings.readSettings();
  }

  /**
   * 修改单个模型的上下文上限。null 会恢复第一次修改前 OpenCode 返回的原始限制。
   *
   * 先落盘期望值和原始限制，再写 OpenCode：如果应用在中途退出，下次启动会重放期望值；
   * 上游明确拒绝时则撤回本地期望值，避免界面把失败当成功。
   */
  async setModelContextWindow(id, value) {
    if (value !== null && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new BridgeError('上下文长度必须是正整数，或留空恢复默认值。', 400, 'invalid_context_window');
    }
    if (this.contextWindowChangeInFlight || this.activePromptCount > 0 || this.activeRefreshCount > 0) {
      throw this.#contextWindowBusyError();
    }
    const model = this.state.models.find((item) => item.id === id);
    if (!model) throw new BridgeError('找不到这个模型，可能目录刚刷新过。', 404, 'model_not_found');
    const parsed = parseModelId(id);
    if (!parsed || parsed.providerID !== 'opencode' || model.providerID !== 'opencode') {
      throw new BridgeError('只能修改 OpenCode 官方免费池里的模型。', 400, 'invalid_context_window_model');
    }
    if (!this.client?.ready) throw new BridgeError('OpenCode 还没起来，暂时不能保存模型上下文长度。', 503, 'not_ready');
    if (this.state.mode === 'masquerade') {
      throw new BridgeError(
        '伪装模式由内置 Bun 侧车直连 zen，没有可修改的模型上下文设置。切回内嵌方案后再改。',
        409,
        'context_window_unsupported_mode',
      );
    }
    if (this.client.isolate === false) {
      throw new BridgeError('当前 OpenCode 没有运行在隔离目录里，不能安全改它的全局模型设置。', 409, 'context_window_requires_isolation');
    }

    this.contextWindowChangeInFlight = true;
    this.contextWindowChangePromise = new Promise((resolve) => {
      this.resolveContextWindowChange = resolve;
    });
    try {
      const current = await settings.readSettings();
      const currentOverride = current.modelContextWindows[id] ?? null;
      const hasPending = Object.hasOwn(current.modelContextWindowPending, id);
      if (value === null && currentOverride === null && !hasPending) return { ok: true };

      const storedOriginal = current.modelContextWindowOriginals[id];
      if ((currentOverride !== null || hasPending) && !storedOriginal) {
        throw new BridgeError(
          '本机没有保存这个模型第一次修改前的限制，无法安全确认或恢复；请先刷新模型清单。',
          422,
          'context_window_original_missing',
        );
      }
      const candidate = storedOriginal ?? model.upstreamLimits;
      const baseline = {};
      if (Number.isSafeInteger(candidate?.context) && candidate.context > 0) baseline.context = candidate.context;
      if (Number.isSafeInteger(candidate?.input) && candidate.input >= 0) baseline.input = candidate.input;
      if (Number.isSafeInteger(candidate?.output) && candidate.output > 0) baseline.output = candidate.output;
      if (!baseline.context || !baseline.output) {
        throw new BridgeError(
          'OpenCode 没给出完整的原始上下文和输出上限，无法保证以后能恢复默认值，所以这次没有保存。',
          422,
          'context_window_unavailable',
        );
      }

      const nextOverrides = { ...current.modelContextWindows };
      // 恢复值要等 OpenCode 与已写入目标都确认完成后再删除，失败时仍能重试。
      if (value !== null) nextOverrides[id] = value;
      const nextOriginals = { ...current.modelContextWindowOriginals, [id]: baseline };
      const nextPending = { ...current.modelContextWindowPending, [id]: value };
      await settings.writeSettings({
        modelContextWindows: nextOverrides,
        modelContextWindowOriginals: nextOriginals,
        modelContextWindowPending: nextPending,
      });

      // 即使上游暂时失败，快照也要准确显示“目标值已保存，正在等待同步”。
      const pendingView = {
        ...model,
        upstreamContextWindow: baseline.context,
        contextWindowOverride: value === null ? currentOverride : value,
        contextWindowPending: true,
      };
      this.state.models = this.state.models.map((item) => item.id === id ? pendingView : item);

      const limit = contextLimitFor(baseline, value);
      let actualModel;
      try {
        await this.client.setModelContextWindows([{ modelID: parsed.modelID, limit }]);
        actualModel = collectModels(await this.client.providers()).find((item) => item.id === id);
        if (!actualModel || !contextLimitsMatch(actualModel.upstreamLimits, limit)) {
          if (actualModel) {
            this.state.models = this.state.models.map((item) => item.id === id ? {
              ...pendingView,
              upstreamLimits: actualModel.upstreamLimits,
              contextWindow: actualModel.contextWindow,
            } : item);
          }
          throw new BridgeError(
            'OpenCode 没有确认新的上下文限制已经生效。设置已保留，稍后可以重试。',
            502,
            'context_window_sync_unconfirmed',
          );
        }
      } catch (error) {
        if (error?.code === 'upstream_config_error') {
          try {
            await settings.writeSettings({
              modelContextWindows: current.modelContextWindows,
              modelContextWindowOriginals: current.modelContextWindowOriginals,
              modelContextWindowPending: current.modelContextWindowPending,
            });
            this.state.models = this.state.models.map((item) => item.id === id ? model : item);
          } catch (rollbackError) {
            throw new BridgeError(
              `OpenCode 拒绝了这次修改，本机设置回滚也失败了：${rollbackError?.message ?? rollbackError}。请重试保存。`,
              500,
              'context_window_rollback_failed',
            );
          }
          throw error;
        }
        throw new BridgeError(
          `上下文长度已记入本机，但 OpenCode 这次没有确认同步成功；重试保存，或下次启动时会自动重试。原因：${error?.message ?? error}`,
          502,
          'context_window_sync_failed',
        );
      }

      const pendingModel = {
        ...model,
        upstreamLimits: actualModel.upstreamLimits,
        upstreamContextWindow: baseline.context,
        contextWindow: actualModel.contextWindow,
        // 恢复完成前保留旧值，让界面仍能提供再次恢复的入口。
        contextWindowOverride: value === null ? currentOverride : value,
        contextWindowPending: true,
      };
      this.state.models = this.state.models.map((item) => item.id === id ? pendingModel : item);

      if (this.server) {
        const failures = await this.#syncWrittenTargets();
        if (failures.length) {
          throw new BridgeError(
            `OpenCode 已确认上下文限制生效，但这些已接入工具的配置没能全部重写：${failures.join('；')}。保存意图已保留，再点保存或恢复会重试。`,
            500,
            'context_window_target_sync_failed',
          );
        }
      }

      const finalOverrides = { ...nextOverrides };
      const finalOriginals = { ...nextOriginals };
      const finalPending = { ...nextPending };
      if (value === null) {
        delete finalOverrides[id];
        delete finalOriginals[id];
      }
      delete finalPending[id];
      await settings.writeSettings({
        modelContextWindows: finalOverrides,
        modelContextWindowOriginals: finalOriginals,
        modelContextWindowPending: finalPending,
      });

      const finalModel = {
        ...pendingModel,
        upstreamContextWindow: value === null ? actualModel.contextWindow : baseline.context,
        contextWindowOverride: value,
        contextWindowPending: false,
      };
      this.state.models = this.state.models.map((item) => item.id === id ? finalModel : item);
      return { ok: true };
    } finally {
      this.contextWindowChangeInFlight = false;
      const resolve = this.resolveContextWindowChange;
      this.contextWindowChangePromise = null;
      this.resolveContextWindowChange = null;
      resolve?.();
    }
  }

  async saveSettings(patch) {
    if (patch && (
      Object.hasOwn(patch, 'modelContextWindows') ||
      Object.hasOwn(patch, 'modelContextWindowOriginals') ||
      Object.hasOwn(patch, 'modelContextWindowPending')
    )) {
      throw new BridgeError(
        '模型上下文长度要通过模型行里的专用设置保存，不能从通用设置接口改。',
        400,
        'context_window_requires_model_action',
      );
    }
    return settings.writeSettings(patch);
  }

  /** OpenCode 会话的工作目录，体检时要往里放靶子文件 */
  workdir() {
    return settings.workspaceDir();
  }

  /** ZCode 配置文件在哪（只给路径，界面负责打开访达） */
  zcodeConfigPath() {
    return zcode.configPath();
  }

  /** 请求日志在哪 */
  requestsLogPath() {
    return settings.requestsLogFile();
  }

  /**
   * 只重测一个模型。界面上「重测」按钮用，走 force 忽略缓存。
   * 失败不抛，返回一个 verdict:'failed' 的结果——界面要显示原因，不是弹一个红框。
   */
  async probeOne(modelId) {
    const waitForChange = this.#reservePrompt();
    if (waitForChange) await waitForChange;
    try {
      const model = this.state.models.find((m) => m.id === modelId);
      if (!model) throw new BridgeError('找不到这个模型，可能目录刚刷新过。', 404, 'model_not_found');
      const [result] = await probeMany({
        client: this.client,
        models: [model],
        workdir: settings.workspaceDir(),
        concurrency: 1,
        cache: this.cache,
        force: true,
        fingerprint: this.#probeFingerprint(),
      });
      if (result) this.state.verdicts.set(modelId, result);
      return result ? this.#view(model) : null;
    } finally {
      this.activePromptCount -= 1;
    }
  }
}

/**
 * 命令行入口。
 *
 * 桌面面板是主力界面，但 `npm start` 也是对外承诺过的用法——它得真的能跑起来，
 * 而不是一声不响地退出（退出码还是 0，用户完全看不出哪里不对）。
 *
 * 这一步只在「被当作程序直接运行」时触发；被 import 时（比如桌面端和测试）
 * 什么都不做，免得把别人拖进一个永不退出的进程里。
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const probeCount = Number(flag('probe') ?? NaN);
  const shouldImport = argv.includes('--import');
  const wantWeb = argv.includes('--web') || process.env.OCF_WEB === '1';

  const bridge = new Bridge({ log: (m) => console.log(m) });
  /** Web 面板句柄；不起面板时是 null */
  let webUi = null;
  const startedAt = Date.now();

  /**
   * 把「我正在跑」登记到数据目录，让 npm stop / npm restart 找得到。
   * 写失败不影响服务本身，只是那两个命令会找不到它。
   */
  const recordService = async (extra = {}) => {
    try {
      await writeServiceInfo({
        pid: process.pid,
        port: bridge.state.port,
        mode: wantWeb ? 'web' : 'start',
        startedAt,
        ...extra,
      });
    } catch (error) {
      console.error(`  （写服务记录失败，不影响使用：${error?.message ?? error}）`);
    }
  };

  const shutdown = async (signal) => {
    console.log(`\n收到 ${signal}，正在收摊……`);
    try {
      await webUi?.close();
    } catch {
      /* 面板关不掉不该拖住退出 */
    }
    try {
      // 正常退出（Ctrl+C、npm stop 的 SIGTERM、面板「关闭服务」都走这里）：
      // 先把各接入目标里我们写入的配置摘干净再关停——服务一停，
      // 留下的配置只会指向死端口。下次要用，启动后重新写入即可。
      await bridge.stop({ uninstall: true });
    } catch (err) {
      console.error('收摊时出错：', err?.message ?? err);
    }
    // 只删自己的记录：万一别的实例已经开始跑了，不能把它的记录一起删掉
    await clearServiceInfo(process.pid).catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // 直接关掉终端窗口时收到的是 SIGHUP。也走一遍收摊，别把 OpenCode 落下。
  process.on('SIGHUP', () => void shutdown('SIGHUP'));

  try {
    await bridge.start();
    await recordService();
    // 端口和可用模型数 Bridge 自己已经报过了，这里只补它不知道的那部分。
    const snap = bridge.snapshot();
    if (!snap.zcode?.installed) {
      console.log('  ZCode 里还没写入过，跑一次 --import 就会写进去。');
    } else if (snap.zcode.port !== snap.port) {
      // 配置里记的端口和现在这个对不上，ZCode 会连到没人听的地方去——必须说出来。
      console.log(`  ⚠️  ZCode 配置里写的是 ${snap.zcode.port} 口，和现在的 ${snap.port} 口对不上。`);
      console.log('     跑一次 --import 就会改成现在的端口。');
    } else {
      console.log(`  ZCode 已配置好（${snap.zcode.models} 个模型，端口对得上）。`);
    }

    if (Number.isInteger(probeCount) && probeCount > 0) {
      console.log(`\n开始体检，最多 ${probeCount} 个（会消耗少量免费额度）……`);
      await bridge.probe({ limit: probeCount });
      const usableModels = bridge.getModels();
      console.log(`体检完成，可用 ${usableModels.length} 个：`);
      for (const m of usableModels) console.log(`  - ${m.id}${m.chatOnly ? '（仅对话）' : ''}`);
      if (shouldImport && usableModels.length) {
        const r = await bridge.import();
        console.log(`\n已写入 ZCode：${JSON.stringify(r)}。重启 ZCode 后即可在模型菜单里看到。`);
      }
    } else {
      const available = bridge.getModels().length;
      if (available) {
        console.log('\n转发口已开着，各接入工具随时可以用。按 Ctrl+C 退出。');
      } else {
        console.log('\n转发口开着，但手头没有可用的模型，接入工具现在提问会提示模型不存在。');
        console.log('先体检一次（会消耗少量免费额度）：npm start -- --probe 12 --import');
      }
      console.log('（想顺带体检并写入 ZCode：npm start -- --probe 12 --import）');
    }

    if (wantWeb) {
      // 面板放在 finally 之外、显式 try：面板起不来不该让已经能用的转发口跟着退出
      try {
        const webPort = Number(process.env.OCF_WEB_PORT ?? 41983);
        webUi = await startWebUi({
          bridge,
          port: Number.isInteger(webPort) && webPort >= 0 ? webPort : 41983,
          assetsDir: join(ROOT, 'desktop'),
          webClientFile: join(ROOT, 'web', 'web-client.js'),
          log: (m) => console.log(m),
          // 面板上的「重启服务」：只重启转发口和 OpenCode，面板自己不关
          onRestart: async () => {
            await bridge.restart();
            await recordService({ webPort: webUi?.port });
            return bridge.snapshot();
          },
          // 面板上的「关闭服务」：整个服务退出（面板、转发口、OpenCode 一起）
          onStop: async () => {
            await shutdown('控制面板');
          },
        });
        await recordService({ webPort: webUi.port });
        console.log(`\n控制面板：${webUi.url}`);
        console.log('（这个地址带一次性令牌，别发给别人；换个口用 OCF_WEB_PORT=43000）');
      } catch (error) {
        if (error?.code === 'EADDRINUSE') {
          console.error('\n控制面板没起来：端口被占着了。换个口再试：OCF_WEB_PORT=43000 npm run web');
        } else {
          console.error(`\n控制面板没起来：${error?.message ?? error}`);
        }
        console.error('（转发口不受影响，照常能用。）');
      }
    }
  } catch (err) {
    // 启动走到一半失败时，已经起来的东西得收回去。最常见的是端口被占：
    // 那时 OpenCode 往往已经起好了，直接 exit 会把它留成没人管的孤儿进程——
    // 下次再启动还会多一只，越积越多。这里先收摊，再按原来的路子报错退出。
    try {
      await webUi?.close();
    } catch {
      /* 面板没起来或关不掉，都不该盖住真正的错误 */
    }
    try {
      // 别摘目标配置：启动失败最常见的原因是端口被占——多半是另一个实例还在跑，
      // 把它正在用的配置摘了才叫无妄之灾。
      await bridge.stop({ uninstall: false });
    } catch {
      /* 收摊失败不改变退出码，也不该盖住真正的错误 */
    }
    await clearServiceInfo(process.pid).catch(() => {});

    // 出错要说人话。最常见的就是端口被占——多半是已经开着一个 OC Faucet 了，
    // 丢一句 listen EADDRINUSE 给用户，他既看不懂也不知道该怎么办。
    if (err?.code === 'EADDRINUSE') {
      // err.port 是 Node 报错里带的真实端口，比自己再猜一次可靠。
      const port = err.port ?? process.env.OCF_PORT ?? 41982;
      console.error(`\n启动失败：本机转发口 ${port} 已经被别的程序占着。`);
      console.error('多半是你已经开着一个 OC Faucet 了（桌面面板也算）。');
      console.error(`想查是谁占的：lsof -nP -iTCP:${port} -sTCP:LISTEN`);
      console.error('想换个口：OCF_PORT=43000 npm start');
    } else {
      console.error(`\n启动失败：${err?.message ?? err}`);
    }
    process.exitCode = 1;
    process.exit(1);
  }
}
