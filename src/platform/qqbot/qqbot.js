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
import { Platform } from '../Platform.js';
import qqBotBackend from 'qq-official-bot';
const { Bot } = qqBotBackend;
import GroupHandler from "./groupHandler.js";
import PrivateHandler from "./privateHandler.js";
import { EVENTS, INTENTS } from "./enums.js";

/** 当前生效的配置信息 */
const bot_conf = {
  appid: getConfigs()?.secret?.qqbot?.appid,
  secret: getConfigs()?.secret?.qqbot?.appsecret,
  sandbox: false,
  removeAt: true,
  logLevel: getDebugMode() ? 'debug' : 'fatal',
  maxRetry: (parseInt(getConfigs()?.secret?.qqbot?.maxRetry) > 0) ? parseInt(getConfigs()?.secret?.qqbot?.maxRetry) : 3,
  intents: [
    INTENTS.group.GROUP_AT_MESSAGE_CREATE,
    INTENTS.chat.C2C_MESSAGE_CREATE,
    INTENTS.common.MESSAGE_AUDIT,
    INTENTS.common.INTERACTION,
  ],
};

class PlatformQQBot extends Platform {
  constructor() {
    super('qqbot');
    /** @type {import('qq-official-bot').Bot | null} */
    this._bot = null;
  }

  /** 获取当前 Bot 实例 */
  get bot() { return this._bot; }

  async start() {
    this._bot = new Bot(bot_conf);
    this._bot.on(EVENTS.message.group, GroupHandler.onMessageIn);
    this._bot.on(EVENTS.message.private, PrivateHandler.onMessageIn);
    await this._bot.start();
    return { close: () => this.stop() };
  }

  async stop() {
    if (this._bot) {
      this._bot.stop();
      this._bot = null;
    }
  }
}

const instance = new PlatformQQBot();
registerPlatform(instance);

/** 获取 QQBot 平台实例 */
export function getQQBot() { return instance; }

// ---- CLI 运维命令 ----

registerCommand('qqbot', async (args) => {
  const sub = args[0];
  if (!sub) {
    getLogger().platQ.info('用法: qqbot status | qqbot reconnect');
    return;
  }

  if (sub === 'status') {
    const connected = !!instance.bot;
    getLogger().platQ.info(`QQBot 状态: ${connected ? '\x1b[32m已连接\x1b[0m' : '\x1b[33m未连接\x1b[0m'}`);
  } else if (sub === 'reconnect') {
    await instance.stop();
    await instance.start();
    getLogger().platQ.info('QQBot 已重新连接');
  } else {
    getLogger().platQ.warn(`未知子命令: ${sub}，可用: status | reconnect`);
  }
}, { description: 'QQBot 运维操作', usage: 'qqbot status | qqbot reconnect' });

