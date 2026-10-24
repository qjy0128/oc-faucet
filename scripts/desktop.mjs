#!/usr/bin/env node
/**
 * 桌面控制面板的启动器。
 *
 * 为什么不直接写 `electron .`：没装依赖时那会得到一句 `electron: command not found`，
 * 而且 **npm 的退出码还是 0**——用户完全看不出哪里不对，只看到一个没反应的黑框。
 * 这里把两件事一起处理掉：找不到 electron 时说清楚怎么办，并且如实返回非 0。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** electron 的入口在 node_modules 里就是一个可执行文件，解析它比自己拼路径可靠。 */
function resolveElectron() {
  const require = createRequire(join(root, 'package.json'));
  try {
    // electron 包导出的就是可执行文件的路径
    return require('electron');
  } catch {
    return null;
  }
}

const electron = resolveElectron();
if (!electron || typeof electron !== 'string' || !existsSync(electron)) {
  console.error('\n启动失败：还没装桌面窗口需要的组件（electron）。');
  console.error('请在项目目录里先跑一次：');
  console.error('');
  console.error('    npm install');
  console.error('');
  console.error('装完再跑：npm run desktop');
  console.error('\n（只想用命令行的话可以跳过它，直接 npm start，不需要装任何东西。）');
  process.exit(1);
}

const child = spawn(electron, [root], { stdio: 'inherit' });
child.on('error', (err) => {
  console.error(`\n启动失败：${err?.message ?? err}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  // 用户正常关窗口时 code 会是 0；被信号打断也算正常收摊。
  process.exit(signal ? 0 : (code ?? 0));
});
