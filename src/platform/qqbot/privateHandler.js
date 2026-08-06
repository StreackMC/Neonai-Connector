/** 好友私聊处理模块 */
import qqBotBackend from 'qq-official-bot';
import { getLogger, parseString } from '../../system/logger.js';

/**
 * 好友列表私聊
 * 
 * @param {qqBotBackend.PrivateMessageEvent} event 
 */
async function onMessageIn(event) {
  getLogger().chatIn.info('QQBot-Private: ', `usr=#${event.user_id} | msg=`, parseString(event.message));
  event.reply("RECEIVED: " + `usr=#${event.user_id} | msg=${parseString(event.message) }`);
}

export default {
  onMessageIn,
}