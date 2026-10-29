import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeError } from './errors.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const START_TIMEOUT_MS = 8_000;

function platformPackage() {
  const os = process.platform === 'win32' ? 'windows' : process.platform;
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch;
  return `@oven/bun-${os}-${arch}`;
}

function devBunPath() {
  return join(
    ROOT,
    'node_modules',
    platformPackage(),
    'bin',
    process.platform === 'win32' ? 'bun.exe' : 'bun',
  );
}

function packagedPath(...parts) {
  return process.resourcesPath ? join(process.resourcesPath, ...parts) : null;
}

export function resolveBunPath(explicit) {
  const packaged = packagedPath('bun', process.platform === 'win32' ? 'bun.exe' : 'bun');
  const candidates = [
    explicit,
    process.env.OCF_BUN_PATH,
    packaged,
    devBunPath(),
  ].filter((path) => typeof path === 'string' && path);
  return candidates.find((path) => existsSync(path)) ?? null;
}

export function resolveSidecarPath(explicit) {
  const packaged = packagedPath('bun', 'zen-bun-sidecar.js');
  const candidates = [explicit, packaged, join(ROOT, 'src', 'zen-bun-sidecar.js')]
    .filter((path) => typeof path === 'string' && path);
  return candidates.find((path) => existsSync(path)) ?? null;
}

/** Bun 只负责跨网络请求；协议、重试和解析仍由 ZenClient 负责。 */
export class BunTransport {
  constructor({ baseOrigin, bunPath, sidecarPath, log = () => {} } = {}) {
    this.baseOrigin = baseOrigin;
    this.bunPath = bunPath;
    this.sidecarPath = sidecarPath;
    this.log = log;
    this.child = null;
    this.endpoint = null;
    this.starting = null;
    this.token = randomBytes(24).toString('hex');
  }

  async start() {
    if (this.endpoint) return;
    if (this.starting) return this.starting;
    this.starting = this.#start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async #start() {
    const bun = resolveBunPath(this.bunPath);
    if (!bun) {
      throw new BridgeError(
        `伪装模式缺少 Bun 运行时（${platformPackage()}）。请重新安装 OC Faucet，或用 OCF_BUN_PATH 指定 Bun。`,
        500,
        'bun_missing',
      );
    }
    const script = resolveSidecarPath(this.sidecarPath);
    if (!script) {
      throw new BridgeError('伪装模式缺少 Bun 侧车脚本，请重新安装 OC Faucet。', 500, 'bun_sidecar_missing');
    }

    const env = {};
    for (const key of [
      'PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP',
      'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
    ]) {
      if (typeof process.env[key] === 'string') env[key] = process.env[key];
    }
    Object.assign(env, {
      OCF_BUN_TOKEN: this.token,
      OCF_BUN_ALLOWED_ORIGIN: this.baseOrigin,
    });

    let child;
    try {
      child = spawn(bun, [script], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      throw new BridgeError(`启动 Bun 侧车失败：${error?.message ?? error}`, 500, 'bun_start_failed');
    }
    this.child = child;

    await new Promise((resolve, reject) => {
      let settled = false;
      let buffer = '';
      let stderr = '';
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        finish(new BridgeError('Bun 侧车启动超时。', 504, 'bun_start_timeout'));
      }, START_TIMEOUT_MS);

      child.stdout.on('data', (chunk) => {
        buffer += String(chunk);
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          try {
            const message = JSON.parse(line);
            if (message.ready && typeof message.url === 'string') {
              this.endpoint = new URL(message.url);
              finish();
            }
          } catch {
            // Bun 自己的输出不影响侧车协议
          }
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-4_000);
      });
      child.once('error', (error) => {
        finish(new BridgeError(`启动 Bun 侧车失败：${error.message}`, 500, 'bun_start_failed'));
      });
      child.once('exit', (code) => {
        this.endpoint = null;
        this.child = null;
        if (!settled) {
          finish(new BridgeError(
            `Bun 侧车启动后退出了（code=${code}）：${stderr.trim() || '没有输出'}`,
            500,
            'bun_start_failed',
          ));
        } else {
          this.log(`[伪装] Bun 侧车退出：code=${code}`);
        }
      });
    });
  }

  async fetch(url, init = {}) {
    const target = new URL(url);
    if (target.origin !== this.baseOrigin) {
      throw new BridgeError(`Bun 侧车拒绝访问非 zen 地址：${target.origin}`, 400, 'bun_origin_rejected');
    }
    if (!this.endpoint) await this.start();

    let response;
    try {
      response = await fetch(new URL('/fetch', this.endpoint), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-ocf-bun-token': this.token,
        },
        body: JSON.stringify({
          url: target.href,
          method: init.method ?? 'GET',
          headers: Object.fromEntries(new Headers(init.headers ?? {}).entries()),
          body: init.body,
          timeoutMs: 180_000,
        }),
        signal: init.signal,
      });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new BridgeError(`Bun 侧车请求失败：${error?.message ?? error}`, 502, 'upstream_unreachable');
    }

    const payload = await response.json().catch(() => null);
    if (!payload || payload.error) {
      throw new BridgeError(
        `Bun 侧车连不上 zen：${payload?.error ?? `HTTP ${response.status}`}`,
        502,
        'upstream_unreachable',
      );
    }
    return new Response(payload.body, { status: payload.status });
  }

  async stop() {
    const child = this.child;
    this.child = null;
    this.endpoint = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      timer.unref?.();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.kill();
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}
