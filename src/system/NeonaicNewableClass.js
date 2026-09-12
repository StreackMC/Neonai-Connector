/**
 * @abstract Neonaic可实例化类的通用基类
 * @internalApi For Neonaic only
 */
export class NeonaicNewable {
  #INSTANCE_ID = getUniqueId(); #TIMESTAMP = new Date();
  get INSTANCE_ID() { return this.#INSTANCE_ID; };
  get TIMESTAMP() { return this.#TIMESTAMP; };

  constructor() {
    if (new.target === NeonaicNewable) throw new Error("NeonaicNewable is a raw class, which is not allowed to be create directly");
  }
}

const BASENUM = 34699705549214;
let count = Math.abs(BASENUM - Math.floor(Math.random() * 1e14));

/** @returns 全局唯一的 number 数据 */
function getUniqueId() {
  if (count < Number.MAX_SAFE_INTEGER) return count++;
  // 静默回绕
  count = 0;
  return count++;
}

export const NeonaicNewableClass = {
  getUniqueId,
};
