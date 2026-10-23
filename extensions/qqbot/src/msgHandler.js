import qqBotBackend, { segment } from 'qq-official-bot';
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
import { neonaicPermissionServer } from '../../../src/command/permissionServer.js';
import stripAnsi from 'strip-ansi';
import { NeonaicAudioMsgFrag, NeonaicEmojiMsgFrag, NeonaicImageMsgFrag, NeonaicLinkMsgFrag, NeonaicMessage, NeonaicTextMsgFrag, NeonaicVideoMsgFrag } from '../../../src/message/messageFragment.js';

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
  const neonaicmsg = toNeonaicMsg(event.message, pp);
  const ctx = {
    executor: [user],
    privateExecutor: true,
    internalCall: false,
  };
  noteKnownNames(event, { user });

  pp.logMsgIn('Private:', `from=${user} | msg=` + parseString(event.message, false).replace(/\n/g, "\\n"));
  const reply = await neonaicMessageIn.resolveReply(neonaicmsg, {
    AI: profile_config.useAI,
    AIlist: pickAIList(profile_config.aiRouting, profile_config.allowedAI, {
      scene: 'private', profile: pp.profile, user, group: '', executor: [user], text: neonaicmsg.toMarkdown(),
    }),
    resolveCommandWith: ctx,
  });
  if (reply.text) {
    event.reply([
      segment.reply(event.message_id),
      segment.text(reply.text),
    ]).then(() => {
      pp.logMsgOut('Private:', `to=${user} | reply=`, parseString(reply.text, false).replace(/\n/g, "\\n"));
    }).catch((e) => {
      pp.log('error', 'Failed to reply private message:', `to=${user} | error=`, e, ` | reply=`, parseString(reply.text, false).replace(/\n/g, "\\n"));
    });
  }
}

/**
 * 群聊消息
 *
 * ⚠️ 同一条 @ 消息会**两次**进到群聊回调里，但只有一次是有效的：
 *
 *   SDK 的 `em()`（qq-official-bot/lib/client.js）把事件名按 `.` 拆开、逐个前缀 `emit`。
 *   所以一帧 `GROUP_AT_MESSAGE_CREATE` 会依次触发
 *   `message` → `message.group`（本函数）→ `message.group.at`（{@link onGroupAtMessageIn}），
 *   **两次回调拿到的是同一个事件对象**，顺序固定，与监听器注册顺序无关；
 *   而一帧 `GROUP_MESSAGE_CREATE`（已授权「获取全部群消息」）只会触发到 `message.group`。
 *
 *   这正好对应两种授权状态：
 *     - 已授权：只有本函数，`mentions` 完整 → 一切照旧；
 *     - 未授权：本函数先跑，但 `mentions` 是空数组（@ 信息不在 payload 里），
 *       若在此处理，命令会被执行一次、随后 `onGroupAtMessageIn` 再执行一次；
 *       更糟的是若用「先到先得」的锁把后者挡掉，就永远走不到它那条 `cmd + AI` 的完整流程。
 *
 *   判别依据是 `em()` 预先写在事件上的 `sub_type`：来自 `message.group.at` 的帧此处为 `'at'`。
 *   因此 `sub_type === 'at'` 时**直接让出**，由 `onGroupAtMessageIn` 独占处理，
 *   结果与已授权时「一次命令、必要时一次 AI」完全一致。
 *
 * 以上内容由 Agent 总结，这个特性在 SDK 中没有提及。2026-10-22
 *
 * @param {qqBotBackend.GroupMessageEvent} event 
 * @param {PlatformQQBot} pp 
 */
async function onGroupMessageIn(event, pp) {
  // 未授权「获取全部群消息」时的 @ 消息：mentions 为空，交由 onGroupAtMessageIn 统一处理
  if (event?.sub_type === 'at') return;

  /** 实例的 Profile 配置 */
  const profile_config = neonaicPlatformManager.getPlatformManager().getProfile(pp.profile);
  const user = `qUSR#${event.user_id}@${pp.selfInfo.id}`;
  const group = `qGRP#${event.group_id}@${pp.selfInfo.id}`;
  const neonaicmsg = toNeonaicMsg(event.message, pp);
  const markdown = neonaicmsg.toMarkdown();
  const ctx = {
    executor: [user, group],
    privateExecutor: false,
    internalCall: false,
  };
  /** @type {object[]} 在 qq-official-bot 修复 #123 之前，此处没有类型声明 */
  const mentioned = Array.isArray(event.mentions) ? event.mentions : [];
  noteKnownNames(event, { user, group });
  pp.logMsgIn('Group:', `where=${group} | from=${user} | msg=` + parseString(event.message, false).replace(/\n/g, "\\n"));

  // 处理 @ 机器人的情形以及提到澪奈的情形，也就是主动式回复
  if (Array.isArray(mentioned) && mentioned.length > 0 && mentioned.some((u) => !!u.is_you)) {
    const reply = await neonaicMessageIn.resolveReply(neonaicmsg, {
      AI: profile_config.useAI,
      AIlist: pickAIList(profile_config.aiRouting, profile_config.allowedAI, {
        scene: 'group', profile: pp.profile, user, group, executor: [user, group], text: markdown,
      }),
      resolveCommandWith: ctx,
    });
    if (reply.text) {
      event.reply([
        segment.reply(event.message_id),
        segment.text(reply.text),
      ]).then(() => {
        pp.logMsgOut('GroupAt:', `where=${group} | to=${user} | reply=`, parseString(reply.text, false).replace(/\n/g, "\\n"));
      }).catch((e) => {
        pp.log('error', 'Failed to reply group message:', `where=${group} | to=${user} | error=`, e, ` | reply=`, parseString(reply.text, false).replace(/\n/g, "\\n"));
      });
    }
    return;
  }

  // 处理没有 @ 机器人的情形，先检查命令
  if (/* 不能 @ 人 */mentioned.length === /* @本机器人 已经在上文处理了，所以可以直接判空 */0) {
    const prefixes = neonaicConfManager.getConfig(neonaicConfManager.CONFIG_PATHS.main).getList('prefix');
    const parsed = neonaicCommandServer.resolveCommandArgs(markdown, prefixes, true);
    const [cmdName, cmdArgs] = parsed || ["", []];
    const cmd = neonaicCommandServer.resolveCommand(cmdName);
    if (
      /* 有这个命令 */cmd
      && /* 有这个权限 */neonaicPermissionServer.checkPermissionFromContext(ctx, cmd.permissions, cmd.permissionDefault)
    ) {
      try {
        const quickCommandResult = stripAnsi(await neonaicCommandServer.executeCommandSilent(cmdName, ctx, ...cmdArgs));
        event.reply([
          segment.reply(event.message_id),
          segment.text(parseString(quickCommandResult)),
        ]).then(() => {
          pp.logMsgOut('GroupAt:', `where=${group} | to=${user} | reply=`, parseString(quickCommandResult).replace(/\n/g, "\\n"));
        }).catch((e) => {
          pp.log('error', 'Failed to reply group message:', `where=${group} | to=${user} | error=`, e, ` | reply=`, parseString(quickCommandResult).replace(/\n/g, "\\n"));
        });
      } catch (error_in_executing_cmd) {
        event.reply([
          segment.reply(event.message_id),
          segment.text(neonaicMessageIn.REPLY_FALLBACK.CMD_FAILED(error_in_executing_cmd, cmdName)),
        ]).then(() => {
          pp.log('warn', 'Failed to reply group message:', `where=${group} | to=${user} | error=`, error_in_executing_cmd, ` | reply=<null>Executing Command</null>`);
        }).catch((error_in_sending_cmd_err) => {
          pp.log('error', 'Failed to reply group message:', `where=${group} | to=${user} | error=`, error_in_sending_cmd_err, ` | reply=<null>Executing Command</null>`);
        });
      } finally {
        return;
      }
    }
  }

  // 再使用被动回复
  neonaicEventBus.dispatchEvent(new NeonaicMessageEvent(pp, [user, group], neonaicmsg, async (msg) => {
    event.reply([
      segment.reply(event.message_id),
      segment.text(msg),
    ]).then(() => {
      pp.logMsgOut('Group:', `where=${group} | to=${user} | reply=`, parseString(msg, false).replace(/\n/g, "\\n"));
    }).catch((e) => {
      pp.log('error', 'Failed to send message to group:', `where=${group} | to=${user} | error=`, e, ` | reply=`, parseString(msg, false).replace(/\n/g, "\\n"));
    });
  }));
}

/**
 * 群聊 @ 消息
 *
 * 只有**未授权**「获取全部群消息」时才会走到这里（已授权时 QQ 只推 `GROUP_MESSAGE_CREATE`）。
 * 本函数是这类消息的**唯一**处理者：`onGroupMessageIn` 见到 `sub_type === 'at'` 会直接让出，
 * 所以命令与 AI 都只跑一次。
 *
 * @param {qqBotBackend.GroupMessageEvent} event 
 * @param {PlatformQQBot} pp 
 */
async function onGroupAtMessageIn(event, pp) {
  /** 实例的 Profile 配置 */
  const profile_config = neonaicPlatformManager.getPlatformManager().getProfile(pp.profile);
  const user = `qUSR#${event.user_id}@${pp.selfInfo.id}`;
  const group = `qGRP#${event.group_id}@${pp.selfInfo.id}`;
  const neonaicmsg = toNeonaicMsg(event.message, pp);
  const ctx = {
    executor: [user, group],
    privateExecutor: false,
    internalCall: false,
  };
  /** @type {object[]} 在 qq-official-bot 修复 #123 之前，此处没有类型声明 */
  const mentioned = Array.isArray(event.mentions) ? event.mentions : [];
  noteKnownNames(event, { user, group });
  pp.logMsgIn('GroupAt:', `where=${group} | from=${user} | msg=` + parseString(event.message, false).replace(/\n/g, "\\n"));

  const reply = await neonaicMessageIn.resolveReply(neonaicmsg, {
    AI: profile_config.useAI,
    AIlist: pickAIList(profile_config.aiRouting, profile_config.allowedAI, {
      scene: 'group', profile: pp.profile, user, group, executor: [user, group], text: neonaicmsg.toMarkdown(),
    }),
    resolveCommandWith: ctx,
  });
  if (reply.text) {
    event.reply([
      segment.reply(event.message_id),
      segment.text(reply.text),
    ]).then(() => {
      pp.logMsgOut('GroupAt:', `where=${group} | to=${user} | reply=`, parseString(reply.text, false).replace(/\n/g, "\\n"));
    }).catch((e) => {
      pp.log('error', 'Failed to reply group at-message:', `where=${group} | to=${user} | error=`, e, ` | reply=`, parseString(reply.text, false).replace(/\n/g, "\\n"));
    });
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
  if (!(instance instanceof PlatformQQBot)) throw new NeonaicIllegalArgumentError("指定的 Platform 无效");
  if (!instance.bot) throw new NeonaicIllegalArgumentError("QQBot 实例尚未启动");
  who = parseString(who).trim();
  if (who.startsWith('qUSR#')) {
    // 私聊
    return await instance.bot.sendPrivateMessage(who.slice(5).replace(/@.*$/, ''), msg);
  } else if (who.startsWith('qGRP#')) {
    // 群聊
    return await instance.bot.sendGroupMessage(who.slice(5).replace(/@.*$/, ''), msg);
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
 * @param {boolean} [textOnly=false] 开启后将只处理可用文本表达的消息片段，其余部分自动忽略，这将替换图片视频等内容为无意义占位符而非链接、Base64 等带内容的 Payload
 * @returns {NeonaicMessage}
 */
function toNeonaicMsg(raw, pp, textOnly = false) {
  let result = new NeonaicMessage();
  raw.forEach((piece) => {
    try {
      const msgMeta = piece?.data || {};
      switch (parseString(piece?.type).trim().toLowerCase()) {
        case 'text':// 纯文本
          result.appendFragment(new NeonaicTextMsgFrag(msgMeta?.text ?? ''));
          break;
        case 'face':// 表情1
          result.appendFragment(new NeonaicEmojiMsgFrag(`:${fromQQElement(msgMeta, 'face')?.text ?? 'Unknown Emoji'}:`));
          break;
        case 'emoji':// 表情2
          result.appendFragment(new NeonaicEmojiMsgFrag(`:${fromQQElement(msgMeta, 'emoji')?.text ?? 'Unknown Emoji'}:`));
          break;
        case 'image':// 图片
          result.appendFragment(new NeonaicImageMsgFrag(msgMeta?.url ?? 'about:unknown', msgMeta?.name ?? 'Untitled Image'));
          break;
        case 'audio':// 音频
          result.appendFragment(new NeonaicAudioMsgFrag(textOnly ? 'about:nosource' :msgMeta?.url ?? 'about:unknown', msgMeta?.name ?? 'Untitled Audio'));
          break;
        case 'video':// 视频
          result.appendFragment(new NeonaicVideoMsgFrag(textOnly ? 'about:nosource' : msgMeta?.url ?? 'about:unknown', msgMeta?.name ?? 'Untitled Video'));
          break;
        case 'link':// 链接
          result.appendFragment(new NeonaicLinkMsgFrag(msgMeta?.url ?? 'about:unknown', msgMeta?.text ?? msgMeta?.url ?? 'Untitled Link', msgMeta?.description ?? 'A link'));
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