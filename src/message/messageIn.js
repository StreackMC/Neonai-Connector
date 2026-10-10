/**
 * messageIn.js — 消息入口：命令 → AI 双层回复
 *
 * 1. 匹配 main.json.prefix 作为命令前缀 → 执行命令
 * 2. 无匹配 → AI 回复
 */

import { NeonaicCommandContext, neonaicCommandServer } from '../command/commandServer.js';
import { neonaicAI } from './ai.js';
import { getLogger } from '../logger/Logger.js';
import { neonaicConfManager } from '../system/confManager.js';
import stripAnsi from 'strip-ansi';
import { NeonaicMessageEvent } from '../event/neonaicEventInterface.js';
import { parseString } from '../utils/chore.js';
import { neonaicPermissionServer } from '../command/permissionServer.js';

/**
 * @typedef {Object} NeonaicTReplyPayload
 * @property {string} text 回复内容
 * @property {boolean} failed 如果为真，表示回复失败，此时另外一个字段就不是 null 了
 * @property {NeonaicTReplyStatus} status 回复状态
 * @typedef {'SUCCESS' | 'CANCELED_BY_EVENT' | 'PERMISSION_OF_AI_DENIED' | 'AI_DISABLED' | 'AI_FAILED' | 'CMD_FAILED' | 'VOID_CMD' | 'UNKNOWN_CMD' | 'PERMISSION_OF_CMD_DENIED' | 'UNABLE_TO_GET_CMD'} NeonaicTReplyStatus
 */

/** 回复因各种原因失败的预设值 */
const REPLY_FALLBACK = Object.freeze({
  /** 被事件中断 */
  CANCELED_BY_EVENT: () => `（${neonaicConfManager.getBotName()}静静地看着你，并未言语）`,
  /** 无权限使用 AI */
  PERMISSION_OF_AI_DENIED: () => `（${neonaicConfManager.getBotName()}静静地看着别处，并未言语）`,
  /** AI 回复被禁用 */
  AI_DISABLED: () => `（${neonaicConfManager.getBotName()}可能在看着你，但并未言语）`,
  /** AI 回复失败 */
  AI_FAILED: () => `（${neonaicConfManager.getBotName()}静静地看着你，并未言语）`,
  /** 无法执行命令 */
  CMD_FAILED: (err, cmdName) => stripAnsi(`“${neonaicConfManager.getBotName()}”无法执行“${cmdName}”，因为“${parseString(err)}”。`),
  /** 命令没有返回值 */
  VOID_CMD: (cmdName) => `“${neonaicConfManager.getBotName()}”成功执行了“${cmdName}”。`,
  /** 未知命令 */
  UNKNOWN_CMD: (cmdName) => `“${neonaicConfManager.getBotName()}”无法执行“${cmdName}”，因为“${neonaicConfManager.getBotName()}”无法理解这个命令。`,
  /** 执行命令的权限不足，使用未知为由隐藏存在 */
  PERMISSION_OF_CMD_DENIED: (cmdName) => `“${neonaicConfManager.getBotName()}”无法执行“${cmdName}”，因为“${neonaicConfManager.getBotName()}”无法理解这个命令。`,
  /** 未能解析到命令 */
  UNABLE_TO_GET_CMD: (trimmed) => `“${neonaicConfManager.getBotName()}”无法执行“${trimmed}”，因为“${neonaicConfManager.getBotName()}”无法理解这个命令。`,
});

/**
 * @param {string} msg
 * @param {object} [options]
 * @param {boolean} [options.dispatchEvent=true] 是否要广播事件
 * @param {boolean} [options.preventedByEvent=true] 本回复是否能通过事件来取消
 * @param {boolean} [options.AI=true] 是否要使用 AI
 * @param {string[]|string} [options.AIlist="*"]
 * @param {boolean} [options.resolveCommand=true] 是否要执行命令
 * @param {import('../command/commandServer.js').NeonaicCommandContext} options.resolveCommandWith 执行时命令上下文
 * @returns {Promise<NeonaicTReplyPayload>}
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
    preventedByEvent: true,
    dispatchEvent: true,
  }, (typeof options === 'object') ? options : {});

  const trimmed = msg.trim();

  // ---- 事件广播 ----
  if (config.dispatchEvent) {
    const eventBus = (await import('../event/neonaicEventBus.js')).neonaicEventBus;
    if (!eventBus.dispatchEvent(
      new NeonaicMessageEvent(
        null,
        config.resolveCommandWith.executor,
        msg,
        {
          cancelable: config?.preventedByEvent,
        }
      )
    )) {
      getLogger().tool.debug('[msgIn] 消息被事件取消，返回默认回复。');
      return {
        text: REPLY_FALLBACK.CANCELED_BY_EVENT(),
        failed: true,
        status: 'CANCELED_BY_EVENT'
      };
    }
  }

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
      if (/* 没有解析到命令 */!args[0]) return {
        text: REPLY_FALLBACK.UNABLE_TO_GET_CMD(trimmed),
        failed: true,
        status: 'UNABLE_TO_GET_CMD'
      };

      const [cmdName, cmdArgs] = args;
      if (/* 命令不存在 */!neonaicCommandServer.hasCommand(cmdName)) return {
        text: REPLY_FALLBACK.UNKNOWN_CMD(cmdName),
        failed: true,
        status: 'UNKNOWN_CMD'
      };

      /* 开始执行命令 */
      const ctx = new NeonaicCommandContext(config.resolveCommandWith || {});
      if (neonaicPermissionServer.checkPermissionFromContext(ctx, neonaicCommandServer.resolveCommand(cmdName).permissions) === false) {
        getLogger().cmd.debug(`[msgIn] 无法以“`, ctx, `”执行命令“${cmdName}”: 权限不足`);
        return {
          text: REPLY_FALLBACK.PERMISSION_OF_CMD_DENIED(cmdName),
          failed: true,
          status: 'PERMISSION_OF_CMD_DENIED'
        };
      }
      try {
        const result = await neonaicCommandServer.executeCommandSilent(cmdName, ctx, ...cmdArgs);
        return {
          text: result != null ? stripAnsi(String(result)).trim() : REPLY_FALLBACK.VOID_CMD(cmdName),
          failed: false,
          status: 'SUCCESS'
        };
      } catch (err) {
        getLogger().cmd.warn(`[msgIn] 无法以“`, ctx, `”执行命令“${cmdName}”: ${err.message}`);
        return {
          text: REPLY_FALLBACK.CMD_FAILED(err, cmdName),
          failed: true,
          status: 'CMD_FAILED'
        };
      }
    }
  }

  // ---- AI 兜底 ----
  if (/* 禁用 AI 回复时 */!config.AI) return {
    text: REPLY_FALLBACK.AI_DISABLED(),
    failed: false,
    status: 'AI_DISABLED'
  };
  if (/* 无权使用 AI */neonaicAI.isAIBanned(config.resolveCommandWith?.executor)) return {
    text: REPLY_FALLBACK.PERMISSION_OF_AI_DENIED(),
    failed: true,
    status: 'PERMISSION_OF_AI_DENIED'
  };
  try {
    return {
      text: stripAnsi(await neonaicAI.askAI(msg, { AIlist: config.AIlist, caller: config.resolveCommandWith?.executor })).trim(),
      failed: false,
      status: 'SUCCESS'
    };
  } catch (err) {
    getLogger().tool.error(`[msgIn] AI 回复失败: `, err);
    return {
      text: REPLY_FALLBACK.AI_FAILED(),
      failed: true,
      status: 'AI_FAILED'
    };
  }
}

export const neonaicMessageIn = {
  resolveReply,
  REPLY_FALLBACK,
};
