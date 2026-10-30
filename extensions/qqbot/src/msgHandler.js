import { neonaicCommandServer } from '#src/command/commandServer.js';
import { neonaicPermissionServer } from '#src/command/permissionServer.js';
import { neonaicEventBus } from '#src/event/neonaicEventBus.js';
import { NeonaicMessageEvent } from '#src/event/neonaicEventInterface.js';
import { getLogger } from '#src/logger/Logger.js';
import { NeonaicMessage } from '#src/message/messageFragment.js';
import { neonaicMessageIn } from '#src/message/messageIn.js';
import { neonaicUserDirectory } from '#src/message/userDirectory.js';
import { neonaicPlatformManager } from '#src/platform/platformManager.js';
import { neonaicConfManager } from '#src/system/confManager.js';
import { parseString } from '#src/utils/chore.js';
import { NeonaicIllegalArgumentError } from '#src/utils/NeonaicNewableError.js';
import qqBotBackend, { segment } from 'qq-official-bot';
import stripAnsi from 'strip-ansi';
import { pickAIList } from './aiRoute.js';
import { PlatformQQBot } from './entry.js';
import { convert_qqBotMsg_to_NeonaicMsg as toNeonaicMsg, convert_NeonaicMsg_to_qqBotMsg as toQbSendable } from './msgPayloadConvertor.js';

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
  const neonaicmsg = toNeonaicMsg(event, pp);
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
      segment.markdown(reply.text),
    ]).then(() => {
      pp.logMsgOut('Private:', `to=${user} | reply=`, parseString(reply.text, false).replace(/\n/g, "\\n"));
    }).catch((e) => {
      pp.log('error', 'Failed to reply private message:', `to=${user} | error=`, e, ` | reply=`, parseString(reply.text, false).replace(/\n/g, "\\n"));
    });
  }
}

/**
 * 已被 `message.group.at` 回调认领的事件。
 *
 * 同一帧 @ 消息会被 `em()` 依次 emit 给 `message.group` 与 `message.group.at`，
 * 两次拿到的是**同一个对象**。`em()` 的循环是同步的，所以 `onGroupMessageIn` 先让出
 * 一个微任务，等这里同步认领后再决定是否处理。
 * @type {WeakSet<object>}
 */
const claimedByGroupAt = new WeakSet();

/**
 * 同一条 @ 消息会**两次**进到群聊回调里，但只能处理一次。
 *
 * SDK 的 `em()`（qq-official-bot/lib/client.js）把事件名按 `.` 拆开、逐个前缀 `emit`：
 * 一帧 `GROUP_AT_MESSAGE_CREATE` 会依次触发
 * `message` → `message.group`（{@link onGroupMessageIn}）→ `message.group.at`（{@link onGroupAtMessageIn}），
 * **两次回调拿到的是同一个事件对象**，顺序固定，与监听器注册顺序无关；
 * 而一帧 `GROUP_MESSAGE_CREATE`（已授权「获取全部群消息」）只会触发到 `message.group`。
 *
 * ⚠️ **不能用 `event.sub_type` 判别**：`Message` 基类构造时把它固定成 `'normal'`，
 *    而 `em()` 写入的 `sub_type: 'at'` 会被同一句 `Object.assign` 末尾的 `...payload`
 *    用事件对象自己的 `sub_type` 覆盖回去。类型声明也写明它只能是
 *    `'direct' | 'friend' | 'temp' | 'normal'`。所以在生产环境里 `sub_type` 永远是 `'normal'`。
 *
 * 判别交给 {@link claimedByGroupAt}：`em()` 的 emit 循环是**同步**的，所以本函数先让出
 * 一个微任务；若随后确有 `.at` 回调，它会在第一个 `await` 之前同步认领该事件，
 * 本函数醒来后直接退出。没有 `.at` 回调（已授权场景）时则照常处理。
 *
 * 两种授权状态因此都只处理一次：
 *   - 已授权：只有本函数，`mentions` 完整 → @ 与普通消息都走这里；
 *   - 未授权：本函数让出，由 `onGroupAtMessageIn` 独占 `cmd + AI` 的完整流程。
 *
 * @param {qqBotBackend.GroupMessageEvent} event 
 * @param {PlatformQQBot} pp 
 */
async function onGroupMessageIn(event, pp) {
  // 让出一个微任务，等同一 tick 内随后触发的 message.group.at 认领（见函数注释）
  await Promise.resolve();
  if (claimedByGroupAt.has(event)) return;

  /** 实例的 Profile 配置 */
  const profile_config = neonaicPlatformManager.getPlatformManager().getProfile(pp.profile);
  const user = `qUSR#${event.user_id}@${pp.selfInfo.id}`;
  const group = `qGRP#${event.group_id}@${pp.selfInfo.id}`;
  const neonaicmsg = toNeonaicMsg(event, pp);
  const markdown = neonaicmsg.toMarkdown();
  const ctx = {
    executor: [user, group],
    privateExecutor: false,
    internalCall: false,
  };
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
        segment.markdown(reply.text),
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
          segment.markdown(parseString(quickCommandResult)),
        ]).then(() => {
          pp.logMsgOut('GroupAt:', `where=${group} | to=${user} | reply=`, parseString(quickCommandResult).replace(/\n/g, "\\n"));
        }).catch((e) => {
          pp.log('error', 'Failed to reply group message:', `where=${group} | to=${user} | error=`, e, ` | reply=`, parseString(quickCommandResult).replace(/\n/g, "\\n"));
        });
      } catch (error_in_executing_cmd) {
        event.reply([
          segment.reply(event.message_id),
          segment.markdown(neonaicMessageIn.REPLY_FALLBACK.CMD_FAILED(error_in_executing_cmd, cmdName)),
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
      segment.markdown(msg),
    ]).then(() => {
      pp.logMsgOut('Group:', `where=${group} | to=${user} | reply=`, parseString(msg, false).replace(/\n/g, "\\n"));
    }).catch((e) => {
      pp.log('error', 'Failed to send message to group:', `where=${group} | to=${user} | error=`, e, ` | reply=`, parseString(msg, false).replace(/\n/g, "\\n"));
    });
  }, {
    cancelable: false,
  }));
}

/**
 * 群聊 @ 消息
 *
 * 只有**未授权**「获取全部群消息」时才会走到这里（已授权时 QQ 只推 `GROUP_MESSAGE_CREATE`）。
 * 本函数是这类消息的**唯一**处理者：先同步认领事件，`onGroupMessageIn` 的微任务醒来后
 * 见到认领标记就直接退出，所以命令与 AI 都只跑一次。
 *
 * ⚠️ 认领必须放在**第一个 `await` 之前**。`em()` 先 emit `message.group`，本函数后跑；
 *    若认领被推迟到微任务里，`onGroupMessageIn` 会先醒来并处理，重复执行的问题就会回来。
 *
 * @param {qqBotBackend.GroupMessageEvent} event 
 * @param {PlatformQQBot} pp 
 */
async function onGroupAtMessageIn(event, pp) {
  claimedByGroupAt.add(event);
  /** 实例的 Profile 配置 */
  const profile_config = neonaicPlatformManager.getPlatformManager().getProfile(pp.profile);
  const user = `qUSR#${event.user_id}@${pp.selfInfo.id}`;
  const group = `qGRP#${event.group_id}@${pp.selfInfo.id}`;
  const neonaicmsg = toNeonaicMsg(event, pp);
  const ctx = {
    executor: [user, group],
    privateExecutor: false,
    internalCall: false,
  };
  /** 注意没授权时无论 @ 谁这里也没有内容 */
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
      segment.markdown(reply.text),
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
 * @param {string} who 目标对象，**尾随 @ 与否不影响执行，也不影响实际使用的实例**
 * @param {qqBotBackend.Sendable|NeonaicMessage} msg 消息内容
 * @returns {Promise<import('qq-official-bot').SendResult|null>} 结果（发送失败时 throw）
 * @throws 无法识别参数 / 发送失败
 */
export async function sendMsg(instance, who, msg) {
  // 检查实例状态
  if (!(instance instanceof PlatformQQBot)) throw new NeonaicIllegalArgumentError("指定的 Platform 无效");
  if (!instance.bot) throw new NeonaicIllegalArgumentError("QQBot 实例尚未启动");

  // 格式化参数
  who = parseString(who).trim().replace(/@.*$/, '');
  if (msg instanceof NeonaicMessage) {
    msg = new NeonaicMessage(msg); // 复制一份，避免原对象被修改
    if (who.startsWith('qUSR#')/* 私聊场景下 @ 无效 */) msg.fragments.filter(frag => frag.type !== 'at');
    msg = toQbSendable(msg);
  }

  // 分类型发送
  if (who.startsWith('qUSR#')) {
    // 私聊
    return await instance.bot.sendPrivateMessage(who.slice(5), msg);
  } else if (who.startsWith('qGRP#')) {
    // 群聊
    return await instance.bot.sendGroupMessage(who.slice(5), msg);
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

export default {
  onPrivateMessageIn,
  onGroupAtMessageIn,
  onGroupMessageIn,
};