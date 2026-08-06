/** 
 * 消息入口 —— 通过输入消息获取 AI 回复
 */

import { askAI } from './ai.js';
import { getLogger } from '../system/logger.js';

/**
 * 根据输入消息获取回复。
 * @param {string} msg 用户输入
 * @returns {Promise<string>}
 */
export async function resolveReply(msg) {
  try {
    return await askAI(msg);
  } catch (err) {
    getLogger().toolAi.warn(`[回复失败] ${err.message}`);
    return '抱歉，我暂时无法回复，请稍后再试。';
  }
}