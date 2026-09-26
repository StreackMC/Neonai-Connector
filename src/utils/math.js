import { NeonaicArithmeticError, NeonaicIllegalArgumentError } from "./NeonaicNewableError.js";
import { parseString } from "./chore.js";

function getNaNException(where) {
  return new NeonaicArithmeticError(where ? `在${parseString(where)}发现意外的 NaN` : '发现意外的 NaN', where ? where : null);
}

export const neonaicMath = Object.freeze({
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
   * @implNote 用 `Math.floor` 而不是 `Math.round`：后者会让 min 与 max 各只占半个区间，
   *           例如 `random(1, 13)` 里 1 和 13 的概率只有其它点数的一半。
   * @param {number} min 最小值，不得小于0
   * @param {number} max 最大值
   * @returns {number} 之间的随机整数，如果发生意外会返回 NaN，如最小值比最大值大
   */
  random: (min, max = Number.MAX_SAFE_INTEGER) => {
    min = neonaicMath.clamp(Number.isFinite(min) ? min : 0, 0, undefined);
    max = Number.isFinite(max) ? max : Number.MAX_SAFE_INTEGER;
    if (neonaicMath.isNaN(min, max).length != 0 || min > max) return NaN;
    return min + Math.floor(Math.random() * (max - min + 1));
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

  /**
   * 解析并计算一个算式。
   * @implNote 递归下降，优先级由低到高为：加减 → 乘除模 → 一元正负 → 幂 → 根号 → 括号与数字。
   *           `^` 右结合（`2^3^2` = 512），且比一元负号更紧（`-2^2` = -4），但指数位置上允许带符号（`2^-3`）。
   * @implNote 除号 `/` 与 `÷` 等价，乘号还额外接受 `×` 与 `·`，全角符号会被自动折算。
   * @param {String} expr 算式文本，例如 `(13-9)*7-4`
   * @param {{power?: boolean, root?: boolean, mod?: boolean}} [options] 可选开启的特性。
   *        `power` 开启 `^` 与 `**`，`root` 开启 `√`、`∛`、`3√8`、`³√8`、`^3√8`，`mod` 开启 `%`。
   *        三项默认都是 false，即默认只解析四则运算。
   * @returns {number} 计算结果
   * @throws {NeonaicIllegalArgumentError} 算式语法错误，或使用了未开启的运算符
   * @throws {NeonaicArithmeticError} 除数为零、负数开偶次方等在实数域无意义的情况
   */
  calc: calcExpression,

  solve24: dfs24solution,
});

/**
 * 递归求解 24 点及类似问题
 * @implNote 逐个挑出两个数、用 `+ - * /` 合并成一个新数后递归，等价于枚举二叉表达式树的全部形态。
 *           `+` 与 `*` 满足交换律，两个子算式会先按字典序排好再拼接，于是 `a+b` 与 `b+a` 只会记一条；
 *           `-` 与 `/` 不满足交换律，两种顺序都保留。最终用 Set 对算式文本去重。
 * @param {number[]} numbers 源数字
 * @param {number} [target=24] 求解目标，默认 24
 * @returns {String[]} 全部解法（已去掉最外层多余括号）
 */
function dfs24solution(numbers, target = 24) {
  /** 可接受误差 */
  const EPS = 1e-6;
  /** 已找到的解 @param {Set<string>} */
  const SOLUTIONS = new Set();

  if (!Array.isArray(numbers)) throw new NeonaicIllegalArgumentError('求解器期待传入数组，但发现了:' + parseString(numbers));
  numbers = numbers.map((n) => Math.floor(neonaicMath.clamp(neonaicMath.toNumber(n), 1, Number.MAX_SAFE_INTEGER)));
  target = Math.floor(neonaicMath.clamp(neonaicMath.toNumber(target), 1, Number.MAX_SAFE_INTEGER));
  neonaicMath.assertNoNaN([...numbers, target], '传入非法参数：NaN');

  /**
   * 剥掉包裹整个算式的最外层括号
   * @param {String} e 算式
   * @returns {String}
   */
  function unwrap(e) {
    if (!(e.startsWith('(') && e.endsWith(')'))) return e;
    let depth = 0;
    for (let k = 0; k < e.length; k++) {
      if (e[k] === '(') depth++;
      else if (e[k] === ')') {
        depth--;
        // 括号在此处闭合：只有它是最后一对才说明这里包住了整体
        if (depth === 0) return k === e.length - 1 ? unwrap(e.slice(1, -1)) : e;
      }
    }
    return e;
  }

  /**
   * @param {number[]} values 当前的数字
   * @param {String[]} expries 与 values 一一对应的算式
   */
  function dfs(values, expries) {
    if (values.length === 1) {
      if (Math.abs(values[0] - target) <= EPS) SOLUTIONS.add(unwrap(expries[0]));
      return;
    }

    for (let i = 0; i < values.length; i++) {
      for (let j = i + 1; j < values.length; j++) {
        // 剩下的数字，按原顺序保留
        const restValues = [];
        const restExpries = [];
        for (let k = 0; k < values.length; k++) {
          if (k !== i && k !== j) {
            restValues.push(values[k]);
            restExpries.push(expries[k]);
          }
        }

        const a = values[i], b = values[j];
        const ea = expries[i], eb = expries[j];
        // 交换律的规范序：把两个子算式按字典序排好，避免 (a+b) 与 (b+a) 各记一条
        const [ca, cb] = ea > eb ? [eb, ea] : [ea, eb];

        /** 本次可以派生出的全部情况 */
        const branches = [
          [a + b, `(${ca}+${cb})`],
          [a * b, `(${ca}*${cb})`],
          [a - b, `(${ea}-${eb})`],
          [b - a, `(${eb}-${ea})`],
        ];
        if (b !== 0) branches.push([a / b, `(${ea}/${eb})`]);
        if (a !== 0) branches.push([b / a, `(${eb}/${ea})`]);

        for (const [value, expry] of branches) {
          // 中间结果允许为负，但出现 Infinity/NaN 的分支直接剪掉
          if (!Number.isFinite(value)) continue;
          dfs([...restValues, value], [...restExpries, expry]);
        }
      }
    }
  }

  dfs(numbers.slice(), numbers.map(parseString));
  return [...SOLUTIONS.values()];
}

// ---- 算式解析 ----

/** 全角与常见数学符号 → 可解析的半角符号 */
const CALC_SYMBOLS = Object.freeze({
  '（': '(', '）': ')', '＋': '+', '－': '-', '−': '-',
  '＊': '*', '×': '*', '·': '*', '／': '/', '÷': '/',
  '％': '%', '＾': '^',
  '０': '0', '１': '1', '２': '2', '３': '3', '４': '4',
  '５': '5', '６': '6', '７': '7', '８': '8', '９': '9', '．': '.',
});

/** 上标数字 → 半角数字，用于「³√8」这类根号次数 */
const CALC_SUPERSCRIPTS = Object.freeze({
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
  '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
});

/** 根号字符 → 不带次数时的默认次数 */
const CALC_RADICALS = Object.freeze({ '√': 2, '∛': 3 });

/** 根号次数可以用的字符（半角数字 + 上标数字） */
const CALC_INDEX_CHARS = `0-9${Object.keys(CALC_SUPERSCRIPTS).join('')}`;

/** 带次数的根号：`3√8`、`³√8`、`^3√8` */
const CALC_INDEXED_RADICAL = new RegExp(`^\\^?([${CALC_INDEX_CHARS}]+)\\s*(√|∛)`);

/** 数字字面量 */
const CALC_NUMBER = /^(?:\d+(?:\.\d+)?|\.\d+)/;

/**
 * 开方。对完全 n 次方数做整数回代修正，避免 `27^(1/3)` = 3.0000000000000004 这类浮点误差。
 * @param {number} value 被开方数
 * @param {number} n 次数
 * @returns {number}
 * @throws {NeonaicArithmeticError} 负数开偶次方
 */
function nthRootOf(value, n) {
  if (!Number.isInteger(n) || n < 1) throw new NeonaicIllegalArgumentError(`根号的次数必须是不小于 1 的整数：${parseString(n)}`);
  if (n === 1) return value;
  if (value < 0 && n % 2 === 0) throw new NeonaicArithmeticError(`${parseString(value)} 在实数域内没有偶次方根`);
  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);
  let r;
  if (n === 2) r = Math.sqrt(abs);
  else if (n === 3) r = Math.cbrt(abs);
  else {
    r = Math.pow(abs, 1 / n);
    // 浮点误差会把 4√16 算成 2.0000000000000004，用「整数回代」修回来
    const rounded = Math.round(r);
    if (rounded > 1 && Math.abs(Math.pow(rounded, n) - abs) <= 1e-6 * Math.max(1, abs)) r = rounded;
  }
  return sign * r;
}

/** 安全除法 @throws {NeonaicArithmeticError} 除数为零 */
function safeDivide(a, b) {
  if (b === 0) throw new NeonaicArithmeticError(`除数不能为零：${parseString(a)} ÷ 0`);
  return a / b;
}

/** 安全取模 @throws {NeonaicArithmeticError} 除数为零 */
function safeModulo(a, b) {
  if (b === 0) throw new NeonaicArithmeticError(`取模的除数不能为零：${parseString(a)} % 0`);
  return a % b;
}

/**
 * 递归下降地解析并计算一个算式（{@link neonaicMath.calc} 的实现）
 * @param {String} expr 算式文本
 * @param {{power?: boolean, root?: boolean, mod?: boolean}} [options] 可选开启的特性
 * @returns {number}
 */
function calcExpression(expr, options) {
  if (options !== undefined && options !== null && typeof options !== 'object') {
    throw new NeonaicIllegalArgumentError(`算式的选项应该是一个对象或留空：${parseString(options)}`);
  }
  const { power = false, root = false, mod = false } = options ?? {};

  // 归一化：折算全角与数学符号，`**` 与 `^` 等价
  const source = parseString(expr);
  let text = '';
  for (const ch of source) text += CALC_SYMBOLS[ch] ?? ch;
  text = text.replace(/\*\*/g, '^');

  /** 当前解析位置 */
  let at = 0;
  const skipSpace = () => { while (at < text.length && /\s/.test(text[at])) at++; };
  /** 造一个语法错误，附带出错位置；提示里同时给出归一化后的文本便于对照 */
  const fail = (why) => new NeonaicIllegalArgumentError(`${why}（第 ${at + 1} 个字符处）：${parseString(source)}`);
  const requireRoot = () => { if (!root) throw fail('未启用根号解析，无法使用“√”“∛”或带次数的根号'); };

  /** 括号或数字 */
  function parsePrimary() {
    skipSpace();
    if (text[at] === '(') {
      at++;
      const v = parseAdditive();
      skipSpace();
      if (text[at] !== ')') throw fail('括号没有闭合');
      at++;
      return v;
    }
    const matched = text.slice(at).match(CALC_NUMBER);
    if (!matched) throw fail('期待一个数字');
    at += matched[0].length;
    return Number(matched[0]);
  }

  /** 根号：`√9`、`∛8`、`3√8`、`³√8`、`^3√8` */
  function parseRadical() {
    skipSpace();
    const ch = text[at];
    // 不带次数的前缀根号
    if (ch !== undefined && CALC_RADICALS[ch]) {
      requireRoot();
      at++;
      // 操作数取一元表达式，于是 `∛-27` 也能解析（负数只允许开奇次方）
      return nthRootOf(parseUnary(), CALC_RADICALS[ch]);
    }
    // 带次数的根号。注意 `^3√8` 里的 `^` 是根号次数，不是幂运算符
    const indexed = text.slice(at).match(CALC_INDEXED_RADICAL);
    if (indexed) {
      requireRoot();
      const times = Number([...indexed[1]].map((c) => CALC_SUPERSCRIPTS[c] ?? c).join(''));
      at += indexed[0].length;
      return nthRootOf(parseUnary(), times);
    }
    return parsePrimary();
  }

  /** 幂：右结合，指数位置允许带符号 */
  function parsePower() {
    const base = parseRadical();
    skipSpace();
    if (text[at] === '^') {
      if (!power) throw fail('未启用幂运算解析，无法使用“^”或“**”');
      at++;
      return Math.pow(base, parseUnary());
    }
    return base;
  }

  /** 一元正负号 */
  function parseUnary() {
    skipSpace();
    const ch = text[at];
    if (ch === '+') { at++; return parseUnary(); }
    if (ch === '-') { at++; return -parseUnary(); }
    return parsePower();
  }

  /** 乘、除、取模 */
  function parseMultiplicative() {
    let v = parseUnary();
    for (;;) {
      skipSpace();
      const ch = text[at];
      if (ch === '*') { at++; v *= parseUnary(); }
      else if (ch === '/') { at++; v = safeDivide(v, parseUnary()); }
      else if (ch === '%') {
        if (!mod) throw fail('未启用模运算解析，无法使用“%”');
        at++;
        v = safeModulo(v, parseUnary());
      } else break;
    }
    return v;
  }

  /** 加、减 */
  function parseAdditive() {
    let v = parseMultiplicative();
    for (;;) {
      skipSpace();
      const ch = text[at];
      if (ch === '+') { at++; v += parseMultiplicative(); }
      else if (ch === '-') { at++; v -= parseMultiplicative(); }
      else break;
    }
    return v;
  }

  const result = parseAdditive();
  skipSpace();
  if (at < text.length) throw fail(`无法识别的字符“${text[at]}”`);
  if (!Number.isFinite(result)) throw new NeonaicArithmeticError(`算式的结果不是有限数：${parseString(source)}`);
  return result;
}