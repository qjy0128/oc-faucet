const semver = require('semver');
const { access, mkdir, open, readFile, rename, unlink, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const RELEASE_API = 'https://api.github.com/repos/qjy0128/oc-faucet/releases/latest';
const CHECK_TIMEOUT_MS = 10_000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function expectedAssetNames(version, platform, arch) {
  if (platform === 'darwin' && arch === 'arm64') {
    return [`OC.Faucet-${version}-arm64.dmg`, `OC Faucet-${version}-arm64.dmg`];
  }
  if (platform === 'win32' && arch === 'x64') {
    return [`OC.Faucet.Setup.${version}.exe`, `OC Faucet Setup ${version}.exe`];
  }
  return [];
}

/** 已有同名文件时退到「名字 (1).ext」，绝不覆盖用户自己的文件 */
async function pickFilePath(directory, name) {
  const extension = path.extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  let candidate = path.join(directory, name);
  for (let index = 1; ; index += 1) {
    const taken = await access(candidate).then(() => true, () => false);
    if (!taken) return candidate;
    candidate = path.join(directory, `${stem} (${index})${extension}`);
  }
}

function createUpdater(options) {
  const currentVersion = options.currentVersion;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const stateFile = options.stateFile;
  const downloadDir = options.downloadDir;
  const openPath = options.openPath;
  const logger = options.logger ?? console;
  const onState = options.onState ?? (() => {});
  let candidate = null;
  let downloadController = null;
  let state = {
    status: 'idle',
    currentVersion,
    latestVersion: null,
    releaseUrl: null,
    releaseNotes: '',
    assetName: null,
    downloadedBytes: 0,
    totalBytes: 0,
    filePath: null,
    launched: false,
    error: null,
  };

  function getState() {
    return { ...state };
  }

  function setState(patch) {
    state = { ...state, ...patch };
    onState(getState());
    return getState();
  }

  async function readLastCheckAttempt() {
    try {
      const saved = JSON.parse(await readFile(stateFile, 'utf8'));
      const timestamp = saved?.lastCheckAttemptAt;
      return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : 0;
    } catch {
      return 0;
    }
  }

  async function recordCheckAttempt(timestamp) {
    try {
      await mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 });
      const temporary = `${stateFile}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ lastCheckAttemptAt: timestamp })}\n`, { mode: 0o600 });
      await rename(temporary, stateFile);
    } catch (error) {
      logger.error('[oc] 保存更新检查时间失败：', error);
    }
  }

  async function checkForUpdates({ manual = false } = {}) {
    // 下载进行中不接受检查：状态机别被中途覆盖
    if (downloadController) return getState();
    const timestamp = now();
    const lastAttempt = await readLastCheckAttempt();
    if (
      !manual &&
      lastAttempt > 0 &&
      lastAttempt <= timestamp &&
      timestamp - lastAttempt < CHECK_INTERVAL_MS
    ) {
      return { ...getState(), status: 'throttled' };
    }
    await recordCheckAttempt(timestamp);
    setState({ status: 'checking', error: null });
    try {
      const installed = semver.clean(currentVersion);
      if (!installed) throw new Error(`无法识别当前版本：${currentVersion}`);
      const response = await fetchImpl(RELEASE_API, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `OC-Faucet/${installed}`,
        },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`GitHub 返回 HTTP ${response.status}`);
      const latestRelease = await response.json();
      const latest = semver.clean(latestRelease.tag_name ?? '');
      if (!latest) throw new Error('GitHub 最新发布的版本号无效');

      if (
        latestRelease.draft ||
        latestRelease.prerelease ||
        semver.prerelease(latest) ||
        !semver.gt(latest, installed)
      ) {
        candidate = null;
        return setState({ status: 'up-to-date', latestVersion: latest });
      }

      const expectedNames = expectedAssetNames(latest, platform, arch);
      const assets = Array.isArray(latestRelease.assets) ? latestRelease.assets : [];
      const matches = assets.filter((item) => expectedNames.includes(item?.name));
      if (matches.length !== 1) {
        throw new Error(`新版本 ${latest} 没有适配 ${platform}/${arch} 的唯一安装包`);
      }

      candidate = { release: latestRelease, asset: matches[0], version: latest };
      return setState({
        status: 'available',
        latestVersion: latest,
        releaseUrl: latestRelease.html_url,
        releaseNotes: typeof latestRelease.body === 'string' ? latestRelease.body : '',
        assetName: matches[0].name,
        totalBytes: Number.isSafeInteger(matches[0].size) ? matches[0].size : 0,
        downloadedBytes: 0,
        filePath: null,
        launched: false,
        error: null,
      });
    } catch (error) {
      // 查询失败不代表上次查到的新版作废：有候选就停在确认态，没有才回空闲。
      // 抛出的中文错误由界面展示。
      setState({ status: candidate ? 'available' : 'idle', error: null });
      throw new Error(`检查更新失败：${error.message}`, { cause: error });
    }
  }

  async function downloadAndOpen() {
    if (!candidate) throw new Error('没有可下载的更新');
    // 同一时间只允许一个下载任务：连点「立即更新」直接复用在跑的这一份
    if (downloadController) return getState();
    const { asset } = candidate;
    await mkdir(downloadDir, { recursive: true, mode: 0o700 });
    const filePath = await pickFilePath(downloadDir, path.basename(asset.name));
    const temporary = `${filePath}.part`;
    const controller = new AbortController();
    downloadController = controller;
    let handle = null;
    let downloadedBytes = 0;
    setState({
      status: 'downloading',
      downloadedBytes: 0,
      totalBytes: Number.isSafeInteger(asset.size) ? asset.size : 0,
      filePath: null,
      launched: false,
      error: null,
    });

    try {
      const response = await fetchImpl(asset.browser_download_url, {
        headers: { 'User-Agent': `OC-Faucet/${currentVersion}` },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`下载安装包失败：GitHub 返回 HTTP ${response.status}`);
      if (!response.body) throw new Error('下载安装包失败：响应没有内容');

      const expectedDigest = typeof asset.digest === 'string' && /^sha256:[a-f0-9]{64}$/i.test(asset.digest)
        ? asset.digest.slice(7).toLowerCase()
        : null;
      const hash = expectedDigest ? createHash('sha256') : null;
      handle = await open(temporary, 'wx', 0o600);
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
          offset += bytesWritten;
        }
        downloadedBytes += buffer.length;
        if (Number.isSafeInteger(asset.size) && downloadedBytes > asset.size) {
          throw new Error('下载内容超过 GitHub 声明的文件大小');
        }
        hash?.update(buffer);
        setState({ downloadedBytes });
      }
      await handle.close();
      handle = null;

      if (Number.isSafeInteger(asset.size) && downloadedBytes !== asset.size) {
        throw new Error(`安装包大小不符：应为 ${asset.size} 字节，实际为 ${downloadedBytes} 字节`);
      }
      if (expectedDigest && hash.digest('hex') !== expectedDigest) {
        throw new Error('安装包的 SHA-256 校验不符');
      }

      await rename(temporary, filePath);
      // 启动结果并进同一帧终态：分两次推送会被主进程的进度节流吞掉第二帧
      const openError = await openPath(filePath);
      return setState({
        status: 'ready',
        filePath,
        downloadedBytes,
        launched: !openError,
        error: openError || null,
      });
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      if (controller.signal.aborted) {
        return setState({
          status: 'available',
          downloadedBytes: 0,
          filePath: null,
          launched: false,
          error: '下载已取消',
        });
      }
      return setState({ status: 'error', filePath: null, launched: false, error: error.message });
    } finally {
      if (downloadController === controller) downloadController = null;
    }
  }

  function cancelDownload() {
    downloadController?.abort();
    return getState();
  }

  return { checkForUpdates, downloadAndOpen, cancelDownload, getState };
}

module.exports = { createUpdater };
