import qqBotBackend from 'qq-official-bot';
import { parseString } from '../../system/logger.js';
import { PlatformQQBot } from './qqbot.js';
import { resolveReply } from '../../handler/msgin.js';

/**
 * 好友列表私聊
 * 
 * @param {qqBotBackend.PrivateMessageEvent} event 
 * @param {PlatformQQBot} pp 
 */
async function onPrivateMessageIn(event, pp) {
  pp.logMsgIn('Private:', `from=USR#${event.user_id} | msg=` + parseString(event.message, false));
  const reply = await resolveReply(toMarkdown(event.message, pp));
  if (reply) {
    pp.logMsgOut('Private:', `to=USR#${event.user_id} | msg=`, reply.replace(/\n/g, "\\n"));
    event.reply(reply);
  }
}

/**
 * 群聊消息
 * 
 * @param {qqBotBackend.GroupMessageEvent} event 
 * @param {PlatformQQBot} pp 
 */
async function onGroupMessageIn(event, pp) {
  pp.logMsgIn('Group:', `where=GRP#${event.group_id} | from=USR#${event.user_id} | msg=` + parseString(event.message, false));
  const reply = await resolveReply(toMarkdown(event.message, pp));
  if (reply) {
    pp.logMsgOut('Group:', `where=GRP#${event.group_id} | to=USR#${event.user_id} | msg=`, reply.replace(/\n/g, "\\n"));
    event.reply(reply);
  }
}

/**
 * @param {qqBotBackend.Sendable} raw 原始信息
 * @param {PlatformQQBot} pp 
 * @returns {String} Markdown 格式的信息
 */
function toMarkdown(raw, pp) {
  let result = "";
  raw.forEach((piece) => {
    switch (piece?.type) {
      case 'text':
        result += piece.text;
        break;
      case '':
        //TODO: 先把基本文本消息搞定，然后再考虑富文本消息
        // 所以这部分以后再写
      default:
        pp.log('warn', "无法将消息片段", piece, "转换为 Markdown，未知的消息类型：", piece.type);
        break;
    }
  });
  return result;
}

export default {
  onPrivateMessageIn,
  onGroupMessageIn,
}