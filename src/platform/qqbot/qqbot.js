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

import { getConfigs } from '../../system/conf.js';
import { registerCommand } from '../../system/commandServer.js';
import { registerPlatform } from '../../system/platform-manager.js';
import { getDebugMode, getLogger } from '../../system/logger.js';
import qqBotBackend from 'qq-official-bot';
const { Bot } = qqBotBackend;
import GroupHandler from "./groupHandler.js";
import PrivateHandler from "./privateHandler.js";
import { EVENTS, INTENTS } from "./enums.js";

/** 当前运行的 Bot 实例，未连接时为 null */
let bot = null;
export function getBot() { return bot; }

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

// ---- 与 backend 交互 ----

/** 启动 QQBot 连接（供平台管理器调用） */
async function start() {
  bot = new Bot(bot_conf);
  bot.on(EVENTS.message.group, GroupHandler.onMessageIn);
  bot.on(EVENTS.message.private, PrivateHandler.onMessageIn);
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

// ---- 与 system 交互 ----

registerPlatform('qqbot', { start, stop });
registerCommand('qqbot', async (args) => {
  const sub = args[0];
  if (!sub) {
    getLogger().platQ.info('用法: qqbot status | qqbot reconnect');
    return;
  }

  if (sub === 'status') {
    const connected = !!bot;
    getLogger().platQ.info(`QQBot 状态: ${connected ? '\x1b[32m已连接\x1b[0m' : '\x1b[33m未连接\x1b[0m'}`);
  } else if (sub === 'reconnect') {
    stop();
    await start();
    getLogger().platQ.info('QQBot 已重新连接');
  } else {
    getLogger().platQ.warn(`未知子命令: ${sub}，可用: status | reconnect`);
  }
}, { description: 'QQBot 运维操作', usage: 'qqbot status | qqbot reconnect' });

// ---- 消息处理 ----

