/**
 * 消息入口 —— 命令 → AI 双层回复
 *
 * 1. 匹配 main.json.prefix 作为命令前缀 → 执行命令
 * 2. 无匹配 → AI 回复
 */

import { executeCommandSilent, hasCommand, parseArgs } from './commandServer.js';
import { askAI } from './ai.js';
import { getLogger } from '../system/logger/logger.js';
import { CONFIG_PATHS, getConfig } from '../system/conf.js';
import stripAnsi from 'strip-ansi';

const getName = () => getConfig(CONFIG_PATHS.main).getString('name');
const getSubname = () => getConfig(CONFIG_PATHS.main).getString('subname');

/**
 * @param {string} msg
 * @param {object} [options]
 * @param {boolean} [options.AI=true]
 * @param {string[]|string} [options.AIlist="*"]
 * @param {boolean} [options.resolveCommand=true] 是否要执行命令
 * @param {import('./commandServer.js').CommandContext} options.resolveCommandWith 执行时命令上下文
 * @returns {Promise<string>}
 */
export async function resolveReply(msg, options) {
  const config = Object.assign({
    AI: true,
    AIlist: '*',
    resolveCommand: true,
    resolveCommandWith: '',
  }, options ?? {});

  const trimmed = msg.trim();

  // ---- 命令匹配 ----
  if (config.resolveCommand && trimmed) {
    const prefixes = getConfig(CONFIG_PATHS.main).getList('prefix');
    for (const prefix of prefixes) {
      if (typeof prefix !== 'string' || !prefix) continue;
      if (!trimmed.startsWith(prefix)) continue;

      /** 无前缀的命令文本 */
      const cmdStr = trimmed.slice(prefix.length).trimStart();
      /** 解析完成的参数列表 */
      const args = parseArgs(cmdStr);
      if (!args.length) return `“${getBotName()}”无法执行“${trimmed}”，因为“${getName()}”无法理解这个命令。`;
      
      const [cmdName, ...cmdArgs] = args;
      const ctx = config.resolveCommandWith || undefined;
      if (!hasCommand(cmdName)) return `“${getBotName()}”无法执行“${cmdName}”，因为“${getName()}”无法理解这个命令。`;

      try {
        const result = await executeCommandSilent(cmdName, ctx, ...cmdArgs);
        return result != null ? stripAnsi(String(result)).trim() : `“${getName()}”成功执行了“${cmdName}”`;
      } catch (err) {
        getLogger().cmd.warn(`无法以“`, ctx,`”命令“${cmdName}”: ${err.message}`);
        return stripAnsi(`“${getBotName()}”无法执行“${cmdName}”，因为“${stripAnsi(err.message)}”。`);
      }
    }
  }

  // ---- AI 兜底 ----
  if (!config.AI) return `（${getName()}可能在看着你，但并未言语）`;
  try {
    return stripAnsi(await askAI(msg, config.AIlist)).trim();
  } catch (err) {
    getLogger().toolAi.error(`AI 回复失败: ${err.message}`);
    return `（${getName()}静静地看着你，并未言语）`;
  }
}
