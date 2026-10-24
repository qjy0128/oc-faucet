/**
 * ZCode 接入目标：统一「接入目标」接口的第一个实现。
 *
 * 这是一层薄封装——真正的读写逻辑都在 zcode-config.js 里，一行没动。
 * 路径注入沿用 zcode-config 的环境变量覆盖（OCF_ZCODE_CONFIG 等，调用时现读），
 * 测试把路径指到临时目录，不会碰真实的 HOME。
 */
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import * as zcode from './zcode-config.js';

export function createZcodeTarget() {
  return {
    id: 'zcode',
    label: 'ZCode',

    /** ZCode 装没装：按配置目录/文件的存在性判断 */
    detect() {
      const file = zcode.configPath();
      return existsSync(file) || existsSync(dirname(file));
    },

    /** 我们写入的模型清单。每次调用都实读配置文件（走 zcode-config 的助手），不用内存缓存糊弄。 */
    async status() {
      const models = await zcode.readOurModelIds();
      return { written: models.length > 0, models };
    },

    /** 把模型写进 ZCode，返回形状沿用 zcode-config.install 的原样 */
    install(models, { port, apiKey } = {}) {
      return zcode.install({ port, apiKey, models });
    },

    /** 从 ZCode 摘掉我们那条，返回形状沿用 zcode-config.uninstall 的原样 */
    uninstall() {
      return zcode.uninstall();
    },
  };
}
