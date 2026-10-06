/**
 * platform/qqbot/index.js — QQ 机器人 Platform 实现
 *
 * 通过 registerPlatform(Cls) 注册，PM 用 Profile 名称实例化。
 * 运行时配置通过 PlatformManager.getProfile(this.profile) 获取。
 */

import { neonaicPlatformManager, PlatformManager } from '../../../src/platform/platformManager.js';
import { NeonaiPlatform } from '../../../src/platform/platformInterface.js';
import qqBotBackend from 'qq-official-bot';
const { Bot, ReceiverMode } = qqBotBackend;
import MsgHandler, { sendMsg } from "./msgHandler.js";
import { EVENTS, INTENTS } from "./enums.js";
import { NeonaicIllegalArgumentError } from '../../../src/utils/NeonaicNewableError.js';
import { getLogger } from '../../../src/logger/Logger.js';
import { parseString } from '../../../src/utils/chore.js';
import { neonaicConfManager } from '../../../src/system/confManager.js';

export class PlatformQQBot extends NeonaiPlatform {
  static type = 'qqbot';
  #botInstance = null;

  constructor(profile) {
    super(profile);
    /** @type {import('qq-official-bot').Bot | null} */
  }

  /** 获取机器人对象，不支持 setter @return {qqBotBackend.Bot|null} */
  get bot() { return this.#botInstance; }

  async start() {
    const cfg = PlatformManager.instance.getProfile(this.profile);
    if (!cfg) throw new NeonaicIllegalArgumentError(`Profile "${this.profile}" 配置不存在`);

    this.#botInstance = new Bot({
      appid: cfg.appid ?? '',
      secret: cfg.appsecret ?? '',
      sandbox: cfg.sandbox ?? false,
      removeAt: cfg.removeAt ?? true,
      logLevel: cfg._debug ? 'debug' : 'warn',
      maxRetry: Math.max(cfg.maxRetry ?? 3, 1),
      intents: [
        INTENTS.message.GROUP_AND_C2C_EVENT,
        INTENTS.common.MESSAGE_AUDIT,
        INTENTS.common.INTERACTION,
      ],
      mode: ReceiverMode.WEBSOCKET,
    });
    this.#botInstance.on(EVENTS.message.groupAt, (e) => MsgHandler.onGroupMessageIn(e, this));
    this.#botInstance.on(EVENTS.message.private, (e) => MsgHandler.onPrivateMessageIn(e, this));
    await this.#botInstance.start();

    // 启动主动式看门狗
    this.#watchdog = setInterval(() => this.onWatchdogTick(), 60/* 秒探测一次 */ * 1000);

    return { close: () => this.stop() };
  }

  async stop() {
    if (this.#botInstance) {
      this.#botInstance.stop();
      this.#botInstance = null;
    }
    clearInterval(this.#watchdog);
  }

  #watchdog = -1;
  /** 主动式看门狗，qqbot框架没有喂狗接口 */
  onWatchdogTick() {
    if (!this.bot) return;
    this.bot.getSelfInfo().catch((err) => {
      getLogger().platP.warn(`QQBot[${this.profile}]: 看门狗反馈异常，尝试重启机器人。`, err);
      this.stop().then(() => setTimeout(() => this.start(), 1000)).catch((err) => {
        getLogger().platP.error(`QQBot[${this.profile}]: 看门狗重启失败，请检查配置。`, err);
      }
      );
    });
  }

  async sendMsg(who, ...msg) {
    // 发送消息
    const messageContent = msg.map(v => parseString(v, false)).join('');
    try {
      const result = await sendMsg(this, who, messageContent);
      getLogger().platP.debug(`[qqbot] 向`, who, `@`, this.profile, `发送消息`, msg, `：`, result);
      this.logMsgOut('Command:', `to=${who} | msg=`, messageContent.replace(/\n/g, "\\n"));
      // SendResult 可能为「消息审核中」状态
      if (result?.audit_status === 'pending') {
        return `“${neonaicConfManager.getBotName()}”已向[${who}]发送消息，但消息正在审核中。`;
      }
      return `“${neonaicConfManager.getBotName()}”成功向[${who}]发送指定消息。`;
    } catch (err) {
      getLogger().platP.debug(`[qqbot] 向`, who, `@`, this.profile, `发送消息失败：`, err.message);
      return `“${neonaicConfManager.getBotName()}”无法向[${who}]发送指定消息，因为“${err.message}”。`;
    }
  }
}

neonaicPlatformManager.registerPlatform(PlatformQQBot);

// ---- 拓展生命周期钩子 ----

/**
 * 拓展启用钩子。
 *
 * QQBot 的平台类已在模块顶层完成注册，实际连接由 `PlatformManager.loadEnabled()`
 * 按 Profile 驱动，因此这里没有需要额外做的事；保留空实现以满足拓展加载器的
 * 入口函数契约（`onEnable` / `onDisable` 必须同时存在且为函数）。
 *
 * @this {import('../../../src/extension/extLoader.js').NeonaicExtItem}
 * @param {{ manifest: Object, pwd: String, ext_item_id: String, ext_item_timestamp: Number }} [ctx] 拓展上下文
 */
export function onEnable(ctx) {
}

/**
 * 拓展卸载钩子。
 *
 * 同 {@link onEnable}：平台实例的启停由 PlatformManager 负责，这里保持空实现。
 *
 * @this {import('../../../src/extension/extLoader.js').NeonaicExtItem}
 */
export function onDisable() {
}
