/** 
 * 消息入口 —— 通过输入消息获取 AI 回复
 */

import { askAI } from './ai.js';
import { getLogger } from '../system/logger.js';
import { CONFIG_PATHS, getConfig } from '../system/conf.js';

const getName = () => getConfig(CONFIG_PATHS.main).getString("name");
const getSubname = () => getConfig(CONFIG_PATHS.main).getString("subname");

/**
 * 根据输入消息获取回复。
 * @param {string} msg 用户输入
 * @param {object} [options] 配置
 * @param {boolean} [options.AI=true] 是否允许 AI 回复
 * @param {string[]|string} [options.AIlist="*"] 要使用的 AI Profile，"*" 表示全部允许
 * @param {boolean} [options.resolveCommand=true] 是否要执行命令
 * @param {string} [options.resolveCommandAs=""] 以谁的身份执行？
 * @returns {Promise<string>}
 */
export async function resolveReply(msg, options) {
  /** 默认配置 */
  const default_config = {
    AI: true,
    AIlist: "*",
    resolveCommand: true,
    resolveCommandAs: "",
  };
  /** 最终配置 */
  const config = Object.assign({}, default_config, options);

  // 守护服主的贞洁用
  // if (config.resolveCommandAs == /* hzc */"USR#4C48AEC137FEAA4B94954DCB4EF36389") return "hzcyq_Crazy 是香香软软的小南娘，快来一起吃团子喵！我来准备下糯米，你就准备艾草喵！"
  // AI 回复兜底
  if (!config.AI) return "（${getName()}静静地看着你，并对你发来的消息感到疑惑）";
  try {
    return await askAI(msg, config.AIlist);
  } catch (err) {
    getLogger().toolAi.error(`无法使用 AI 回复：${err.message}`);
    return `（${getName()}静静地看着你，并未言语）`;
  }
}