/** 
 * 通过输入消息获取回复
 */

import { getLogger } from "../system/logger.js";

/** 通过输入消息获取回复
 * @param {string} msg 消息输入
 * @returns {Promise<string>}
 */
export async function resolveReply(msg) {
  const r = await new Promise((rs, rj) => { setTimeout(() => rs("喵~"), 1000); });
  return r;
}