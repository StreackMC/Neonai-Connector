import qqBotBackend from 'qq-official-bot';
import { parseString } from '../../../src/system/logger/logger.js';
import { PlatformQQBot } from './index.js';
import { resolveReply } from '../../../src/handler/msgIn.js';
import { getConfig } from '../../../src/system/conf.js';
import { getPlatformManager } from '../../../src/platform/platform-manager.js';
import { fromQQElement } from './emoji.js';

/**
 * 好友列表私聊
 * 
 * @param {qqBotBackend.PrivateMessageEvent} event 
 * @param {PlatformQQBot} pp 
 */
async function onPrivateMessageIn(event, pp) {
  /** 实例的 Profile 配置 */
  const profile_config = getPlatformManager().getProfile(pp.profile);
  
  pp.logMsgIn('Private:', `from=USR#${event.user_id} | msg=` + parseString(event.message, false).replace(/\n/g, "\\n"));
  const reply = await resolveReply(toMarkdown(event.message, pp), {
    AI: profile_config.useAI, AIlist: profile_config.allowedAI,
    resolveCommandWith: {
      executor: `USR#${event.user_id}`,
      privateExecutor: true,
      internalCall: false,
    }
  });
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
  /** 实例的 Profile 配置 */
  const profile_config = getPlatformManager().getProfile(pp.profile);

  pp.logMsgIn('Group:', `where=GRP#${event.group_id} | from=USR#${event.user_id} | msg=` + parseString(event.message, false).replace(/\n/g, "\\n"));
  const reply = await resolveReply(toMarkdown(event.message, pp), {
    AI: profile_config.useAI, AIlist: profile_config.allowedAI,
    resolveCommandWith: {
      executor: [`USR#${event.user_id}`, `GRP#${event.group_id}`],
      privateExecutor: false,
      internalCall: false,
    }
  });
  if (reply) {
    pp.logMsgOut('Group:', `where=GRP#${event.group_id} | to=USR#${event.user_id} | msg=`, reply.replace(/\n/g, "\\n"));
    event.reply("\n" + reply);
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
    switch (parseString(piece?.type).trim().toLowerCase()) {
      case 'text':// 纯文本
        result += piece.text;
        break;
      case 'face':// 表情
        result += ` :[${fromQQElement(piece)?.text ?? 'Unknown Emoji'}]: `;
        break;
      case 'image':// 图片
        result += ` ![Image:${piece?.name ?? 'Untitled Image'}](${piece?.url ?? '//UnknownUrl'}) `;
        break;
      case 'audio':// 音频
        result += ` <audio controls title="${he.escape(piece?.name ?? 'Untitled Audio')}"><source src="${he.escape(piece?.url ?? '//UnknownUrl')}"></audio> `;
        break;
      case 'video':// 视频
        result += ` <video controls title="${he.escape(piece?.name ?? 'Untitled Video')}"><source src="${he.escape(piece?.url ?? '//UnknownUrl')}"></video> `;
        break;
      case 'link':// 链接
        // Warn: 没有转义
        result += `[${piece?.text ?? piece?.url ?? '//UnknownUrl'}](${piece?.url ?? '//UnknownUrl'} "${piece?.description ?? 'A link'}")`;
        break;

      default:
        //TODO: 还有其他富文本消息类型没有转换
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