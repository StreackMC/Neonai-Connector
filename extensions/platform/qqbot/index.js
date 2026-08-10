/**
 * platform/qqbot/qqbot.js — QQ 机器人 Platform 实现
 *
 * 通过 registerPlatform(Cls) 注册，PM 用 Profile 名称实例化。
 * 运行时配置通过 PlatformManager.getProfile(this.profile) 获取。
 */

import { PlatformManager, registerPlatform } from '../../../src/platform/platform-manager.js';
import { Platform } from '../../../src/platform/PlatformInterface.js';
import qqBotBackend from 'qq-official-bot';
const { Bot } = qqBotBackend;
import MsgHandler from "./msgHandler.js";
import { EVENTS, INTENTS } from "./enums.js";

export class PlatformQQBot extends Platform {
  static type = 'qqbot';

  constructor(profile) {
    super(profile);
    /** @type {import('qq-official-bot').Bot | null} */
    this._bot = null;
  }

  get bot() { return this._bot; }

  async start() {
    const cfg = PlatformManager.instance.getProfile(this.profile);
    if (!cfg) throw new Error(`Profile "${this.profile}" 配置不存在`);

    this._bot = new Bot({
      appid: cfg.appid ?? '',
      secret: cfg.appsecret ?? '',
      sandbox: cfg.sandbox ?? false,
      removeAt: cfg.removeAt ?? true,
      logLevel: cfg._debug ? 'debug' : 'warn',
      maxRetry: Math.max(cfg.maxRetry ?? 3, 1),
      intents: [
        INTENTS.group.GROUP_AT_MESSAGE_CREATE,
        INTENTS.chat.C2C_MESSAGE_CREATE,
        INTENTS.common.MESSAGE_AUDIT,
        INTENTS.common.INTERACTION,
      ],
    });
    this._bot.on(EVENTS.message.group, (e) => MsgHandler.onGroupMessageIn(e, this));
    this._bot.on(EVENTS.message.private, (e) => MsgHandler.onPrivateMessageIn(e, this));
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

registerPlatform(PlatformQQBot);