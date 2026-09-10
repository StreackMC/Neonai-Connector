import { getLogger } from "./logger/Logger.js";

/**
 * @abstract Neonaic可实例化类的通用基类
 * @internalApi For Neonaic only
 */
export class NeonaicNewable {
  #INSTANCE_ID = new UUID(); #TIMESTAMP = new Date();
  get INSTANCE_ID() { return this.#INSTANCE_ID; };
  get TIMESTAMP() { return this.#TIMESTAMP; };

  constructor() {
    if (new.target === NeonaicNewable) throw new Error("NeonaicNewable is a raw class, which is not allowed to be create directly");
  }
}

const BASENUM = 34699705549214;
let count = Math.abs(BASENUM - Math.floor(Math.random() * 1e14));

export function getUniqueId() {
  if (count < Number.MAX_SAFE_INTEGER) return count++;
  count = 0;
  getLogger().main.error("内部计数器已达到最大值", Number.MAX_SAFE_INTEGER, "，并发生回绕。这可能会带来业务问题。");
  return count++;
}