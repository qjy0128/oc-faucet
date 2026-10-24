/**
 * Web 版的面板客户端：把 Electron 的 IPC 接口换成 fetch。
 *
 * 为什么要有这一层：桌面版的界面代码（desktop/renderer.js）只认 `window.oc`
 * 这一组方法，不关心底下是 IPC 还是 HTTP。所以 Web 版只要在 renderer.js 之前
 * 把同形状的 `window.oc` 装好，界面代码一个字都不用改——一份界面两种传输。
 *
 * 令牌：服务端只认带令牌的请求。令牌在打开面板的地址里（`?t=...`），
 * 这里读出来存进 sessionStorage，之后每个请求都带上。
 */
(function () {
  // Electron 里已经有 IPC 版的 window.oc 了，别覆盖它
  if (window.oc) return;

  const TOKEN_KEY = 'oc-panel-token';

  function readToken() {
    const fromUrl = new URLSearchParams(location.search).get('t');
    if (fromUrl) {
      try {
        sessionStorage.setItem(TOKEN_KEY, fromUrl);
      } catch {
        /* 隐私模式下 sessionStorage 可能不可用，那就每次从地址读 */
      }
      // 令牌已经从地址里读出来了，顺手把它从地址栏抹掉，免得被截图/分享带出去
      const clean = new URL(location.href);
      clean.searchParams.delete('t');
      history.replaceState(null, '', clean.pathname + clean.search);
      return fromUrl;
    }
    try {
      return sessionStorage.getItem(TOKEN_KEY) ?? '';
    } catch {
      return '';
    }
  }

  const token = readToken();

  async function api(path, options = {}) {
    const res = await fetch(path, {
      method: options.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        'x-oc-token': token,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store',
    });

    let payload = {};
    try {
      payload = await res.json();
    } catch {
      /* 不是 JSON 就按空对象处理，下面按状态码报错 */
    }

    if (!res.ok) {
      const hint = res.status === 401 ? '（面板令牌失效了，重新打开启动时打印的地址）' : '';
      throw new Error(`${payload.error ?? `HTTP ${res.status}`}${hint}`);
    }
    return payload;
  }

  const post = (path, body) => api(path, { method: 'POST', body: body ?? {} });

  window.oc = {
    /** 界面用它来决定「关闭服务」的提示文案：Web 面板会连自己一起关掉 */
    panelShell: 'web',
    /**
     * 订阅状态。桌面版是主进程推送，这里用轮询——面板很轻，
     * 一次状态查询就是读内存，1.5 秒一次不心疼。
     */
    onState(callback) {
      let stopped = false;
      const tick = async () => {
        if (stopped) return;
        try {
          callback(await api('/api/state'));
        } catch {
          /* 一次失败不打断轮询，接下来还会再试 */
        }
      };
      tick();
      const timer = setInterval(tick, 1500);
      return () => {
        stopped = true;
        clearInterval(timer);
      };
    },

    getState: () => api('/api/state'),
    refresh: () => post('/api/refresh'),
    probe: (options) => post('/api/probe', options ?? {}),
    probeOne: (id) => post('/api/probe-one', { id }),
    importToZcode: () => post('/api/import'),
    uninstall: () => post('/api/uninstall'),
    // 通用目标写入/摘除（工单 06）：界面上的「一键接入」区走这两个
    installTarget: (id, modelIds) => post('/api/targets/install', { id, modelIds }),
    uninstallTarget: (id) => post('/api/targets/uninstall', { id }),
    setModelContextWindow: (id, value) => post('/api/models/context-window', { id, value }),
    // 密钥只在显式请求时经带令牌接口返回，快照里没有（工单 05）
    getApiKey: () => api('/api/key'),
    setApiKey: (key) => post('/api/key', { key }),
    // 重启只重启转发口和 OpenCode，面板不关；关闭会把面板自己也关掉
    restart: () => post('/api/restart'),
    stop: () => post('/api/stop'),
    getSettings: () => api('/api/settings'),
    saveSettings: (patch) => post('/api/settings', patch ?? {}),
    // 切换上游方案：'embedded'（内嵌）| 'masquerade'（伪装）
    setUpstreamMode: (mode) => post('/api/upstream-mode', { mode }),
    // 路由器广播：true = 转发口对局域网开放；lanInfo 返回地址/密钥/模型 id
    setLanAccess: (enabled) => post('/api/lan-access', { enabled }),
    lanInfo: () => api('/api/lan-info'),
    paths: () => api('/api/paths'),
    log: (lines) => api(`/api/log?lines=${Number(lines) || 50}`),

    /**
     * Web 版打不开访达，把路径交回给界面显示。
     * `opened:false` 是给 renderer 的信号：别谎称"已打开"。
     */
    async openZcodeConfig() {
      const p = await api('/api/paths');
      return { file: p.zcodeConfig, opened: false };
    },
    async openLog() {
      const p = await api('/api/paths');
      return { file: p.requestsLog, opened: false };
    },
  };
})();
