/**
 * neonaicEventBus
 * 
 * 本文件负责 Neonaic 的事件总线，采用惰性初始化+不主动加载机制，即按需启用。
 * 
 * 不主动初始化：Entry.js 并不会加载本文件
 * 
 * @author kdxhub
 */

import { NeonaicEventServices } from "./neonaicEventInterface.js";

let bus = null;

/** @returns {NeonaicEventServices} 获取事件总线 */
function getEventBus() {
  if (bus == null) {
    bus = new NeonaicEventServices();
  }
  return bus;
}

export const neonaicEventBus = {
  /**
   * 添加事件监听器
   * @param {string} type 要监听的事件类型
   * @param {EventListener|EventListenerObject} listener 监听器
   * @param {EventListenerOptions|boolean} [options] 监听选项
   * @throws {NeonaicIllegalArgumentError|TypeError} 参数类型不合法
   */
  addEventListener: (type, listener, options) => getEventBus().addEventListener(type, listener, options),
  /**
   * 移除事件监听器
   * @param {string} type 事件类型
   * @param {EventListener|EventListenerObject} listener 监听器
   * @param {EventListenerOptions} [options] 监听选项
   */
  removeEventListener: (type, listener, options) => getEventBus().removeEventListener(type, listener, options),
  /**
   * 分发一个事件
   * @apiNote 事件类型将强制小写 + trim() 处理，建议使用常量枚举和 namespace:name 式命名
   * @template T 事件的业务类型
   * @param {import('./neonaicEventInterface.js').NeonaicEvent<T>|String} event 传入一个 Neonaic 事件，此时后两参数无效；或者传入一个事件名。传入错误类型将抛出异常
   * @param {T} [payload] 业务数据
   * @param {import('./neonaicEventInterface.js').NeonaicTEventOptions} [options] 事件配置
   * @returns {boolean} 事件是否被否决
   * @throws {import('../utils/NeonaicNewableError.js').NeonaicIllegalArgumentError} 参数不合法
   * @throws {import('../utils/NeonaicNewableError.js').NeonaicError} 新建事件语法糖无法生效
   */
  dispatchEvent: (event, payload, options) => getEventBus().dispatchEvent(event, payload, options),
};