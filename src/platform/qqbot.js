/**
 * platform/qqbot.js — QQ 机器人平台适配器
 *
 * 职责：接收 QQ 消息流（IN），调用 Handler 获取回复（OUT），发送回平台。
 *
 * 通过 registerPlatform 向平台管理器注册自身（start / stop 生命周期），
 * 并通过 registerCommand 提供运维命令（status / reconnect）。
 *
 * 注意：qq-official-bot 在顶层静态 import，依赖 entry.js 先劫持 console，
 * 使其内嵌的 log4js 走统一截断输出。
 */

import { getConfigs } from '../system/conf.js';
import { registerCommand } from '../system/commandServer.js';
import { registerPlatform } from '../system/platform-manager.js';
import { getDebugMode, getLogger } from '../system/logger.js';
import qqBotBackend from 'qq-official-bot';
const { Bot } = qqBotBackend;

/**
 * QQ 机器人 WebSocket Intents 枚举（按业务分类）。
 *
 * 值均为 qq-official-bot SDK 的 `Intends` 枚举键名（字符串），
 * 可直接用于 Bot 配置对象的 `intents` 数组。
 *
 * 分类说明：
 * - group    : 群聊（Group）相关。SDK 仅暴露「@机器人」消息一类，
 *              不存在「全部群消息」intent（QQ 仅向机器人推送 @消息）。
 * - chat     : 好友 / 单聊私信（C2C）相关。
 * - qchannel : QQ 频道（Guild / Channel）相关，与「群聊」是不同体系，勿混用。
 * - common   : 通用事件（跨群聊 / 频道 / 私信，不属于上述任一分类）。
 */
const INTENTS = {
  /** 群聊（Group） */
  group: {
    /** 群聊中 @机器人 的消息（QQ 仅向机器人推送 @消息，无「全部群消息」intent） */
    GROUP_AT_MESSAGE_CREATE: 'GROUP_AT_MESSAGE_CREATE',
  },
  /** 好友 / 单聊私信（C2C） */
  chat: {
    /** 好友 / 单聊（私聊机器人）消息 */
    C2C_MESSAGE_CREATE: 'C2C_MESSAGE_CREATE',
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
    /** 公开论坛事件 */
    OPEN_FORUMS_EVENTS: 'OPEN_FORUMS_EVENTS',
    /** 音频 / 直播频道成员 */
    AUDIO_OR_LIVE_CHANNEL_MEMBERS: 'AUDIO_OR_LIVE_CHANNEL_MEMBERS',
    /** 论坛事件 */
    FORUMS_EVENTS: 'FORUMS_EVENTS',
    /** 音频动作 */
    AUDIO_ACTIONS: 'AUDIO_ACTIONS',
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

/** 当前运行的 Bot 实例，未连接时为 null */
let bot = null;

/** 当前生效的配置信息 */
const bot_conf = {
  appid: getConfigs()?.secret?.qqbot?.appid,
  secret: getConfigs()?.secret?.qqbot?.appsecret,
  sandbox: false, // 是否为沙箱环境
  removeAt: true, // 自动移除消息中的 @机器人
  logLevel: getDebugMode() ? 'debug' : 'fatal',
  maxRetry: (parseInt(getConfigs()?.secret?.qqbot?.maxRetry) > 0) ? parseInt(getConfigs()?.secret?.qqbot?.maxRetry) : 3,
  intents: [
    // —— 群聊全部 intents ——
    INTENTS.group.GROUP_AT_MESSAGE_CREATE,
    // —— 好友列表私信（单聊/C2C）全部 intents ——
    INTENTS.chat.C2C_MESSAGE_CREATE,
    // —— 通用辅助 intents ——
    INTENTS.common.MESSAGE_AUDIT,  // 消息审核事件
    INTENTS.common.INTERACTION,    // 交互 / 按钮事件
  ],
};

/** 启动 QQBot 连接（供平台管理器调用） */
async function start() {
  bot = new Bot(bot_conf);
  bot.on('message', async (event) => {
    getLogger().chatIn.info('收到消息:', event.content);

    if (event.content === 'hello') {
      await event.reply('World!');
    }
  });
  await bot.start();
  return { close: stop };
}

/** 关闭 QQBot 连接 */
function stop() {
  if (bot) {
    bot.stop();
    bot = null;
  }
}

// ---- 向平台管理器注册 ----
registerPlatform('qqbot', { start, stop });

// ---- CLI 运维命令 ----
registerCommand('qqbot', async (args) => {
  const sub = args[0];
  if (!sub) {
    getLogger().platP.info('用法: qqbot status | qqbot reconnect');
    return;
  }

  if (sub === 'status') {
    const connected = !!bot;
    getLogger().platP.info(`QQBot 状态: ${connected ? '\x1b[32m已连接\x1b[0m' : '\x1b[33m未连接\x1b[0m'}`);
  } else if (sub === 'reconnect') {
    stop();
    await start();
    getLogger().platP.info('QQBot 已重新连接');
  } else {
    getLogger().platP.warn(`未知子命令: ${sub}，可用: status | reconnect`);
  }
}, { description: 'QQBot 运维操作', usage: 'qqbot status | qqbot reconnect' });