import { NeonaicCommandContext } from "../command/commandServer.js";
import { NeonaiPlatform } from "../platform/platformInterface.js";
import { parseString } from "../utils/chore.js";
import { NeonaicNewable } from "../utils/NeonaicNewableClass.js";
import { NeonaicError, NeonaicIllegalArgumentError } from "../utils/NeonaicNewableError.js";

/**
 * @typedef {Object} NeonaicTEventOptions
 * @property {boolean} [cancelable=true] 事件是否可被否决，否决后 dispatchEvent 将返回 false
 * @property {boolean} [bubbles=true] **仅浏览器：**是否允许冒泡
 * @property {boolean} [composed=true] **仅浏览器：**是否允许透传 ShadowDOM
 */

export class NeonaicEventServices extends EventTarget {
  #INSTANCE_ID = NeonaicNewable.getUniqueId(); #TIMESTAMP = new Date();
  get INSTANCE_ID() { return this.#INSTANCE_ID; };
  get TIMESTAMP() { return this.#TIMESTAMP; };

  /**
   * 分发一个事件
   * @apiNote 事件类型将强制小写 + trim() 处理，建议使用常量枚举和 namespace:name 式命名
   * @template T 事件的业务类型
   * @param {NeonaicEvent<T>|String} event 传入一个 Neonaic 事件，此时后两参数无效；或者传入一个事件名。传入错误类型将抛出异常
   * @param {T} [payload] 业务数据
   * @param {NeonaicTEventOptions} [options] 事件配置
   * @returns {boolean} 事件是否被否决
   * @throws {NeonaicIllegalArgumentError} 参数不合法
   * @throws {NeonaicError} 新建事件语法糖无法生效
   */
  dispatchEvent(event, payload, options) {
    if (typeof event === 'string') {
      try {
        return super.dispatchEvent(new NeonaicEvent(event, payload, options));
      } catch (error) {
        throw new NeonaicError(parseString("Unable to dispatch: Can not apply the syntactic sugar to new a event:", e), [event, payload, options, e]);
      }
    } else if (event instanceof NeonaicEvent) {
      return super.dispatchEvent(event);
    }
    throw new NeonaicIllegalArgumentError("Unable to dispatch: The event must be an instance of NeonaicEvent or a string.", [event, payload, options]);
  }
}

/**
 * Neonaic 标准事件
 * @template T 业务承载的数据类型
 * @apiNote 原始类型，建议继承。
 */
export class NeonaicEvent extends CustomEvent {
  #INSTANCE_ID = NeonaicNewable.getUniqueId(); #TIMESTAMP = new Date();
  /** 获取事件的实例标识符 */
  get INSTANCE_ID() { return this.#INSTANCE_ID; };
  /** 获取事件发生时的时间 */
  get TIMESTAMP() { return this.#TIMESTAMP; };
  /** 获取事件类型 */
  static get EVENT_TYPE() { return "neonaic:basic"; };

  /**
   * 构造一个事件
   * @param {String} type 事件名
   * @param {T} [details] 事件承载的业务数据
   * @param {NeonaicTEventOptions} [options] 事件选项
   */
  constructor(type, details, options = {}) {
    if (typeof details !== 'object') throw new NeonaicIllegalArgumentError("details must be a non-null object");
    super(parseString(type).trim().toLowerCase(), {
      cancelable: options?.cancelable ?? true,
      /* NodeJS 中无效，为浏览器环境兼容而保留 */
      bubbles: options?.bubbles ?? true,
      composed: options?.composed ?? true,
      detail: details,
    });
  }

  /**
   * 获取业务承载的数据类型
   * @type {T} 数据类型
   */
  get detail() { return super.detail; }
}

/**
 * @typedef {Object} NeonaicTMessageEventPayload
 * @property {string|*} message 消息内容；消息内容不会自动转文本
 * @property {string[]} user 消息来自哪个场景上下文；可以参考 {@link import('../command/commandServer.js').NeonaicCommandContext.executor()}
 * @property {NeonaiPlatform|null} pm 平台连接器实例
 * @property {(msg: string) => (Promise<void>|void)} [reply] 回复消息接口；存在时用于表述「被动等待回复」而非「主动请求回复」。
 */

/**
 * 消息事件
 * @extends {NeonaicEvent<NeonaicTMessageEventPayload>}
 */
export class NeonaicMessageEvent extends NeonaicEvent {
  /** 获取事件类型 */
  static get EVENT_TYPE() { return "neonaic:message"; };

  /**
   * 构造一个事件
   * @param {NeonaiPlatform|null} p 平台连接器实例
   * @param {string|string[]} user 消息来自哪个场景上下文；可以参考 {@link import('../command/commandServer.js').NeonaicCommandContext.executor()}
   * @param {string|*} message 消息内容；消息内容不会自动转文本，但不能是 undefined
   * @param {(msg: string) => (Promise<void>|void)} [replyFunc] 回复消息接口；存在时用于表述「被动等待回复」而非「主动请求回复」。
   * @param {NeonaicTEventOptions} [options] 事件选项
   * @throws {NeonaicIllegalArgumentError} 参数不合法
   */
  constructor(p, user, message, replyFunc = null, options = {}) {
    if (!(p instanceof NeonaiPlatform) && !(p === null)) throw new NeonaicIllegalArgumentError("pm must be an instance of NeonaiPlatform");
    if (typeof message === 'undefined') throw new NeonaicIllegalArgumentError("message must be defined");
    super(NeonaicMessageEvent.EVENT_TYPE, {
      message: message,
      user: Array.isArray(user) ? user.map(parseString) : [parseString(user)],
      pm: p,
      reply: (typeof options?.reply === 'function') ? options.reply : undefined,
    }, options);
  }
}

/**
 * @typedef {Object} NeonaicTCommandEventPayload
 * @property {string|null} [command] 命令名，非 String 一律未知命令
 * @property {string[]|null} [args] 命令参数
 * @property {import('../command/commandServer.js').NeonaicCommandContext} context 命令上下文
 * @property {NeonaicTCommandEventStatus} status 命令执行状态
 * @property {*|Promise<*>|null} [result] 命令执行结果
 * @typedef {'postexecute'|'success'|'error'} NeonaicTCommandEventStatus
 */

/**
 * 命令事件
 * @extends {NeonaicEvent<NeonaicTCommandEventPayload>}
 */
export class NeonaicCommandEvent extends NeonaicEvent {
  /** 获取事件类型 */
  static get EVENT_TYPE() { return "neonaic:command"; };

  /**
   * 构造一个事件
   * @param {NeonaicTCommandEventPayload} payload 消息内容；消息内容不会自动转文本，但不能是 undefined
   * @param {NeonaicTEventOptions} [options] 事件选项
   * @throws {NeonaicIllegalArgumentError} 参数不合法
   */
  constructor(payload, options = {}) {
    let status = parseString(payload?.status).toLowerCase().trim();
    switch (status) {
      case 'postexecute':
      case 'success':
      case 'error':
        break;
      default:
        throw new NeonaicIllegalArgumentError("Unknown status: " + payload?.status, [payload, options]);
    }
    super(NeonaicCommandEvent.EVENT_TYPE, {
      command: (typeof payload?.command === 'string') ? payload?.command : null,
      args: (payload?.args === null || typeof payload?.args === 'undefined')
        ? null
        : (Array.isArray(payload?.args)) ? payload?.args.map(parseString) : [parseString(payload?.args)],
      context: (payload?.context instanceof NeonaicCommandContext) ? payload?.context : new NeonaicCommandContext(payload?.context),
      status: status,
      result: payload?.result ?? null,
    }, options);
  }
}