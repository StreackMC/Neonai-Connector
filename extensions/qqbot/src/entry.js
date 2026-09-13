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
import MsgHandler from "./msgHandler.js";
import { EVENTS, INTENTS } from "./enums.js";
import { NeonaicIllegalArgumentError } from '../../../src/utils/NeonaicNewableError.js';

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
    return { close: () => this.stop() };
  }

  async stop() {
    if (this.#botInstance) {
      this.#botInstance.stop();
      this.#botInstance = null;
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
