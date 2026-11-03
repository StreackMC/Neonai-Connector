import { NeonaicUnsupportedOperationError } from "#src/utils/NeonaicNewableError.js";

/**
 * @abstract Neonaic可实例化类的通用基类
 * @internalApi For Neonaic only
 */
export class NeonaicNewable {
  #INSTANCE_ID = getuid(); #TIMESTAMP = new Date();
  /** 实例标识符 */
  get INSTANCE_ID() { return this.#INSTANCE_ID; };
  /** 实例时间戳的拷贝 */
  get TIMESTAMP() { return new Date(this.#TIMESTAMP.getTime()); };

  constructor() {
    if (new.target === NeonaicNewable) throw new NeonaicUnsupportedOperationError("NeonaicNewable is a raw class, which is not allowed to be create directly");
  }

  /** @returns 全局唯一的 number 数据 */
  static getUniqueId() {
    return getuid();
  }
}

const BASENUM = 34699705549214;
let count = Math.abs(BASENUM - Math.floor(Math.random() * 1e14));

function getuid() {
  if (count < Number.MAX_SAFE_INTEGER) return count++;
  // 静默回绕
  count = 0;
  return count++;
}