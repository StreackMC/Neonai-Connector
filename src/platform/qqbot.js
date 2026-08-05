/**
 * platform/qqbot.js — QQ 频道机器人平台适配器
 *
 * 职责：接收 QQ 频道消息流（IN），调用 Handler 获取回复（OUT），发送回平台。
 *
 * 通过 registerPlatform 向平台管理器注册自身（start / stop 生命周期），
 * 并通过 registerCommand 提供运维命令（status / reconnect）。
 *
 * 注意：qq-official-bot 动态导入（非顶层静态 import），确保其内嵌的 loglevel
 * 在 console 被劫持后才初始化，从而走截断输出。
 */

import { getConfigs } from '../system/conf.js';
import { registerCommand } from '../system/commandServer.js';
import { registerPlatform } from '../system/platform-manager.js';
import { getDebugMode, getLogger } from '../system/logger.js';
import qqBotBackend from 'qq-official-bot';
const { Bot } = qqBotBackend;

/** qq-bot import 惰性加载缓存 @type {null|import('qq-official-bot')} */
let _backend = null;

/** qq-bot 可工作后端 @type {null|import('qq-official-bot').Bot} */
let bot = null;

async function getBackend() {
  if (!_backend) {
    _backend = await import('qq-official-bot');
  }
  return _backend.default;
}

/** 当前生效的配置信息 */
const bot_conf = {
  appid: getConfigs()?.secret?.qqbot?.appid,
  secret: getConfigs()?.secret?.qqbot?.appsecret,
  sandbox: false, // 是否为沙箱环境
  removeAt: true, // 自动移除消息中的 @机器人
  logLevel: getDebugMode() ? 'trace' : 'warn',
  maxRetry: (parseInt(getConfigs()?.secret?.qqbot?.maxRetry) > 0) ? parseInt(getConfigs()?.secret?.qqbot?.maxRetry) : 3,
  intents: [
    'GROUP_MEMBER',
    'GROUP_AND_C2C_EVENT',
    'MESSAGE_AUDIT',
    'INTERACTION',
  ],
};

/** 启动 QQBot 连接（供平台管理器调用） */
async function start() {
  bot = new Bot(bot_conf);
  bot.on('message', async (event) => {
    getLogger().chatIn.info('收到消息:', event.content);

    if (event.content === 'hello') {
      await event.reply('Hello! 我是 QQ 机器人 🤖');
    }
  });
  bot.start();
  return { close: stop };
}

/** 关闭 QQBot 连接 */
function stop() {
  bot.off();
  bot = null;
}

// ---- 向平台管理器注册 ----
registerPlatform('qqbot', { start, stop });

// ---- CLI 运维命令 ----
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