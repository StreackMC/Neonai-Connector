import { NeonaicNewable } from "./NeonaicNewableClass.js";
import { parseString } from './chore.js';

/**
 * Neonaic 相关错误
 */
export class NeonaicError extends Error {
  #INSTANCE_ID = NeonaicNewable.getUniqueId(); #TIMESTAMP = new Date();
  get INSTANCE_ID() { return this.#INSTANCE_ID; };
  get TIMESTAMP() { return this.#TIMESTAMP; };

  constructor(reason = "", cause = null) {
    if (reason instanceof Error) {
      // reason 是 Error ，开始语法糖
      if (cause === undefined || cause === null) {
        super(reason.message, { cause });
      } else {
        // 自动封装
        super(reason.message, { cause: reason });
      }
    } else {
      // reason 不是 Error，直接封装
      super(parseString(reason), { cause });
    }
    this.name = 'NeonaicError';
  }
}

/**
 * 命令执行相关错误
 */
export class NeonaicCommandError extends NeonaicError {
  constructor(reason = "", cause = null) {
    super(reason, cause);
    this.name = 'NeonaicCommandError';
  }
}

/**
 * 拓展相关错误
 */
export class NeonaicExtensionError extends NeonaicError {
  constructor(reason = "", cause = null) {
    super(reason, cause);
    this.name = 'NeonaicExtensionError';
  }
}

/**
 * 网络错误
 */
export class NeonaicNetworkError extends NeonaicError {
  constructor(reason = "", cause = null) {
    super(reason, cause);
    this.name = 'NeonaicNetworkError';
  }
}

/**
 * IO错误
 */
export class NeonaicIOError extends NeonaicError {
  constructor(reason = "", cause = null) {
    super(reason, cause);
    this.name = 'NeonaicIOError';
  }
}

/**
 * 通信协议错误：分帧、握手、消息结构等违反约定的情形。
 * @apiNote 构造签名与其它 Neonaic*Error 保持一致；如需携带协议错误码，
 *          请在抛出前设置 {@link NeonaicProtocolError#code}。
 */
export class NeonaicProtocolError extends NeonaicError {
  /** 协议错误码（如 'bad_frame' / 'unsupported_version'），未指定时为 null @type {string|null} */
  code = null;

  constructor(reason = "", cause = null) {
    super(reason, cause);
    this.name = 'NeonaicProtocolError';
  }
}

/**
 * 找不到文件
 */
export class NeonaicFileNotFoundError extends NeonaicIOError {
  constructor(reason = "", cause = null) {
    super(reason, cause);
    this.name = 'NeonaicFileNotFoundError';
  }
}

/**
 * 向方法传递了不合法或不合适的参数
 */
export class NeonaicNullPointerError extends NeonaicError {
  constructor(reason = "", cause = null) {
    super(reason, cause);
    this.name = 'NeonaicNullPointerError';
  }
}

/**
 * 向方法传递了不合法或不合适的参数
 */
export class NeonaicIllegalArgumentError extends NeonaicError {
  constructor(reason = "", cause = null) {
    super(reason, cause);
    this.name = 'NeonaicIllegalArgumentError';
  }
}

/**
 * 当前状态不适合调用某方法，或者当前状态不合适
 */
export class NeonaicIllegalStateError extends NeonaicError {
  constructor(reason = "", cause = null) {
    super(reason, cause);
    this.name = 'NeonaicIllegalStateError';
  }
}

/**
 * 算术异常，典型是整数除以零，或者算出来了一个 NaN
 */
export class NeonaicArithmeticError extends NeonaicError {
  constructor(reason = "", cause = null) {
    super(reason, cause);
    this.name = 'NeonaicArithmeticError';
  }
}

/**
 * 调用了对象不支持的操作
 */
export class NeonaicUnsupportedOperationError extends NeonaicError {
  constructor(reason = "", cause = null) {
    super(reason, cause);
    this.name = 'NeonaicUnsupportedOperationError';
  }
}