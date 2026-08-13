/**
 * platform/PlatformInterface.js — Platform 基类
 *
 * 所有 Platform 实现须继承此类，构造函数接收 Profile 配置（由 PM 注入），
 * 实现 start() / stop() 生命周期方法。
 *
 * Platform 实现不应访问任何全局/静态状态（getConfig、getDebugMode 等），
 * 所有运行时参数通过 this.profile 获取。
 */

import { getLogger } from "../system/logger/Logger.js";

export class Platform {
  /** Platform Profile 名称 @type {String} */
  profile;

  /**
   * @param {string} profile Profile 名称
   */
  constructor(profile) {
    this.profile = profile;
  }

  static type = '<DEFAULT>';

  /**
   * 启动该 Profile。不传参，根据 this.profile 中的信息启动。
   * 可返回 { close } 或 close 函数供停止时回调。
   * @returns {Promise<{ close: () => void } | (() => void) | void>}
   */
  async start() {
    if (new.target === Platform) throw new Error(`Platform "${this.type}" 未实现 start()`);
  }

  /**
   * 停止该 Profile。
   * @returns {Promise<void>}
   */
  async stop() {}

  /**
   * 消息传入回调，一般无需覆盖
   * @param {...*} msg 消息，自动转文本
   */
  logMsgIn(...msg) {
    const type_ = (this.constructor.type) ? this.constructor.type : '<UNKNOWN>';
    getLogger().chatIn.info(`<${type_}/${this.profile}>`, ...msg);
  }

  /**
   * 记录日志
   * @param {'info'|'debug'|'warn'|'error'} type 日志类型
   * @param {...*} msg 消息，自动转文本
   */
  log(type, ...msg) {
    const type_ = (this.constructor.type) ? this.constructor.type : '<UNKNOWN>';
    getLogger().platP[type](`<${type_}/${this.profile}>`, ...msg);
  }

  /**
   * 消息传出回调，一般无需覆盖
   * @param {...*} msg 消息，自动转文本
   */
  logMsgOut(...msg) {
    const type_ = (this.constructor.type) ? this.constructor.type : '<UNKNOWN>';
    getLogger().chatOut.info(`<${type_}/${this.profile}>`, ...msg);
  }
}
