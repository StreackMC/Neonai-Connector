import { neonaicConfManager } from '../system/confManager.js';
import { NeonaicIllegalArgumentError, NeonaicIllegalStateError, NeonaicNullPointerError } from './NeonaicNewableError.js';

/** 当前是否处于调试模式（与 entry.js / Logger.js 保持同一判定） */
const DEBUGING = process.argv.some((a) => a === '--debug=true' || a === '--debug');

/**
 * 尝试将输入尽可能地转化为文本
 * @param {*} val 输入值
 * @param {boolean} [short] 是否要截断：会只枚举前3个属性/对象；当调试模式时默认禁用，反之同理。**需要严格为真以防传入参数语义不明**
 * @param {boolean} [processString=false] 是否要把文本规整化。**需要严格为真以防传入参数语义不明**
 * @returns {String} 处理后的文本。Array→[1, 2, ...]  Map→{key=value, k=v, ...}  Set→{1, 2, ...}  Object→.toString()/{key: value, ...}
 * @apiNote 本函数为全项目通用文本化工具，被大量模块直接引用；为避免调用点过度冗长，
 *          它保持顶层具名导出，不收纳进 NeonaicLogger 对象。
 */
export function parseString(val, short = !(DEBUGING || neonaicConfManager.getConfig(neonaicConfManager.CONFIG_PATHS.main).getBoolean('detailedLog', false)), processString = false) {
  // 基础类型：字符串加单引号，并转义特殊字符
  if (typeof val === 'string') {
    return (processString === true) ? `'${val.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}'` : val;
  }

  // 空值与布尔值
  if (val === null) return 'null';
  if (val === undefined) return 'undefined';

  // 错误对象
  if (val instanceof Error) return val.message ?? String(val);

  // 数组
  if (Array.isArray(val)) {
    const items = short === true ? val.slice(0, 3) : val;
    const body = items.map((v) => parseString(v, short, true)).join(', ');
    const suffix = short === true && val.length > 3 ? ` ... (+${val.length - 3})` : '';
    return `[${body}${suffix}]`;
  }

  // Map
  if (val instanceof Map) {
    const entries = Array.from(val.entries());
    const visible = short === true ? entries.slice(0, 3) : entries;
    const body = visible.map(([key, value]) =>
      `${parseString(key, short, true)}=${parseString(value, short, true)}`
    ).join(', ');
    const suffix = short === true && val.size > 3 ? ` ... (+${val.size - 3})` : '';
    return `{${body}${suffix}}`;
  }

  // Set
  if (val instanceof Set) {
    const items = Array.from(val);
    const visible = short === true ? items.slice(0, 3) : items;
    const body = visible.map(v => parseString(v, short, true)).join(', ');
    const suffix = short === true && val.size > 3 ? ` ... (+${val.size - 3})` : '';
    return `{${body}${suffix}}`;
  }

  // 只对非普通对象使用 toString
  if (Object.prototype.toString.call(val) !== '[object Object]' && typeof val.toString === 'function') {
    return val.toString();
  }

  // 对象
  if (typeof val === 'object') {
    const keys = Object.keys(val);
    const visibleKeys = short === true ? keys.slice(0, 3) : keys;
    const body = visibleKeys
      .map((k) => `${k}: ${parseString(val[k], short, true)}`)
      .join(', ');
    const suffix = short === true && keys.length > 3 ? ` ... (+${keys.length - 3})` : '';
    return `{${body}${suffix}}`;
  }

  // 数字等直接转字符串
  return String(val);
}

export const neonaicChore = {
  parseString,

  /**
   * 断言不是 Null/Undefined ，否则抛出{@link NeonaicNullPointerError}。
   * @template T
   * @param {T|null|undefined} v 数据
   * @param {String} cause 抛错信息
   * @returns {T} 断言成功返回数据
   */
  assertNoNull: (v, cause) => {
    if (v === null || v === undefined) throw new NeonaicNullPointerError(parseString(cause));
    return v;
  },

  /**
   * 断言不是 Null/Undefined ，否则返回回退值。
   * @template T
   * @template V
   * @param {T|null|undefined} v 数据
   * @param {V} fallback 回退结果
   * @returns {T|V} 断言成功返回数据，否则为回退值
   */
  assertNoNullOrElse: (v, fallback) => {
    return v ?? fallback;
  },

  /**
   * 断言一个函数返回值严格相等指定值，否则将抛出{@link NeonaicIllegalStateError}。
   * @template T
   * @param {(...any) => T} operation 函数
   * @param {T} excepted 期望结果
   * @param {any} args 函数参数
   * @returns {T} 断言成功返回函数结果
   */
  assertResult: (operation, excepted, ...args) => {
    if (typeof operation !== 'function') throw new NeonaicIllegalArgumentError("期待的传入值不是函数：" + parseString(operation));
    const v = operation.apply(this, args);
    if (v !== excepted) throw new NeonaicIllegalStateError(`断言函数的返回值为“${parseString(excepted)}”时失败了，发现了:${parseString(v)}`);
    return v;
  },

  /**
   * 断言一个函数返回值严格相等指定值，否则将返回默认值。
   * @template T
   * @template V
   * @param {(...any) => T} operation 函数
   * @param {T} excepted 期望结果
   * @param {V} fallback 回退结果
   * @param {any} args 函数参数
   * @returns {T|V} 断言成功返回函数结果，否则为回退值
   */
  assertResultOrElse: (operation, excepted, fallback, ...args) => {
    if (typeof operation !== 'function') throw new NeonaicIllegalArgumentError("期待的传入值不是函数：" + parseString(operation));
    const v = operation.apply(this, args);
    return (v !== excepted) ? fallback : v;;
  },

  /**
   * 断言一个函数返回文本合理，否则将抛出{@link NeonaicIllegalStateError}。
   * @param {(...any) => String} operation 函数
   * @param {RegExp|String} excepted 期望结果，文本时返回值需要包含，正则时需要匹配。**复用正则可能导致 last_index 紊乱，需要手动重置。**
   * @param {any} args 函数参数
   * @returns {String} 断言成功返回函数结果
   */
  assertResultFullfill: (operation, excepted, ...args) => {
    if (typeof operation !== 'function') throw new NeonaicIllegalArgumentError("期待的传入值不是函数：" + parseString(operation));
    if (typeof excepted !== 'string' || !(excepted instanceof RegExp)) throw new NeonaicIllegalArgumentError("期待的传入值类型不是文本或正则：" + parseString(operation));
    const v = parseString(operation.apply(this, args));
    if (!(typeof excepted === 'string' && v.includes(excepted)) && !(excepted instanceof RegExp && excepted.test(v))) throw new NeonaicIllegalStateError(`断言函数的返回值为“${parseString(excepted)}”时失败了，发现了:${v}`);
    return v;
  },

  /**
   * 断言一个函数返回文本合理，否则将返回默认值。
   * @template T
   * @param {T} fallback 回退值
   * @param {(...any) => String} operation 函数
   * @param {RegExp|String} excepted 期望结果，文本时返回值需要包含，正则时需要匹配。**复用正则可能导致 last_index 紊乱，需要手动重置。**
   * @param {any} args 函数参数
   * @returns {String|T} 断言成功返回函数结果，否则为回退值
   */
  assertResultFullfillOrElse: (operation, excepted, ...args) => {
    if (typeof operation !== 'function') throw new NeonaicIllegalArgumentError("期待的传入值不是函数：" + parseString(operation));
    if (typeof excepted !== 'string' || !(excepted instanceof RegExp)) throw new NeonaicIllegalArgumentError("期待的传入值类型不是文本或正则：" + parseString(operation));
    const v = parseString(operation.apply(this, args));
    return (!(typeof excepted === 'string' && v.includes(excepted)) && !(excepted instanceof RegExp && excepted.test(v))) ? fallback : v;
  },

  /**
   * 将多个对象合并，后者覆盖前者，会自动跳过数组和原型链注入
   * @param  {...object} objects 对象
   * @returns {object} 合并后的对象，**不是任何 class 的实例**
   */
  joinObject: (...objects) => {
    const r = {};
    for (const v of objects) {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) continue;
      for (const k of Object.keys(v)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        r[k] = v[k];
      }
    }
    return r;
  }
};