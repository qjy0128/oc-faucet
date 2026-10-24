/**
 * Web 控制面板。
 *
 * 和桌面版共用同一套界面文件（desktop/index.html + renderer.js + style.css），
 * 区别只在传输层：桌面版走 Electron IPC，这里走 HTTP + fetch。
 *
 * 安全上比桌面版麻烦一点，因为它是"能被浏览器打开"的服务：
 *
 *   1. **只监听 127.0.0.1** —— 局域网上的人碰不到。
 *   2. **必须带 token** —— 本地任何网页都能往 127.0.0.1 发请求，没有 token 的话
 *      一个恶意页面就能悄悄让面板把 ZCode 配置改掉。token 只在启动时打印一次。
 *   3. **校验 Origin** —— 浏览器跨站请求一定带 Origin，它必须是我们自己。
 *
 * 这三条任意一条缺失，都可能变成"你打开一个网页，别人就能改你配置"。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { BridgeError } from './errors.js';

/** 请求体上限，防止有人往这儿灌大文件 */
const MAX_BODY_BYTES = 1 << 20;

/** 生成面板令牌 */
export function panelToken() {
  return randomBytes(24).toString('base64url');
}

function sendJson(res, status, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  const buffer = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'content-type': type,
    'content-length': buffer.length,
    'cache-control': 'no-store',
  });
  res.end(buffer);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('请求体太大了');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

/**
 * 把界面文件里插一行脚本：Web 版需要先装好 fetch 版 window.oc，再跑 renderer.js。
 * @param {string} html
 * @returns {string}
 */
function injectWebClient(html) {
  const tag = '<script src="/web-client.js"></script>';
  // 插在 renderer.js 之前
  const at = html.indexOf('<script src="renderer.js"></script>');
  if (at < 0) return html;
  return `${html.slice(0, at)}${tag}\n    ${html.slice(at)}`;
}

/**
 * 起一个控制面板服务。
 *
 * @param {object} o
 * @param {object} o.bridge  Bridge 实例
 * @param {number} [o.port]  0 = 系统分配
 * @param {string} o.assetsDir 桌面版界面文件所在目录
 * @param {string} [o.webClientFile] web-client.js 的绝对路径
 * @param {(line:string)=>void} [o.log]
 * @param {()=>Promise<object>} [o.onRestart] 面板点「重启服务」时调它，返回新快照
 * @param {()=>Promise<void>} [o.onStop] 面板点「关闭服务」时调它（会连面板一起退出）
 * @returns {Promise<{server:import('node:http').Server, port:number, token:string, url:string, close:()=>Promise<void>}>}
 */
export async function startWebUi({
  bridge,
  port = 0,
  assetsDir,
  webClientFile,
  log = () => {},
  onRestart,
  onStop,
} = {}) {
  if (!bridge) throw new TypeError('startWebUi 需要 bridge');
  if (typeof assetsDir !== 'string' || !assetsDir) throw new TypeError('startWebUi 需要 assetsDir');
  if (typeof webClientFile !== 'string' || !webClientFile) throw new TypeError('startWebUi 需要 webClientFile');

  const token = panelToken();
  // 预先读好，避免每次请求都碰磁盘；文件都很小
  const [html, css, renderer, webClient, icon] = await Promise.all([
    readFile(join(assetsDir, 'index.html'), 'utf8'),
    readFile(join(assetsDir, 'style.css'), 'utf8'),
    readFile(join(assetsDir, 'renderer.js'), 'utf8'),
    readFile(webClientFile, 'utf8'),
    // 图标缺失不该让整个面板起不来
    readFile(join(assetsDir, 'icon.png')).catch(() => null),
  ]);
  const files = {
    '/': { body: injectWebClient(html), type: 'text/html; charset=utf-8' },
    '/index.html': { body: injectWebClient(html), type: 'text/html; charset=utf-8' },
    '/style.css': { body: css, type: 'text/css; charset=utf-8' },
    '/renderer.js': { body: renderer, type: 'text/javascript; charset=utf-8' },
    '/web-client.js': { body: webClient, type: 'text/javascript; charset=utf-8' },
    ...(icon ? { '/icon.png': { body: icon, type: 'image/png' } } : {}),
  };

  /** 令牌校验：header 或 query 都认（首屏地址里放 query，之后走 header） */
  const tokenOk = (req, url) => {
    const fromHeader = req.headers['x-oc-token'];
    if (typeof fromHeader === 'string' && fromHeader === token) return true;
    return url.searchParams.get('t') === token;
  };

  /** 只接受同源请求：跨站请求一定带别的 Origin，直接拒 */
  const originOk = (req) => {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || !origin) return true; // 非浏览器或同源导航
    return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin);
  };

  const routes = {
    // 界面每 1.5s 轮询这条：先实读一遍各目标状态（单个目标失败由 listTargetStates
    // 自己兜底，不炸），再回快照——用户在外部改过目标配置，面板必须如实反映
    'GET /api/state': async () => {
      await bridge.listTargetStates();
      return bridge.snapshot();
    },

    'POST /api/refresh': async () => {
      const models = await bridge.refresh();
      return { models: models.length };
    },

    'POST /api/probe': async (body) => {
      const results = await bridge.probe({ force: body.force === true });
      const summary = { tool: 0, chat: 0, failed: 0 };
      for (const r of results) if (summary[r.verdict] !== undefined) summary[r.verdict] += 1;
      return { summary, total: results.length };
    },

    'POST /api/probe-one': async (body) => {
      if (typeof body.id !== 'string' || !body.id) throw new Error('缺少模型 id');
      const view = await bridge.probeOne(body.id);
      if (!view) throw new Error('这个模型不在当前清单里');
      return view;
    },

    'POST /api/import': async () => bridge.import(),

    'POST /api/uninstall': async () => bridge.uninstall(),

    // 通用目标写入/摘除：按 id 找注册表里的目标，错误形状与上面旧路由一致
    'POST /api/targets/install': async (body) => {
      if (typeof body.id !== 'string' || !body.id) throw new Error('缺少目标 id');
      return bridge.installTarget(body.id, { modelIds: body.modelIds });
    },

    'POST /api/targets/uninstall': async (body) => {
      if (typeof body.id !== 'string' || !body.id) throw new Error('缺少目标 id');
      return bridge.uninstallTarget(body.id);
    },

    'POST /api/models/context-window': async (body) => {
      if (typeof body.id !== 'string' || !body.id) {
        throw new BridgeError('缺少模型 id。请重新展开模型详情后再保存。', 400, 'missing_model_id');
      }
      return bridge.setModelContextWindow(body.id, body.value);
    },

    // 重启 / 关闭整个服务。和其它动作接口一样，必须带令牌。
    // 关闭属于正常停止：onStop 收摊前会把各接入目标里我们写入的配置一并摘除。
    'POST /api/restart': async () => {
      if (typeof onRestart !== 'function') {
        throw new Error('这个壳子不支持重启服务；命令行起的服务请用 npm restart');
      }
      return onRestart();
    },

    'POST /api/stop': async () => {
      if (typeof onStop !== 'function') {
        throw new Error('这个壳子不支持关闭服务；命令行起的服务请用 npm stop');
      }
      // 先把「正在关闭」的响应送出去，再收摊。顺序反了浏览器只会看到连接被掐断。
      setTimeout(() => {
        Promise.resolve()
          .then(onStop)
          .catch((error) => log(`[Web] 关闭服务失败：${error?.message ?? error}`));
      }, 150);
      return { stopping: true };
    },

    'GET /api/settings': async () => bridge.readSettings(),

    // 密钥的读与改。只在这条带令牌的面板通道上暴露，转发口路由永远碰不到它；
    // 快照（/api/state）也依旧不携带密钥。
    'GET /api/key': async () => ({ key: await bridge.getApiKey() }),

    'POST /api/key': async (body) => {
      // 校验（空密钥 400）与级联重写都在桥的 setApiKey 里，失败会按带状态码的错抛回来
      await bridge.setApiKey(body.key);
      return { ok: true };
    },

    'POST /api/settings': async (body) =>
      bridge.saveSettings({
        ...(body.probeConcurrency !== undefined ? { probeConcurrency: body.probeConcurrency } : {}),
        ...(body.probeTtlMinutes !== undefined ? { probeTtlMinutes: body.probeTtlMinutes } : {}),
      }),

    // 切换上游方案（内嵌 ⇄ 伪装）。忙拒（409）与失败回滚都在桥里做，
    // 界面拿到的一定是「已生效」或「带原因的失败」。
    'POST /api/upstream-mode': async (body) => {
      if (typeof body.mode !== 'string' || !body.mode) throw new Error('缺少方案名（mode）');
      return bridge.setUpstreamMode(body.mode);
    },

    // 路由器广播：开/关转发口对局域网的可见性（密钥与 Origin 围栏不变）
    'POST /api/lan-access': async (body) => {
      if (typeof body.enabled !== 'boolean') throw new Error('路由器广播开关只接受 true / false');
      return bridge.setLanAccess(body.enabled);
    },

    // 局域网接入信息：地址清单 + 密钥 + 模型 id（密钥只走这条带令牌的面板通道）
    'GET /api/lan-info': async () => bridge.lanInfo(),

    // Web 版打不开访达，只能把路径给出来让用户自己复制
    'GET /api/paths': async () => ({
      zcodeConfig: bridge.zcodeConfigPath(),
      requestsLog: bridge.requestsLogPath(),
      workdir: bridge.workdir(),
    }),

    // 请求日志末尾若干行，界面上直接看，不依赖访达
    'GET /api/log': async (body, url) => {
      const want = Number(url.searchParams.get('lines'));
      const limit = Number.isInteger(want) && want > 0 && want <= 500 ? want : 50;
      const text = await readFile(bridge.requestsLogPath(), 'utf8').catch(() => '');
      const lines = text.split('\n').filter(Boolean).slice(-limit);
      return { lines, file: bridge.requestsLogPath() };
    },
  };

  const server = createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      sendJson(res, 400, { error: '看不懂的请求地址' });
      return;
    }

    if (!originOk(req)) {
      sendJson(res, 403, { error: '只接受本机自己页面的请求' });
      return;
    }

    // 静态文件**不要**令牌：浏览器加载 /style.css、/renderer.js 这些子资源时
    // 不会把页面地址里的 ?t= 带过来（查询串不继承给子资源），也会丢掉自定义头。
    // 之前把静态资源也卡在令牌后面，结果就是页面裸奔、脚本没加载、永远停在"准备中"。
    // 这些文件是我们自己的前端代码，不含任何机密；真正要护的是下面所有 /api/ 动作。
    if (!url.pathname.startsWith('/api/')) {
      const asset = req.method === 'GET' ? files[url.pathname] : undefined;
      if (asset) {
        sendText(res, 200, asset.body, asset.type);
        return;
      }
      // 白名单之外的一律 404：既不会误发文件，也顺带免疫路径穿越
      sendJson(res, 404, { error: `没有这个资源：${url.pathname}` });
      return;
    }

    if (!tokenOk(req, url)) {
      sendJson(res, 401, { error: '没有令牌或令牌不对，请用启动时打印的那个地址打开面板' });
      return;
    }

    const key = `${req.method} ${url.pathname}`;

    const handler = routes[key];
    if (!handler) {
      sendJson(res, 404, { error: `没有这个接口：${key}` });
      return;
    }

    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const payload = await handler(body, url);
      sendJson(res, 200, payload ?? {});
    } catch (error) {
      // 桥抛的错都已经是给人看的中文；原样转给界面
      const message = error?.message ?? String(error);
      log(`[Web] ${key} 失败：${message}`);
      sendJson(res, error?.status && Number.isInteger(error.status) ? error.status : 500, {
        error: message,
        code: error?.code,
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  const actualPort = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  const url = `http://127.0.0.1:${actualPort}/?t=${token}`;

  return {
    server,
    port: actualPort,
    token,
    url,
    close: () =>
      new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        // 浏览器开着面板时会留着 keep-alive 连接；它们会一直挡着 close 回调，
        // 所以先收掉空闲连接，2 秒还关不完就强拆，别让退出/重启卡住。
        const timer = setTimeout(() => {
          server.closeAllConnections?.();
          finish();
        }, 2_000);
        server.close(finish);
        server.closeIdleConnections?.();
      }),
  };
}
