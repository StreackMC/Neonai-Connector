import { NeonaicArithmeticError, NeonaicIllegalArgumentError } from "./NeonaicNewableError.js";
import { parseString } from "./chore.js";

function getNaNException(where) {
  return new NeonaicArithmeticError(where ? `在${parseString(where)}发现意外的 NaN` : '发现意外的 NaN', where ? where : null);
}

export const neonaicMath = {
  /**
   * 将传入值尽可能地转为数字，遇到多个小数点时只保留第一个
   * @implNote 先强转为文本，再删除非数字部分，最后得到结果
   * @param {any} v 传入值
   * @param {boolean} allowNaN 是否接受返回 NaN，为 false 时返回 0
   * @returns {number|NaN} 结果，当转出字符串不含数字时为 NaN
   */
  toNumber: (v, allowNaN = true) => {
    if (typeof v === 'number') return v;
    // 只保留数字和点
    const s = parseString(v).replace(/[^0-9.]/g, '');
    // 拆出整数部分 + 其余全部当小数
    const parts = s.split('.');
    const int = parts[0];
    const dec = parts.slice(1).join('');   // 去掉后面多余的点
    if (int === "") return allowNaN ? NaN : 0;
    return Number(`${int}.${dec}`);
  },

  /**
   * 将输入钳制到一个范围里面
   * @param {number} v 输入值
   * @param {number} min 最小值，默认无限制
   * @param {number} max 最大值，默认无限制
   * @returns {number|NaN} 如果输入是 NaN 或者 min > max 时返回 NaN，其余返回钳制值。
   */
  clamp: (v, min, max) => {
    min = Number.isFinite(min) ? min : Number.NEGATIVE_INFINITY;
    max = Number.isFinite(max) ? max : Number.POSITIVE_INFINITY;
    if (neonaicMath.isNaN(v, min, max).length != 0 || min > max) return NaN;
    return v < min ? min : v > max ? max : v;
  },

  /**
   * 将输入映射到一个范围里面，算法为取模（余数）。
   * @param {number} v 输入值
   * @param {number} min 最小值
   * @param {number} max 最大值
   * @returns {number|NaN} 如果输入是 NaN 或者 min > max 时返回 NaN，其余返回映射值。
   */
  warp: (v, min, max) => {
    min = Number.isFinite(min) ? min : Number.NEGATIVE_INFINITY;
    max = Number.isFinite(max) ? max : Number.POSITIVE_INFINITY;
    if (neonaicMath.isNaN(v, min, max).length != 0 || min > max) return NaN;
    const range = max - min;
    return ((v - min) % range + range) % range + min;
  },

  /**
   * 获取一个随机数
   * @param {number} min 最小值，不得小于0
   * @param {number} max 最大值
   * @returns {number} 之间的随机整数，如果发生意外会返回 NaN，如最小值比最大值大
   */
  random: (min, max = Number.MAX_SAFE_INTEGER) => {
    min = clamp(Number.isFinite(min) ? min : 0, 0, undefined);
    max = Number.isFinite(max) ? max : Number.MAX_SAFE_INTEGER;
    if (neonaicMath.isNaN(v, min, max).length != 0 || min > max) return NaN;
    return Math.round(Math.random() * (max - min) + min);
  },

  /** 取一个数字的整位数 @param {number} n 自动转整数，传入非 number 会导致意外发生 */
  digitCount: (n) => String(Math.abs(Math.trunc(neonaicMath.assertNoNaN(n)))).length,

  /**
   * 断言一个或一些数值不是 NaN，否则将抛出{@link NeonaicArithmeticError}。
   * @param {number[]|number} v 要断言的数据
   * @param {String} cause 可选：断言失败，说明 NaN 的来源用
   * @returns {number} 断言成功返回数字
   * @see {@link neonaicMath.isNaN} 不抛错误的版本
   */
  assertNoNaN: (v, cause) => {
    if (!Array.isArray(v)) v = [v];
    v.forEach((i) => {
      if (Number.isNaN(i)) throw getNaNException(cause);
    })
    return v;
  },

  /**
   * 断言一个或一些数值不是 NaN，否则使用默认值。
   * @template T
   * @param {number} v 要断言的数据
   * @param {T} d 断言失败返回值
   * @returns {T|number}
   */
  assertNoNaNOrElse: (v, d) => {
    return Number.isNaN(v) ? d : v;
  },

  /**
   * 断言一个函数返回值不是 NaN，否则将抛出{@link NeonaicArithmeticError}。
   * @template T
   * @param {(...any) => T} operation 函数
   * @param {any} args 函数参数
   * @returns {T} 断言成功返回函数结果
   */
  assertResultNoNaN: (operation, ...args) => {
    if (typeof operation !== 'function') throw new NeonaicIllegalArgumentError("期待的传入值不是函数：" + parseString(operation));
    const v = operation.apply(this, args);
    return neonaicMath.assertNoNaN(v, "断言函数结果非 NaN 时");
  },

  /**
   * 断言一个函数返回值不是 NaN，否则将返回回退值。
   * @template T
   * @template V
   * @param {(...any) => T} operation 函数
   * @param {V} fallback 回退值
   * @param {any} args 函数参数
   * @returns {V|T}
   */
  assertResultNoNaNOrElse: (operation, fallback, ...args) => {
    if (typeof operation !== 'function') throw new NeonaicIllegalArgumentError("期待的传入值不是函数：" + parseString(operation));
    const v = operation.apply(this, args);
    return Number.isNaN(v) ? fallback : v;
  },

  /**
   * 判断一个或一些数值是不是 NaN
   * @param {number} v 要判断的数据
   * @returns {number[]} NaN 数据的索引，都不是则为空
   * @see {@link neonaicMath.assertNoNaN} 抛错误的版本
   */
  isNaN: (...v) => {
    let result = [];
    for (let i = 0; i < v.length; i++) {
      if (Number.isNaN(v[i])) result.push(i);
    }
    return result;
  },

  /**
   * 判断一个或一些数值是不是 Inf
   * @param {number} v 要判断的数据，非数字不会转换
   * @returns {number[]} 目标数据的索引，都不是则为空
   */
  isInfinite: (...v) => {
    let result = [];
    for (let i = 0; i < v.length; i++) {
      if (!Number.isFinite(v[i])) result.push(i);
    }
    return result;
  },

  /**
   * 判断一个或一些数值是不是整数
   * @param {number} v 要判断的数据，非数字不会转换
   * @returns {number[]} 目标数据的索引，都不是则为空
   */
  isInt: (...v) => {
    let result = [];
    for (let i = 0; i < v.length; i++) {
      if (Number.isInteger(v[i])) result.push(i);
    }
    return result;
  },

  /**
   * 判断一个或一些数值是不是有误差的大整数
   * @param {number} v 要判断的数据，非数字不会转换
   * @returns {number[]} 目标数据的索引，都不是则为空
   */
  isUnsafeInt: (...v) => {
    let result = [];
    for (let i = 0; i < v.length; i++) {
      if (!Number.isSafeInteger(v[i])) result.push(i);
    }
    return result;
  },
}