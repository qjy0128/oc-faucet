#!/usr/bin/env node
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VERSION = '1.4.4';
const TARGETS = {
  'darwin-arm64': { package: '@oven/bun-darwin-aarch64', binary: 'bun' },
  'win32-x64': { package: '@oven/bun-windows-x64', binary: 'bun.exe' },
};

const requested = process.argv.slice(2);
if (!requested.length) {
  const current = `${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch}`;
  requested.push(current);
}

for (const target of requested) {
  const spec = TARGETS[target];
  if (!spec) {
    console.error(`不支持的 Bun 目标平台：${target}`);
    process.exit(1);
  }
  const destination = join(ROOT, 'desktop', 'build', 'bun', target, spec.binary);
  if (existsSync(destination)) continue;

  const installed = join(
    ROOT,
    'node_modules',
    spec.package,
    'bin',
    spec.binary,
  );
  mkdirSync(dirname(destination), { recursive: true });
  if (existsSync(installed)) {
    copyFileSync(installed, destination);
  } else {
    const work = mkdtempSync(join(tmpdir(), 'ocf-bun-'));
    const windows = process.platform === 'win32';
    try {
      const packed = JSON.parse(execFileSync(
        windows ? 'npm.cmd' : 'npm',
        ['pack', `${spec.package}@${VERSION}`, '--pack-destination', work, '--json'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: windows },
      ));
      const tarball = join(work, packed[0].filename);
      execFileSync('tar', ['-xzf', tarball, '-C', work], { shell: windows });
      copyFileSync(join(work, 'package', 'bin', spec.binary), destination);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  if (process.platform !== 'win32') chmodSync(destination, 0o755);
  console.log(`Bun ${VERSION}（${target}）已准备：${destination}`);
}
