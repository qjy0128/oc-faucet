import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import updaterModule from '../desktop/updater.cjs';

const { createUpdater } = updaterModule;

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function release(version, assets) {
  return {
    tag_name: `v${version}`,
    html_url: `https://github.com/qjy0128/oc-faucet/releases/tag/v${version}`,
    body: '修复若干问题',
    draft: false,
    prerelease: false,
    assets,
  };
}

function asset(version, overrides = {}) {
  const name = `OC.Faucet-${version}-arm64.dmg`;
  return {
    name,
    size: 4,
    browser_download_url: `https://github.com/qjy0128/oc-faucet/releases/download/v${version}/${name}`,
    ...overrides,
  };
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ocf-updater-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const states = [];
  const updater = createUpdater({
    currentVersion: '1.0.3',
    platform: 'darwin',
    arch: 'arm64',
    stateFile: path.join(directory, 'update-state.json'),
    downloadDir: path.join(directory, 'Downloads'),
    onState: (state) => states.push(state),
    ...options,
  });
  return { directory, states, updater };
}

test('发现更高稳定版本时选中当前平台的安装包并等待用户确认', async (t) => {
  const { updater } = await fixture(t, {
    fetch: async () => jsonResponse(release('1.0.4', [asset('1.0.4')])),
  });

  const result = await updater.checkForUpdates({ manual: true });

  assert.equal(result.status, 'available');
  assert.equal(result.currentVersion, '1.0.3');
  assert.equal(result.latestVersion, '1.0.4');
  assert.equal(result.assetName, 'OC.Faucet-1.0.4-arm64.dmg');
  assert.equal(result.releaseNotes, '修复若干问题');
});

test('自动检查距上次不足 24 小时时节流，到点后重新请求', async (t) => {
  let now = 1_800_000_000_000;
  let requests = 0;
  const { updater } = await fixture(t, {
    now: () => now,
    fetch: async () => {
      requests += 1;
      return jsonResponse(release('1.0.3', []));
    },
  });

  assert.equal((await updater.checkForUpdates()).status, 'up-to-date');
  assert.equal(requests, 1);

  now += 86_400_000 - 1;
  assert.equal((await updater.checkForUpdates()).status, 'throttled');
  assert.equal(requests, 1);

  now += 1;
  assert.equal((await updater.checkForUpdates()).status, 'up-to-date');
  assert.equal(requests, 2);
});

test('用户确认后校验下载内容，放入下载目录并启动安装器', async (t) => {
  const contents = Buffer.from('测试安装包内容');
  const digest = createHash('sha256').update(contents).digest('hex');
  const opened = [];
  const latest = release('1.0.4', [asset('1.0.4', { size: contents.length, digest: `sha256:${digest}` })]);
  const { directory, updater } = await fixture(t, {
    fetch: async (url) => {
      if (url.includes('/releases/latest')) return jsonResponse(latest);
      return new Response(contents);
    },
    openPath: async (file) => {
      opened.push(file);
      return '';
    },
  });
  await updater.checkForUpdates({ manual: true });

  const result = await updater.downloadAndOpen();

  const expectedFile = path.join(directory, 'Downloads', 'OC.Faucet-1.0.4-arm64.dmg');
  assert.equal(result.status, 'ready');
  assert.equal(result.filePath, expectedFile);
  assert.equal(result.launched, true);
  assert.deepEqual(await readFile(expectedFile), contents);
  assert.deepEqual(opened, [expectedFile]);
});

test('取消下载会中止请求并清理临时文件', async (t) => {
  const latest = release('1.0.4', [asset('1.0.4', { size: 100 })]);
  let opened = 0;
  const { directory, updater } = await fixture(t, {
    fetch: async (url, request = {}) => {
      if (url.includes('/releases/latest')) return jsonResponse(latest);
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from('前半段'));
          request.signal?.addEventListener('abort', () => controller.error(request.signal.reason));
        },
      }));
    },
    openPath: async () => {
      opened += 1;
      return '';
    },
  });
  await updater.checkForUpdates({ manual: true });
  assert.equal(typeof updater.cancelDownload, 'function');

  const downloading = updater.downloadAndOpen();
  while (updater.getState().downloadedBytes === 0) await new Promise((resolve) => setImmediate(resolve));
  updater.cancelDownload();
  const result = await downloading;

  assert.equal(result.status, 'available');
  assert.equal(result.error, '下载已取消');
  assert.equal(opened, 0);
  assert.deepEqual(await readdir(path.join(directory, 'Downloads')), []);
});

test('检查失败同样计入 24 小时节流，避免断网时反复请求', async (t) => {
  let now = 1_800_000_000_000;
  let requests = 0;
  const { updater } = await fixture(t, {
    now: () => now,
    fetch: async () => {
      requests += 1;
      throw new Error('网络不可用');
    },
  });

  await assert.rejects(() => updater.checkForUpdates({ manual: true }), /检查更新失败/);
  now += 3_600_000;
  assert.equal((await updater.checkForUpdates()).status, 'throttled');
  assert.equal(requests, 1);

  now += 86_400_000;
  await assert.rejects(() => updater.checkForUpdates(), /检查更新失败/);
  assert.equal(requests, 2);
});

test('没有更高版本或平台资产缺失时给出对应结论', async (t) => {
  const { updater: same } = await fixture(t, {
    fetch: async () => jsonResponse(release('1.0.3', [asset('1.0.3')])),
  });
  assert.equal((await same.checkForUpdates({ manual: true })).status, 'up-to-date');

  const { updater: windows } = await fixture(t, {
    platform: 'win32',
    arch: 'x64',
    fetch: async () =>
      jsonResponse(
        release('1.0.4', [
          {
            name: 'OC.Faucet.Setup.1.0.4.exe',
            size: 4,
            browser_download_url: 'https://example.com/OC.Faucet.Setup.1.0.4.exe',
          },
        ]),
      ),
  });
  const windowsResult = await windows.checkForUpdates({ manual: true });
  assert.equal(windowsResult.status, 'available');
  assert.equal(windowsResult.assetName, 'OC.Faucet.Setup.1.0.4.exe');

  const { updater: missing } = await fixture(t, {
    fetch: async () => jsonResponse(release('1.0.4', [])),
  });
  await assert.rejects(() => missing.checkForUpdates({ manual: true }), /没有适配/);
});

test('Windows 上同样走完下载、校验、启动的完整链路', async (t) => {
  const contents = Buffer.from('windows-installer');
  const latest = release('1.0.4', [
    {
      name: 'OC.Faucet.Setup.1.0.4.exe',
      size: contents.length,
      browser_download_url: 'https://example.com/OC.Faucet.Setup.1.0.4.exe',
    },
  ]);
  const opened = [];
  const { directory, updater } = await fixture(t, {
    platform: 'win32',
    arch: 'x64',
    fetch: async (url) => {
      if (url.includes('/releases/latest')) return jsonResponse(latest);
      return new Response(contents);
    },
    openPath: async (file) => {
      opened.push(file);
      return '';
    },
  });

  await updater.checkForUpdates({ manual: true });
  const result = await updater.downloadAndOpen();

  const expectedFile = path.join(directory, 'Downloads', 'OC.Faucet.Setup.1.0.4.exe');
  assert.equal(result.status, 'ready');
  assert.equal(result.launched, true);
  assert.equal(result.filePath, expectedFile);
  assert.deepEqual(await readFile(expectedFile), contents);
  assert.deepEqual(opened, [expectedFile]);
});

test('下载目录已有同名文件时换名保存，不覆盖原文件', async (t) => {
  const first = Buffer.from('旧的安装包');
  const fresh = Buffer.from('新安装包');
  const latest = release('1.0.4', [asset('1.0.4', { size: fresh.length })]);
  const { directory, updater } = await fixture(t, {
    fetch: async (url) => {
      if (url.includes('/releases/latest')) return jsonResponse(latest);
      return new Response(fresh);
    },
    openPath: async () => '',
  });
  const downloads = path.join(directory, 'Downloads');
  await mkdir(downloads, { recursive: true });
  await writeFile(path.join(downloads, 'OC.Faucet-1.0.4-arm64.dmg'), first);

  await updater.checkForUpdates({ manual: true });
  const result = await updater.downloadAndOpen();

  assert.equal(result.status, 'ready');
  assert.equal(result.filePath, path.join(downloads, 'OC.Faucet-1.0.4-arm64 (1).dmg'));
  assert.deepEqual(await readFile(path.join(downloads, 'OC.Faucet-1.0.4-arm64.dmg')), first);
  assert.deepEqual(await readFile(result.filePath), fresh);
});
