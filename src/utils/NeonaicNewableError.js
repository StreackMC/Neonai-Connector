import { NeonaicNewable } from "./NeonaicNewableClass.js";
import { parseString } from '../utils/text.js';

/**
 * Neonaic 相关错误
 */
export class NeonaicError extends Error {
  #INSTANCE_ID = NeonaicNewable.getUniqueId(); #TIMESTAMP = new Date();
  get INSTANCE_ID() { return this.#INSTANCE_ID; };
  get TIMESTAMP() { return this.#TIMESTAMP; };

  constructor(reason = "", cause = null) {
    super(parseString(reason), { cause });
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
export class NeonaicIllegalArgumentError extends NeonaicError {
  constructor(reason = "", cause = null) {
    super(reason, cause);
    this.name = 'NeonaicIllegalArgumentError';
  }
}

/**
 * 当前状态不适合调用某方法
 */
export class NeonaicIllegalStateError extends NeonaicError {
  constructor(reason = "", cause = null) {
    super(reason, cause);
    this.name = 'NeonaicIllegalStateError';
  }
}

/**
 * 算术异常，典型是整数除以零
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