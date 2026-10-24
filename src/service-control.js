/**
 * 「正在运行的那个 OC Faucet」的登记与停止。
 *
 * 为什么需要它：npm start / npm run web 跑起来之后，服务占着一个终端窗口，
 * 想停掉要么回去按 Ctrl+C，要么重新开一个终端杀掉它。有了这份登记文件，
 * 另一个进程（npm stop / npm restart）就能找到它、好好请它退出。
 *
 * 登记文件放在数据目录里（`service.json`），内容是：
 *   { pid, port, webPort?, mode: 'start'|'web', startedAt }
 *
 * 几条规矩：
 *   - **只在端口真的监听成功后写**。启动失败的那个进程不许覆盖正在跑的实例的记录。
 *   - **只删自己的记录**。清理时核对 pid，避免第二个进程把别人的记录删掉。
 *   - 文件是 0600，并且是「先写临时文件再原子改名」，写一半断电也不会留下半截 JSON。
 */
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir } from './settings.js';

/** 登记文件名 */
const SERVICE_FILE = 'service.json';

/** 登记文件的绝对路径（跟随 OCF_DATA_DIR） */
export function serviceFile() {
  return join(dataDir(), SERVICE_FILE);
}

/**
 * 读登记信息。文件不存在、坏了、字段不像话都返回 null——
 * 调用方按「没有在运行」处理，而不是把服务起不来。
 */
export async function readServiceInfo() {
  try {
    const parsed = JSON.parse(await readFile(serviceFile(), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const pid = Number(parsed.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return {
      pid,
      port: Number.isInteger(parsed.port) ? parsed.port : null,
      webPort: Number.isInteger(parsed.webPort) ? parsed.webPort : null,
      mode: parsed.mode === 'web' ? 'web' : 'start',
      startedAt: Number.isFinite(parsed.startedAt) ? parsed.startedAt : null,
    };
  } catch {
    return null;
  }
}

/** 写登记信息（原子替换，权限 0600） */
export async function writeServiceInfo({ pid, port, webPort = null, mode = 'start', startedAt = Date.now() }) {
  if (!Number.isInteger(pid) || pid <= 0) throw new TypeError('writeServiceInfo 需要一个有效的 pid');
  const file = serviceFile();
  const tmp = `${file}.tmp`;
  const payload = {
    pid,
    port: Number.isInteger(port) ? port : null,
    webPort: Number.isInteger(webPort) ? webPort : null,
    mode: mode === 'web' ? 'web' : 'start',
    startedAt,
  };
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
  return payload;
}

/**
 * 清理登记。**只删 pid 对得上的那份**：万一另一个实例已经开始跑了，
 * 本进程退出时不能把它的记录一起删掉。
 * @returns {Promise<boolean>} 真的删了才返回 true
 */
export async function clearServiceInfo(pid) {
  const info = await readServiceInfo();
  if (!info || info.pid !== pid) return false;
  await rm(serviceFile(), { force: true });
  return true;
}

/** 进程还在不在（EPERM 说明进程存在，只是没权限发信号） */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * 请正在运行的实例退出。
 *
 * 流程：读登记 → 进程不在了就当过期记录清掉 → 在的话发 SIGTERM 等它自己收摊
 * （它会关面板、关 OpenCode、删登记），超时就报告失败，**不擅自 SIGKILL**。
 *
 * @param {object} [o]
 * @param {number} [o.timeoutMs] 等它退出的上限，默认 15 秒
 * @param {(m:string)=>void} [o.log]
 * @returns {Promise<{
 *   wasRunning: boolean, stopped: boolean, stale: boolean, pid?: number,
 *   port?: number|null, webPort?: number|null, mode?: 'start'|'web', error?: Error
 * }>}
 */
export async function stopRunning({ timeoutMs = 15_000, log = () => {} } = {}) {
  const info = await readServiceInfo();

  if (!info) {
    return { wasRunning: false, stopped: false, stale: false };
  }

  const base = { pid: info.pid, port: info.port, webPort: info.webPort, mode: info.mode };

  if (!isAlive(info.pid)) {
    // 上次异常退出（比如直接关了终端）留下的记录：进程已经没了，清掉即可
    await clearServiceInfo(info.pid);
    return { wasRunning: false, stopped: false, stale: true, ...base };
  }

  log(`找到运行中的实例（PID ${info.pid}${info.port ? `，转发口 ${info.port}` : ''}），正在请它退出……`);
  try {
    process.kill(info.pid, 'SIGTERM');
  } catch (error) {
    return { wasRunning: true, stopped: false, stale: false, ...base, error };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(info.pid)) {
      // 正常情况下它自己会删登记；这里兜一道，防止它没删干净留下过期文件
      await clearServiceInfo(info.pid);
      return { wasRunning: true, stopped: true, stale: false, ...base };
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  return { wasRunning: true, stopped: false, stale: false, ...base };
}
