/**
 * messageIn.js — 消息入口：命令 → AI 双层回复
 *
 * 1. 匹配 main.json.prefix 作为命令前缀 → 执行命令
 * 2. 无匹配 → AI 回复
 */

import { neonaicCommandServer } from '../command/commandServer.js';
import { neonaicAI } from './ai.js';
import { getLogger } from '../logger/Logger.js';
import { neonaicConfManager } from '../system/confManager.js';
import stripAnsi from 'strip-ansi';

/**
 * @param {string} msg
 * @param {object} [options]
 * @param {boolean} [options.AI=true]
 * @param {string[]|string} [options.AIlist="*"]
 * @param {boolean} [options.resolveCommand=true] 是否要执行命令
 * @param {import('../command/commandServer.js').NeonaicCommandContext} options.resolveCommandWith 执行时命令上下文
 * @returns {Promise<string>}
 */
async function resolveReply(msg, options) {
  getLogger().tool.debug('[msgIn] 正为消息生成回复：', { msg, options });
  const config = Object.assign({
    AI: true,
    AIlist: '*',
    resolveCommand: true,
    /** @type { import('../command/commandServer.js').NeonaicCommandContext } */
    resolveCommandWith: {
      executor: [this],
      this: this,
    },
  }, (typeof options === 'object') ? options : {});

  const trimmed = msg.trim();

  // ---- 命令匹配 ----
  if (config.resolveCommand && trimmed) {
    const prefixes = neonaicConfManager.getConfig(neonaicConfManager.CONFIG_PATHS.main).getList('prefix');
    for (const prefix of prefixes) {
      if (typeof prefix !== 'string' || !prefix) continue;
      if (!trimmed.startsWith(prefix)) continue;

      /** 无前缀的命令文本 */
      const cmdStr = trimmed.slice(prefix.length)./* 防止 "/ cmd" 这样的输入 */trimStart();
      /** 解析完成的参数列表 */
      const args = neonaicCommandServer.parseArgs(cmdStr);
      if (/* 没有解析到命令 */!args[0]) return `“${neonaicConfManager.getBotName()}”无法执行“${trimmed}”，因为“${neonaicConfManager.getBotName()}”无法理解这个命令。`;

      const [cmdName, cmdArgs] = args;
      if (/* 命令不存在 */!neonaicCommandServer.hasCommand(cmdName)) return `“${neonaicConfManager.getBotName()}”无法执行“${cmdName}”，因为“${neonaicConfManager.getBotName()}”无法理解这个命令。`;

      const ctx = config.resolveCommandWith || {};
      try {
        const result = await neonaicCommandServer.executeCommandSilent(cmdName, ctx, ...cmdArgs);
        return result != null ? stripAnsi(String(result)).trim() : `“${neonaicConfManager.getBotName()}”成功执行了“${cmdName}”。`;
      } catch (err) {
        getLogger().cmd.warn(`[msgIn] 无法以“`, ctx,`”执行命令“${cmdName}”: ${err.message}`);
        return stripAnsi(`“${neonaicConfManager.getBotName()}”无法执行“${cmdName}”，因为“${stripAnsi(err.message)}”。`);
      }
    }
  }

  // ---- AI 兜底 ----
  if (!config.AI) return `（${neonaicConfManager.getBotName()}可能在看着你，但并未言语）`;
  try {
    return stripAnsi(await neonaicAI.askAI(msg, config.AIlist, config.resolveCommandWith?.executor)).trim();
  } catch (err) {
    getLogger().tool.error(`[msgIn] AI 回复失败: ${err.message}`);
    return `（${neonaicConfManager.getBotName()}静静地看着你，并未言语）`;
  }
}

export const neonaicMessageIn = {
  resolveReply,
};
