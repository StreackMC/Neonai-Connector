/** 好友私聊处理模块 */
import qqBotBackend from 'qq-official-bot';
import { parseString } from '../../system/logger.js';
import { PlatformQQBot } from './qqbot.js';

/**
 * 好友列表私聊
 * 
 * @param {qqBotBackend.PrivateMessageEvent} event 
 * @param {PlatformQQBot} pp 
 */
async function onMessageIn(event, pp) {
  pp.logMsgIn('Private: ', `from=USR#${event.user_id} | msg=`, parseString(event.message));
  event.reply("RECEIVED: " + `from=USR#${event.user_id} | msg=${parseString(event.message) }`);
}

export default {
  onMessageIn,
}