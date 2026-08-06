/** 群聊处理模块 */
import qqBotBackend from 'qq-official-bot';
import { getLogger, parseString } from '../../system/logger.js';

/**
 * 群聊消息
 * 
 * @param {qqBotBackend.GroupMessageEvent} event 
 */
async function onMessageIn(event) {
  getLogger().chatIn.info('QQBot-Group: ', `group=${event.group_name}#${event.group_id} | usr=#${event.user_id} | msg=`, parseString(event.message));
  event.reply("RECEIVED: " + `group=${event.group_name}#${event.group_id} | usr=#${event.user_id} | msg=${parseString(event.message)}`)
}

export default {
  onMessageIn,
};