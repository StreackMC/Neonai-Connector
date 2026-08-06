/**
 * platform/Platform.js — 平台基类
 *
 * 所有平台适配器须继承此类，并实现 start() / stop() 生命周期方法。
 * 平台模块在 import 时创建实例并通过 registerPlatform() 注册。
 */
export class Platform {
  /**
   * @param {string} name 平台名（对应 config/main.json 中 listening.<name>）
   */
  constructor(name) {
    this.name = name;
  }

  /**
   * 启动平台。
   * 可返回 { close } 对象或一个 close 函数，供平台管理器在停止时调用。
   * @returns {Promise<{ close: () => void } | (() => void) | void>}
   */
  async start() {
    throw new Error(`平台 "${this.name}" 未实现 start() 方法`);
  }

  /**
   * 停止平台。
   * 默认空实现，子类可覆盖。
   * @returns {Promise<void>}
   */
  async stop() {}
}
