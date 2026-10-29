/**
 * platform/qqbot/index.js — QQ 机器人 Platform 实现
 *
 * 通过 registerPlatform(Cls) 注册，PM 用 Profile 名称实例化。
 * 运行时配置通过 PlatformManager.getProfile(this.profile) 获取。
 */

import { getLogger } from '#/logger/Logger.js';
import { NeonaiPlatform } from '#/platform/platformInterface.js';
import { neonaicPlatformManager, PlatformManager } from '#/platform/platformManager.js';
import { neonaicConfManager } from '#/system/confManager.js';
import { parseString } from '#/utils/chore.js';
import { NeonaicError, NeonaicIllegalArgumentError, NeonaicIOError } from '#/utils/NeonaicNewableError.js';
import qqBotBackend from 'qq-official-bot';
import { EVENTS, INTENTS } from "./enums.js";
import MsgHandler, { sendMsg } from "./msgHandler.js";
const { Bot, ReceiverMode } = qqBotBackend;

export class PlatformQQBot extends NeonaiPlatform {
  static type = 'qqbot';
  /** @type {qqBotBackend.Bot|null} */
  #botInstance = null;
  #selfInfo = null;

  constructor(profile) {
    super(profile);
    /** @type {import('qq-official-bot').Bot | null} */
  }

  /** 获取机器人对象，不支持 setter @return {qqBotBackend.Bot|null} */
  get bot() { return this.#botInstance; }

  /** 获取机器人信息，不支持 setter @return {qqBotBackend.Bot.Info|null} */
  get selfInfo() { return this.#selfInfo; }

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
    if (this.bot === null) throw new NeonaicIOError(`无法创建 QQBot 实例，请检查配置`, this);

    // 注册消息事件
    // 注意：message.group 与 message.group.at 谁先跑由 SDK 的 em() 决定（按事件名前缀逐个
    // emit，恒为 message → message.group → message.group.at），与这里注册的先后无关；
    // 两者的分工见 msgHandler.js 中 onGroupMessageIn 的注释。
    this.bot.on(EVENTS.message.group, (e) => MsgHandler.onGroupMessageIn(e, this));
    this.bot.on(EVENTS.message.groupAt, (e) => MsgHandler.onGroupAtMessageIn(e, this));
    this.bot.on(EVENTS.message.private, (e) => MsgHandler.onPrivateMessageIn(e, this));
    await this.bot.start();

    // 获取机器人自身信息
    this.#selfInfo = await this.bot.getSelfInfo();

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

  async restart() {
    // 停止是可以强制停止的（无引用导致实例被回收）
    await this.stop().catch();
    // 启动需要考虑指数退让
    try {
      let cooldown = 1000;
      let i = 0;
      while (true) {
        i++;
        await new Promise(resolve => setTimeout(resolve, cooldown * 2 ** (i - 1)));
        try {
          await this.start();
          break;
        } catch (err) {
          getLogger().platP.error(`QQBot[${this.profile}]: 重启失败，${cooldown}毫秒后重试：`, err);
        }

        // 如果连续失败次数过多，抛出异常
        if (i >= 9) {
          throw new NeonaicError(`QQBot[${this.profile}]: 重启失败次数过多，已放弃重试。`, this);
        }
      }
    } catch (err) {
      getLogger().platP.error(`QQBot[${this.profile}]: 重启失败：`, err);
    }
  }

  #watchdog = -1; #watchdogTicking = false;
  /** 主动式看门狗，qqbot框架没有喂狗接口 */
  onWatchdogTick() {
    if (!this.bot) return;
    if (this.#watchdogTicking) return;
    this.#watchdogTicking = true;
    this.bot.getSelfInfo().then(() => {
      this.#watchdogTicking = false;
      getLogger().platP.debug(`QQBot[${this.profile}]/Watchdog: 看门狗探测成功，机器人服务运行正常。`);
    }).catch((err) => {
      this.#watchdogTicking = false;
      getLogger().platP.warn(`QQBot[${this.profile}]/Watchdog: 看门狗探测失败，尝试重启机器人服务。`);
      this.restart();
    });
  }

  /**
   * 向指定用户发送消息
   * @param {string} who 用户标识
   * @param  {...import('#/message/messageFragment.js').NeonaicTValidMessage} msg 要发送的消息
   * @returns {Promise<string>} 发送结果
   */
  async sendMsg(who, ...msg) {
    const messageContent = msg.map(v => parseString(v, false)).join('');
    const [user, platform = ""] = parseString(who).replace(/@.*$/, '').split('@');

    // 语法糖，如果 platform 不是本实例的，且存在+有效，那么自动转发
    if (
      platform
      && platform !== this.profile
      && (PlatformManager?.instance?.getPlatform?.(platform) instanceof PlatformQQBot)
    ) {
      return PlatformManager.instance.getPlatform(platform).sendMsg(user, messageContent);
    }

    // 发送消息
    try {
      const result = await sendMsg(this, user, messageContent);
      getLogger().platP.debug(`[qqbot] 向`, user, `发送消息`, msg, `：`, result);
      this.logMsgOut('Command:', `to=${user} | msg=`, messageContent.replace(/\n/g, "\\n"));
      // SendResult 可能为「消息审核中」状态
      if (result?.audit_status === 'pending') {
        return `“${neonaicConfManager.getBotName()}”已向[${user}@${platform}]发送消息，但消息正在审核中。`;
      }
      return `“${neonaicConfManager.getBotName()}”成功向[${user}@${platform}]发送指定消息。`;
    } catch (err) {
      getLogger().platP.debug(`[qqbot] 向`, user, `发送消息失败：`, err.message);
      return `“${neonaicConfManager.getBotName()}”无法向[${user}@${platform}]发送指定消息，因为“${err.message}”。`;
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
 * @this {import('#/extension/extLoader.js').NeonaicExtItem}
 * @param {{ manifest: Object, pwd: String, ext_item_id: String, ext_item_timestamp: Number }} [ctx] 拓展上下文
 */
export function onEnable(ctx) {
}

/**
 * 拓展卸载钩子。
 *
 * 同 {@link onEnable}：平台实例的启停由 PlatformManager 负责，这里保持空实现。
 *
 * @this {import('#/extension/extLoader.js').NeonaicExtItem}
 */
export function onDisable() {
}
