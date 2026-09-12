/**
 * QQ 机器人 WebSocket Intents 枚举（按业务分类）。
 *
 * 值均为 qq-official-bot SDK (>=1.2.0) 的 `Intent` 类型联合字符串，
 * 可直接用于 Bot 配置对象的 `intents` 数组。
 *
 * ⚠️ 与旧版（<=1.0.x）不同：旧版 `GROUP_AT_MESSAGE_CREATE` / `C2C_MESSAGE_CREATE`
 *    两个独立 intent 已合并为 `GROUP_AND_C2C_EVENT`（私聊与群聊消息事件）。
 *
 * 分类说明：
 * - message   : 私聊与群聊消息（群@ + 好友私信，已合并）。
 * - group     : 群成员变更。
 * - qchannel  : QQ 频道（Guild / Channel）相关，与「群聊」是不同体系，勿混用。
 * - common    : 通用事件（跨群聊 / 频道 / 私信，不属于上述任一分类）。
 */
export const INTENTS = {
  /** 私聊与群聊消息（群@ 与好友私信已合并） */
  message: {
    /** 私聊与群聊消息事件（含群@消息 + 好友私信） */
    GROUP_AND_C2C_EVENT: 'GROUP_AND_C2C_EVENT',
  },
  /** 群成员变更 */
  group: {
    /** 群成员变更事件 */
    GROUP_MEMBER: 'GROUP_MEMBER',
  },
  /** QQ 频道（Guild / Channel）—— 与「群聊」不同体系，勿混用 */
  qchannel: {
    /** 频道事件（创建 / 加入 / 退出等） */
    GUILDS: 'GUILDS',
    /** 频道成员事件 */
    GUILD_MEMBERS: 'GUILD_MEMBERS',
    /** 频道消息 */
    GUILD_MESSAGES: 'GUILD_MESSAGES',
    /** 频道消息表情回应 */
    GUILD_MESSAGE_REACTIONS: 'GUILD_MESSAGE_REACTIONS',
    /** 频道私信（注意：这是频道私信，非好友私信） */
    DIRECT_MESSAGE: 'DIRECT_MESSAGE',
    /** 论坛事件 */
    FORUMS_EVENT: 'FORUMS_EVENT',
    /** 音频动作 */
    AUDIO_ACTION: 'AUDIO_ACTION',
    /** 公开频道消息 */
    PUBLIC_GUILD_MESSAGES: 'PUBLIC_GUILD_MESSAGES',
  },
  /** 通用事件（跨群聊 / 频道 / 私信，不属于上述任一分类） */
  common: {
    /** 消息审核事件 */
    MESSAGE_AUDIT: 'MESSAGE_AUDIT',
    /** 交互 / 按钮事件 */
    INTERACTION: 'INTERACTION',
  },
};

/**
 * QQ 机器人事件名枚举（供 `bot.on(name, handler)` 使用）。
 *
 * 值均为 qq-official-bot SDK 经 `QQBot.em()` 实际 emit 的**完整事件名**（字符串），
 * 可直接传给 `bot.on()`。
 *
 * 关键机制：`em()` 会按 `.` 层级「逐级 emit」——例如事件名 `message.group`
 * 会同时触发监听器 `bot.on('message')` 与 `bot.on('message.group')`。
 * 因此每个分类下的 `root` 是「全量捕获」名，其余是更精确的名。
 *
 * 分类说明（按 SDK 的 post_type 划分）：
 * - message : 消息类事件（群聊 @消息 / 好友私信 / 频道消息 / 消息审核）
 * - notice  : 通知 / 系统事件类（频道·群·好友成员变更、按钮交互、论坛等）
 * - session : 连接生命周期事件（⚠️ 这些 emit 在 `bot.sessionManager` 上，
 *             不在 `bot` 上，须用 `bot.sessionManager.on(name, ...)` 订阅）
 */
export const EVENTS = {
  /** 消息类事件（post_type = message） */
  message: {
    /** 消息全量捕获：会同时收到群聊/私信/频道消息与消息审核事件 */
    root: 'message',
    /** 群聊消息（⚠️ >=1.2.0 语义变化：这是「群消息」事件，不再是「群@消息」） */
    group: 'message.group',
    /** 群聊 @机器人 消息（>=1.2.0 起「群@消息」由本事件承载） */
    groupAt: 'message.group.at',
    /** 私信前缀（频道私信 + 好友私信） */
    private: 'message.private',
    /** 好友 / 单聊（私聊机器人）消息 */
    friend: 'message.private.friend',
    /** 频道私信 */
    direct: 'message.private.direct',
    /** 频道 @ 消息 / 频道消息 */
    guild: 'message.guild',
    /** 消息审核（通过 / 拒绝）前缀 */
    audit: 'message.audit',
    /** 消息审核通过 */
    auditPass: 'message.audit.pass',
    /** 消息审核拒绝 */
    auditReject: 'message.audit.reject',
  },
  /** 通知 / 系统事件类（post_type = notice） */
  notice: {
    /** 通知全量捕获：会收到所有 notice.* 事件，含按钮交互 */
    root: 'notice',
    // —— 频道（Guild）——
    /** 频道 创建 / 更新 / 解散 前缀 */
    guild: 'notice.guild',
    guildIncrease: 'notice.guild.increase',
    guildUpdate: 'notice.guild.update',
    guildDecrease: 'notice.guild.decrease',
    guildMemberIncrease: 'notice.guild.member.increase',
    guildMemberUpdate: 'notice.guild.member.update',
    guildMemberDecrease: 'notice.guild.member.decrease',
    // —— 子频道（Channel）——
    /** 子频道 创建 / 更新 / 删除 / 进出 前缀 */
    channel: 'notice.channel',
    channelIncrease: 'notice.channel.increase',
    channelUpdate: 'notice.channel.update',
    channelDecrease: 'notice.channel.decrease',
    channelEnter: 'notice.channel.enter',
    channelExit: 'notice.channel.exit',
    // —— 表情表态 ——
    reactionAdd: 'notice.reaction.add',
    reactionRemove: 'notice.reaction.remove',
    // —— 好友（C2C）——
    /** 好友 新增 / 删除 / 接收开关 / 按钮交互 前缀 */
    friend: 'notice.friend',
    friendIncrease: 'notice.friend.increase',
    friendDecrease: 'notice.friend.decrease',
    friendReceiveOpen: 'notice.friend.receive_open',
    friendReceiveClose: 'notice.friend.receive_close',
    /** 好友私聊中点击消息按钮 */
    friendAction: 'notice.friend.action',
    // —— 群（Group）——
    /** 群 加/删机器人 / 接收开关 / 按钮交互 前缀 */
    group: 'notice.group',
    groupIncrease: 'notice.group.increase',
    groupDecrease: 'notice.group.decrease',
    groupReceiveOpen: 'notice.group.receive_open',
    groupReceiveClose: 'notice.group.receive_close',
    /** 群聊中点击消息按钮 */
    groupAction: 'notice.group.action',
    /** 频道中点击消息按钮 */
    guildAction: 'notice.guild.action',
    // —— 论坛（Forum）——
    /** 公开论坛事件聚合前缀 */
    forum: 'notice.forum',
    forumThreadCreate: 'notice.forum.thread.create',
    forumThreadUpdate: 'notice.forum.thread.update',
    forumThreadDelete: 'notice.forum.thread.delete',
    forumPostCreate: 'notice.forum.post.create',
    forumPostDelete: 'notice.forum.post.delete',
    forumReplyCreate: 'notice.forum.reply.create',
    forumReplyDelete: 'notice.forum.reply.delete',
    forumAudit: 'notice.forum.audit',
  },
  /** 连接生命周期事件（⚠️ 在 `bot.sessionManager` 上，不在 `bot` 上） */
  session: {
    /** 已可通信 */
    READY: 'READY',
    /** 会话错误（回调 (code, message)） */
    ERROR: 'ERROR',
    /** WebSocket 关闭 */
    CLOSED: 'CLOSED',
    /** 连接已死亡，请检查网络或重启 */
    DEAD: 'DEAD',
    /** 内部通信事件（payload.eventType 可为 READY / RECONNECT / DISCONNECT） */
    EVENT_WS: 'EVENT_WS',
  },
};