/**
 * OC Faucet 桌面应用主进程（Electron）。
 *
 * 职责：
 *   1. 起/停后台的 Bridge（OpenCode + 本机转发口）
 *   2. 提供窗口与托盘
 *   3. 通过受限 IPC 把状态给渲染进程，把固定动作接回来
 *
 * 安全约定：渲染进程永远不能指定任意命令；密钥只经 oc:get-api-key / oc:set-api-key
 * 这一对通道显式读改（用户已确认的有意取舍），状态推送里不携带。
 * 它能做的只有下面 IPC_CHANNELS 里列出的那几件事。
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell } = require('electron');
const path = require('node:path');

/** 允许的 IPC 通道。只有这些会被接。 */
const IPC_CHANNELS = [
  'oc:state',
  'oc:refresh',
  'oc:probe',
  'oc:probe-one',
  'oc:import',
  'oc:uninstall',
  'oc:install-target',
  'oc:uninstall-target',
  'oc:set-model-context-window',
  'oc:get-api-key',
  'oc:set-api-key',
  'oc:settings',
  'oc:save-settings',
  'oc:set-upstream-mode',
  'oc:lan-access',
  'oc:lan-info',
  'oc:open-zcode-config',
  'oc:open-log',
  'oc:restart',
  'oc:stop',
];

let win = null;
let tray = null;
let bridge = null;
let quitting = false;

/** 动态 import ESM 的编排层（主进程是 CJS，桥是 ESM） */
async function loadBridge() {
  const url = pathToFileURL(path.join(__dirname, '..', 'src', 'main.js')).href;
  const { Bridge } = await import(url);
  return new Bridge({ log: (line) => console.log('[oc]', line) });
}

function pathToFileURL(p) {
  return require('node:url').pathToFileURL(p);
}

/** macOS 的 Dock 图标：Electron 直跑不会自动用 icon.png，得显式设（其它平台用打包配置，跳过） */
function setDockIcon() {
  if (process.platform !== 'darwin' || !app.dock) return;
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
    if (!icon.isEmpty()) app.dock.setIcon(icon);
  } catch {
    /* Dock 图标设不上不影响功能 */
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1040,
    height: 700,
    minWidth: 820,
    minHeight: 560,
    title: 'OC Faucet',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('close', (event) => {
    // 关窗口 ≠ 退出：继续在托盘里跑，否则已接入工具里的模型会断。
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });
  return win;
}

function createTray() {
  const iconPath = path.join(__dirname, 'trayTemplate.png');
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) image = nativeImage.createEmpty();
  tray = new Tray(image);
  tray.setToolTip('OC Faucet');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开控制面板', click: () => { win?.show(); win?.focus(); } },
      { type: 'separator' },
      {
        label: '退出',
        click: async () => {
          quitting = true;
          try {
            await bridge?.stop({ uninstall: true });
          } catch (error) {
            console.error('[oc] 退出时清理失败：', error);
          }
          app.exit(0);
        },
      },
    ]),
  );
  tray.on('click', () => { win?.show(); win?.focus(); });
}

/** 广播状态给窗口 */
function pushState() {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send('oc:state', bridge.snapshot());
  } catch {
    /* 窗口可能正好在关 */
  }
}

function registerIpc() {
  // 渲染进程主动要状态时先实读一遍各目标配置再回快照（pushState 是推送通道，不动）
  ipcMain.handle('oc:state', async () => {
    await bridge.listTargetStates();
    return bridge.snapshot();
  });

  ipcMain.handle('oc:refresh', async () => {
    const models = await bridge.refresh();
    pushState();
    return { models: models.length };
  });

  ipcMain.handle('oc:probe', async (_e, { force } = {}) => {
    // 体检期间定时推状态，让界面能看到进度
    const timer = setInterval(pushState, 400);
    try {
      const results = await bridge.probe({ force: Boolean(force) });
      const summary = results.reduce((acc, r) => {
        acc[r.verdict] = (acc[r.verdict] ?? 0) + 1;
        return acc;
      }, {});
      return { summary, results: results.map((r) => ({ id: r.model.id, verdict: r.verdict, note: r.note })) };
    } finally {
      clearInterval(timer);
      pushState();
    }
  });

  ipcMain.handle('oc:probe-one', async (_e, { id }) => {
    // 桥自己负责忽略缓存、更新判定，界面只要结果
    return bridge.probeOne(id);
  });

  ipcMain.handle('oc:import', async () => {
    const result = await bridge.import();
    pushState();
    return result;
  });

  ipcMain.handle('oc:uninstall', async () => {
    const result = await bridge.uninstall();
    pushState();
    return result;
  });

  ipcMain.handle('oc:install-target', async (_e, payload) => {
    // 兼容两种调用：老形状直接传 id，新形状传 { id, modelIds }
    const id = typeof payload === 'string' ? payload : payload?.id;
    const modelIds = typeof payload === 'object' && payload ? payload.modelIds : undefined;
    const result = await bridge.installTarget(id, { modelIds });
    pushState();
    return result;
  });

  ipcMain.handle('oc:uninstall-target', async (_e, id) => {
    const result = await bridge.uninstallTarget(id);
    pushState();
    return result;
  });

  ipcMain.handle('oc:set-model-context-window', async (_e, { id, value } = {}) => {
    const result = await bridge.setModelContextWindow(id, value);
    pushState();
    return result;
  });

  // 密钥只在界面显式读改时经这一对通道走，状态推送里不携带
  ipcMain.handle('oc:get-api-key', async () => ({ key: await bridge.getApiKey() }));

  ipcMain.handle('oc:set-api-key', async (_e, key) => {
    const result = await bridge.setApiKey(key);
    // 换密钥会级联重写已写入的目标，把最新状态推给界面
    pushState();
    return result;
  });

  ipcMain.handle('oc:settings', () => bridge.readSettings());

  ipcMain.handle('oc:save-settings', async (_e, patch) => {
    const next = await bridge.saveSettings(patch);
    return next;
  });

  // 切换上游方案（内嵌 ⇄ 伪装）：切换在桥里热完成，转发口不动
  ipcMain.handle('oc:set-upstream-mode', async (_e, mode) => {
    const result = await bridge.setUpstreamMode(mode);
    pushState();
    return result;
  });

  // 路由器广播：开/关转发口对局域网开放（同一端口热重绑）
  ipcMain.handle('oc:lan-access', async (_e, enabled) => {
    const result = await bridge.setLanAccess(enabled);
    pushState();
    return result;
  });

  // 局域网接入信息（地址、密钥、模型 id）：面板弹窗用
  ipcMain.handle('oc:lan-info', async () => bridge.lanInfo());

  ipcMain.handle('oc:open-zcode-config', async () => {
    const file = bridge.zcodeConfigPath();
    shell.showItemInFolder(file);
    return { file };
  });

  ipcMain.handle('oc:open-log', async () => {
    shell.showItemInFolder(bridge.requestsLogPath());
    return { file: bridge.requestsLogPath() };
  });

  ipcMain.handle('oc:restart', async () => {
    // 只重启转发口和 OpenCode，窗口不动；各接入工具的配置也不动
    const snapshot = await bridge.restart();
    pushState();
    return snapshot;
  });

  ipcMain.handle('oc:stop', async () => {
    // 正常停止：先摘掉各接入目标里我们写入的配置，再关转发口和 OpenCode。
    // 窗口留着——托盘应用里点「重启服务」就能再拉起来，之后按需重新写入。
    await bridge.stop({ uninstall: true });
    pushState();
    return bridge.snapshot();
  });
}

app.whenReady().then(async () => {
  setDockIcon();
  createWindow();
  createTray();
  registerIpc();

  try {
    bridge = await loadBridge();
    // 先给界面一个"正在启动"的状态，避免窗口白屏
    pushState();
    await bridge.start();
    pushState();

    // 启动后自动跑一轮：拉目录 → 体检
    await bridge.refresh();
    pushState();
    await bridge.probe({ force: false });
    pushState();
  } catch (error) {
    console.error('[oc] 启动失败：', error);
    pushState();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else { win?.show(); win?.focus(); }
  });
});

app.on('window-all-closed', () => {
  // 托盘应用：关窗口不退出
});

app.on('before-quit', async (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  try {
    await bridge?.stop({ uninstall: true });
  } catch (error) {
    console.error('[oc] 退出清理失败：', error);
  }
  app.exit(0);
});
