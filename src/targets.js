/**
 * 「接入目标」注册表。
 *
 * 每个目标实现同一组接口：
 *   id:      稳定字符串，动作接口靠它找人（ZCode 固定为 'zcode'）
 *   label:   界面上给人看的名字
 *   detect(): boolean —— 目标应用装没装（按配置目录/文件存在性判断）
 *   status(): Promise<{ written: boolean, models: string[] }> —— 实读目标配置文件，
 *             返回我们写入的模型 id 清单（绝不许拿内存缓存糊弄）
 *   install(models, { port, apiKey }): 写入，返回形状沿用各目标原模块的结果
 *   uninstall(): 摘除，返回形状沿用各目标原模块的结果
 *
 * 两个可选字段给界面用：
 *   protocol      这个目标吃的是桥的哪一种接口（'anthropic' | 'openai' | 'responses'）
 *   selectsModels true 表示写入前让用户勾模型，否则一律写全部可用模型
 *
 * 目标清单即 defaults 数组；新增目标在这里加一行即可。
 */
import { createZcodeTarget } from './target-zcode.js';
import { createDshTarget } from './target-dsh.js';
import { createQoderTarget, createQoderCnTarget } from './target-qoder.js';
import { createWorkbuddyTarget } from './target-workbuddy.js';
import { createCodebuddyTarget } from './target-codebuddy.js';
import { createPiTarget } from './target-pi.js';
import { createKimiTarget } from './target-kimi.js';
import { createClaudeTarget } from './target-claude.js';
import { createCodexTarget } from './target-codex.js';

/**
 * @param {object} [overrides] 按 id 整个换掉默认实现——测试靠它塞假目标，不碰真实配置文件
 * @returns {Array<object>} 目标对象数组
 */
export function createTargets(overrides = {}) {
  const defaults = [
    createZcodeTarget(),
    createDshTarget(),
    createQoderTarget(),
    createQoderCnTarget(),
    createWorkbuddyTarget(),
    createCodebuddyTarget(),
    createPiTarget(),
    createKimiTarget(),
    createClaudeTarget(),
    createCodexTarget(),
  ];
  return defaults.map((target) => overrides[target.id] ?? target);
}
