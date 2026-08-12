import qqBotBackend from 'qq-official-bot';
import he from 'he';
import { getLogger, parseString } from '../../../src/system/logger/logger.js';
import { PlatformQQBot } from './index.js';
import { resolveReply } from '../../../src/handler/msgIn.js';
import { getBotName, getConfig } from '../../../src/system/conf.js';
import { getPlatformManager } from '../../../src/platform/platform-manager.js';
import { fromQQElement } from './emoji.js';
import { COMMAND_ENUMS, registerCommand } from '../../../src/handler/commandServer.js';

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
 * 向对象发送消息
 * @param {PlatformQQBot} instance QQ机器人实例
 * @param {string} who 目标对象
 * @param {qqBotBackend.Sendable|String} msg 消息内容
 * @returns {Promise<import('qq-official-bot').SendResult|null>} 结果（发送失败时 throw）
 * @throws 无法识别参数 / 发送失败
 */
export async function sendMsg(instance, who, msg) {
  if (!(instance instanceof PlatformQQBot)) throw new Error("指定的 Platform 无效");
  if (!instance.bot) throw new Error("QQBot 实例尚未启动");
  who = parseString(who).trim();
  if (who.startsWith('USR#')) {
    // 私聊
    return await instance.bot.sendPrivateMessage(who.slice(4), msg);
  } else if (who.startsWith('GRP#')) {
    // 群聊
    return await instance.bot.sendGroupMessage(who.slice(4), msg);
  }
  // 无效用户
  throw new Error("无法识别的用户：" + parseString(who));
}

registerCommand('qqbot', 'qbsend', async function (profile, who, ...msg) {
  // 获取实例
  const instance = getPlatformManager().getPlatform(parseString(profile));
  if (!(instance instanceof PlatformQQBot)) throw new Error("指定的 Platform Profile 无效");
  // 发送消息
  const messageContent = msg.map(v => parseString(v, false)).join('');
  try {
    const result = await sendMsg(instance, who, messageContent);
    getLogger().platP.debug(`[qqbot] 向`, who, `@`, profile, `发送消息`, msg, `：`, result);
    instance.logMsgOut('Command:', `to=${who} | msg=`, messageContent.replace(/\n/g, "\\n"));
    // SendResult 可能为「消息审核中」状态
    if (result?.audit_status === 'pending') {
      return `“${getBotName()}”已向[${who}]发送消息，但消息正在审核中。`;
    }
    return `“${getBotName()}”成功向[${who}]发送指定消息。`;
  } catch (err) {
    getLogger().platP.debug(`[qqbot] 向`, who, `@`, profile, `发送消息失败：`, err.message);
    return `“${getBotName()}”无法向[${who}]发送指定消息，因为“${err.message}”。`;
  }
}, {
  permissions: [[COMMAND_ENUMS.PERM_SUPERADMIN, "qqbot.command.qbsend"]],
  description: "使用官方QQBOT向指定渠道发送消息，需要对应渠道允许接收机器人消息：群聊需要群主开启推送权限；私聊需要加为好友并开启推送权限。",
  usage: "qbsend <profile> <who> <...msg>",
})

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