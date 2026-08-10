/**
 * 消息入口 —— 命令 → AI 双层回复
 *
 * 1. 匹配 main.json.prefix 作为命令前缀 → 执行命令
 * 2. 无匹配 → AI 回复
 */

import { executeCommandSilent, parseArgs } from './commandServer.js';
import { askAI } from '../../extensions/handler/ai/index.js';
import { getLogger } from '../system/logger/logger.js';
import { CONFIG_PATHS, getConfig } from '../system/conf.js';

const getName = () => getConfig(CONFIG_PATHS.main).getString('name');
const getSubname = () => getConfig(CONFIG_PATHS.main).getString('subname');

/**
 * @param {string} msg
 * @param {object} [options]
 * @param {boolean} [options.AI=true]
 * @param {string[]|string} [options.AIlist="*"]
 * @param {boolean} [options.resolveCommand=true]
 * @param {string|string[]} [options.resolveCommandAs=""] 执行者标识
 * @returns {Promise<string>}
 */
export async function resolveReply(msg, options) {
  const config = Object.assign({
    AI: true,
    AIlist: '*',
    resolveCommand: true,
    resolveCommandAs: '',
  }, options ?? {});

  const trimmed = msg.trim();

  // ---- 命令匹配 ----
  if (config.resolveCommand && trimmed) {
    const prefixes = getConfig(CONFIG_PATHS.main).getList('prefix');
    for (const prefix of prefixes) {
      if (typeof prefix !== 'string' || !prefix) continue;
      if (!trimmed.startsWith(prefix)) continue;

      const cmdStr = trimmed.slice(prefix.length).trimStart();
      const args = parseArgs(cmdStr);
      if (!args.length) return `× 未知命令（空输入）`;

      const [cmdName, ...cmdArgs] = args;
      const executor = config.resolveCommandAs || undefined;

      try {
        const result = await executeCommandSilent(cmdName, { executor }, ...cmdArgs);
        return result != null ? String(result).trim() : '✓ 操作成功完成';
      } catch (err) {
        getLogger().cmd.warn(`[${executor}] 命令执行失败: ${err.message}`);
        return `× ${err.message}`;
      }
    }
  }

  // ---- AI 兜底 ----
  if (!config.AI) return `（${getName()}静静地看着你，并未言语）`;
  try {
    return (await askAI(msg, config.AIlist)).trim();
  } catch (err) {
    getLogger().toolAi.error(`AI 回复失败: ${err.message}`);
    return `（${getName()}静静地看着你，并未言语）`;
  }
}
