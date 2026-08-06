/** 群聊处理模块 */
import qqBotBackend from 'qq-official-bot';
import { parseString } from '../../system/logger.js';
import { PlatformQQBot } from './qqbot.js';

/**
 * 群聊消息
 * 
 * @param {qqBotBackend.GroupMessageEvent} event 
 * @param {PlatformQQBot} pp 
 */
async function onMessageIn(event, pp) {
  pp.logMsgIn('Group: ', `group=GRP#${event.group_id} | from=USR#${event.user_id} | msg=`, parseString(event.message));
  event.reply("RECEIVED: " + `group=GRP#${event.group_id} | from=USR#${event.user_id} | msg=${parseString(event.message)}`)
}

export default {
  onMessageIn,
};