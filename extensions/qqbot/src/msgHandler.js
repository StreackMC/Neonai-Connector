import qqBotBackend from 'qq-official-bot';
import he from 'he';
import JSON5 from 'json5';
import { getLogger } from '../../../src/logger/Logger.js';
import { parseString } from '../../../src/utils/chore.js';
import { PlatformQQBot } from './entry.js';
import { neonaicMessageIn } from '../../../src/message/messageIn.js';
import { neonaicConfManager } from '../../../src/system/confManager.js';
import { neonaicPlatformManager } from '../../../src/platform/platformManager.js';
import { fromQQElement } from './emoji.js';
import { pickAIList } from './aiRoute.js';
import { neonaicUserDirectory } from '../../../src/message/userDirectory.js';
import { neonaicCommandServer } from '../../../src/command/commandServer.js';
import { neonaicCommandInterface } from '../../../src/command/commandInterface.js';
import { NeonaicIllegalArgumentError } from '../../../src/utils/NeonaicNewableError.js';
import { neonaicEventBus } from '../../../src/event/neonaicEventBus.js';
import { NeonaicMessageEvent } from '../../../src/event/neonaicEventInterface.js';

/**
 * 好友列表私聊
 * 
 * @param {qqBotBackend.PrivateMessageEvent} event 
 * @param {PlatformQQBot} pp 
 */
async function onPrivateMessageIn(event, pp) {
  /** 实例的 Profile 配置 */
  const profile_config = neonaicPlatformManager.getPlatformManager().getProfile(pp.profile);
  const user = `qUSR#${event.user_id}@${pp.selfInfo.id}`;
  const markdown = toMarkdown(event.message, pp);
  noteKnownNames(event, { user });

  pp.logMsgIn('Private:', `from=${user} | msg=` + parseString(event.message, false).replace(/\n/g, "\\n"));
  const reply = await neonaicMessageIn.resolveReply(markdown, {
    AI: profile_config.useAI,
    AIlist: pickAIList(profile_config.aiRouting, profile_config.allowedAI, {
      scene: 'private', profile: pp.profile, user, group: '', executor: [user], text: markdown,
    }),
    resolveCommandWith: {
      executor: user,
      privateExecutor: true,
      internalCall: false,
    }
  });
  if (reply) {
    pp.logMsgOut('Private:', `to=${user} | msg=`, reply.replace(/\n/g, "\\n"));
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
  const profile_config = neonaicPlatformManager.getPlatformManager().getProfile(pp.profile);
  const user = `qUSR#${event.user_id}@${pp.selfInfo.id}`;
  const group = `qGRP#${event.group_id}@${pp.selfInfo.id}`;
  const markdown = toMarkdown(event.message, pp);
  noteKnownNames(event, { user, group });

  pp.logMsgIn('Group:', `where=${group} | from=${user} | msg=` + parseString(event.message, false).replace(/\n/g, "\\n"));
  neonaicEventBus.dispatchEvent(new NeonaicMessageEvent(pp, [user, group], markdown, async (msg) => {
    pp.sendMsg(group, msg).then(() => {
      pp.logMsgOut('Group:', `where=${group} | to=${user} | msg=`, msg.replace(/\n/g, "\\n"));
    }).catch((e) => {
      pp.log('error', 'Failed to send message to group:', `where=${group} | to=${user} | error=`, e, ` | msg=`, msg.replace(/\n/g, "\\n"));
    });
  }));
}

/**
 * 群聊消息
 * 
 * @param {qqBotBackend.GroupMessageEvent} event 
 * @param {PlatformQQBot} pp 
 */
async function onGroupAtMessageIn(event, pp) {
  /** 实例的 Profile 配置 */
  const profile_config = neonaicPlatformManager.getPlatformManager().getProfile(pp.profile);
  const user = `qUSR#${event.user_id}@${pp.selfInfo.id}`;
  const group = `qGRP#${event.group_id}@${pp.selfInfo.id}`;
  const markdown = toMarkdown(event.message, pp);
  noteKnownNames(event, { user, group });

  pp.logMsgIn('GroupAt:', `where=${group} | from=${user} | msg=` + parseString(event.message, false).replace(/\n/g, "\\n"));
  const reply = await neonaicMessageIn.resolveReply(markdown, {
    AI: profile_config.useAI,
    AIlist: pickAIList(profile_config.aiRouting, profile_config.allowedAI, {
      scene: 'group', profile: pp.profile, user, group, executor: [user, group], text: markdown,
    }),
    resolveCommandWith: {
      executor: [user, group],
      privateExecutor: false,
      internalCall: false,
    }
  });
  if (reply) {
    pp.logMsgOut('GroupAt:', `where=${group} | to=${user} | msg=`, reply.replace(/\n/g, "\\n"));
    event.reply("\n" + reply);
  }
}

/**
 * 向对象发送消息
 * @param {PlatformQQBot} instance QQ机器人实例
 * @param {string} who 目标对象
 * @param {qqBotBackend.Sendable|String} msg 消息内容
 * @returns {Promise<import('../qq-official-bot/lib/index.js').SendResult|null>} 结果（发送失败时 throw）
 * @throws 无法识别参数 / 发送失败
 */
export async function sendMsg(instance, who, msg) {
  if (!(instance instanceof PlatformQQBot)) throw new NeonaicIllegalArgumentError("指定的 Platform 无效");
  if (!instance.bot) throw new NeonaicIllegalArgumentError("QQBot 实例尚未启动");
  who = parseString(who).trim();
  if (who.startsWith('qUSR#')) {
    // 私聊
    return await instance.bot.sendPrivateMessage(who.slice(4).replace(/@.*$/, ''), msg);
  } else if (who.startsWith('qGRP#')) {
    // 群聊
    return await instance.bot.sendGroupMessage(who.slice(4).replace(/@.*$/, ''), msg);
  }
  // 无效用户
  throw new NeonaicIllegalArgumentError("无法识别的用户：" + parseString(who));
}

/**
 * 把平台免费附带的可读名字登记进用户名录（内存态，不写盘）。
 *
 * - **群名**：QQ 群消息自带 `group_name`，每条都有，一定拿得到。
 * - **发送者昵称**：字段存在（`sender.user_name`，源自 `payload.author.username`），
 *   但 QQ 官方接口在群/单聊场景下并不下发 `username`，实际通常为 undefined；
 *   这里顺手登记，将来平台补齐了就自动生效，无需再改代码。
 *
 * 之所以传 `persist: false, overwrite: false`：
 *   不写盘（避免每条消息一次磁盘写入），也不覆盖人工用 `ai whois set` 设置的名字。
 *
 * @param {{ group_name?: string, sender?: { user_name?: string } }} event
 * @param {{ user?: string, group?: string }} targets
 */
function noteKnownNames(event, targets) {
  /** @type {Array<[string, { name: string }]>} */
  const pending = [];
  if (targets.group && event?.group_name) pending.push([targets.group, { name: parseString(event.group_name) }]);
  if (targets.user && event?.sender?.user_name) pending.push([targets.user, { name: parseString(event.sender.user_name) }]);

  for (const [code, info] of pending) {
    try {
      neonaicUserDirectory.set(code, info, { persist: false, overwrite: false });
    } catch (e) {
      getLogger().platP.debug(`[qqbot] 无法把可读名登记进用户名录（${code}）：${e?.message ?? e}`);
    }
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
    try {
      const msgMeta = piece?.data || {};
      switch (parseString(piece?.type).trim().toLowerCase()) {
        case 'text':// 纯文本
          result += msgMeta.text;
          break;
        case 'face':// 表情1
          result += ` :[${fromQQElement(msgMeta, 'face')?.text ?? 'Unknown Emoji'}]: `;
          break;
        case 'emoji':// 表情2
          result += ` :[${fromQQElement(msgMeta, 'emoji')?.text ?? 'Unknown Emoji'}]: `;
          break;
        case 'image':// 图片
          result += ` ![Image:${msgMeta?.name ?? 'Untitled Image'}](${msgMeta?.url ?? '//UnknownUrl'}) `;
          break;
        case 'audio':// 音频
          result += ` <audio controls title="${he.escape(msgMeta?.name ?? 'Untitled Audio')}"><source src="${he.escape(msgMeta?.url ?? '//UnknownUrl')}"></audio> `;
          break;
        case 'video':// 视频
          result += ` <video controls title="${he.escape(msgMeta?.name ?? 'Untitled Video')}"><source src="${he.escape(msgMeta?.url ?? '//UnknownUrl')}"></video> `;
          break;
        case 'link':// 链接
          // Warn: 没有转义
          result += `[${msgMeta?.text ?? msgMeta?.url ?? '//UnknownUrl'}](${msgMeta?.url ?? '//UnknownUrl'} "${msgMeta?.description ?? 'A link'}")`;
          break;

        default:
          //TODO: 还有其他富文本消息类型没有转换
          pp.log('warn', "无法将消息片段", piece, "转换为 Markdown，未知的消息类型：", piece.type);
          break;
      }
    } catch (error) {
      pp.log('warn', "无法将消息片段", piece, "转换为 Markdown，无法获取消息内容：", error);
    }
  });
  return result;
}

export default {
  onPrivateMessageIn,
  onGroupAtMessageIn,
  onGroupMessageIn,
};