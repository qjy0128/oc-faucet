/**
 * 预加载脚本：在渲染进程和主进程之间架一座**受限**的桥。
 * 渲染进程只能看到下面这几个函数，拿不到 require，也不能指定任意命令。
 * 密钥只经 oc:get-api-key / oc:set-api-key 这一对接口显式读改，快照里不携带。
 */
const { contextBridge, ipcRenderer } = require('electron');

/**
 * Electron 会在 IPC 拒绝原因前面套一层「Error invoking remote method '…': Error: 」，
 * 剥掉这层壳，界面才能把桥的中文文案原样给小白看。
 */
async function invokeClean(channel, arg) {
  try {
    return await ipcRenderer.invoke(channel, arg);
  } catch (error) {
    const message = String(error?.message ?? error).replace(
      /^Error invoking remote method '[^']+':\s*(?:\w*Error:\s*)?/,
      '',
    );
    throw new Error(message);
  }
}

contextBridge.exposeInMainWorld('oc', {
  /** 界面用它来决定「关闭服务」的提示文案：桌面窗口在关掉服务后还留着 */
  panelShell: 'desktop',
  /** 订阅状态推送；返回取消订阅函数 */
  onState(callback) {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('oc:state', handler);
    return () => ipcRenderer.removeListener('oc:state', handler);
  },
  getState: () => ipcRenderer.invoke('oc:state'),
  refresh: () => ipcRenderer.invoke('oc:refresh'),
  probe: (options) => ipcRenderer.invoke('oc:probe', options ?? {}),
  probeOne: (id) => ipcRenderer.invoke('oc:probe-one', { id }),
  importToZcode: () => ipcRenderer.invoke('oc:import'),
  uninstall: () => ipcRenderer.invoke('oc:uninstall'),
  // 通用目标写入/摘除（与 Web 版 window.oc 签名一致）
  installTarget: (id, modelIds) => invokeClean('oc:install-target', { id, modelIds }),
  uninstallTarget: (id) => invokeClean('oc:uninstall-target', id),
  setModelContextWindow: (id, value) => invokeClean('oc:set-model-context-window', { id, value }),
  // 密钥读改：返回形状与 Web 版一致（{key} / {ok:true}）
  getApiKey: () => invokeClean('oc:get-api-key'),
  setApiKey: (key) => invokeClean('oc:set-api-key', key),
  getSettings: () => ipcRenderer.invoke('oc:settings'),
  saveSettings: (patch) => ipcRenderer.invoke('oc:save-settings', patch),
  // 切换上游方案：'embedded'（内嵌）| 'masquerade'（伪装）
  setUpstreamMode: (mode) => invokeClean('oc:set-upstream-mode', mode),
  // 路由器广播：true = 转发口对局域网开放；lanInfo 返回地址/密钥/模型 id
  setLanAccess: (enabled) => invokeClean('oc:lan-access', enabled),
  lanInfo: () => invokeClean('oc:lan-info'),
  openZcodeConfig: () => ipcRenderer.invoke('oc:open-zcode-config'),
  openLog: () => ipcRenderer.invoke('oc:open-log'),
  restart: () => ipcRenderer.invoke('oc:restart'),
  stop: () => ipcRenderer.invoke('oc:stop'),
});
