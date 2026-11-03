/**
 * 沙箱结果的剥离器。
 *
 * 为什么必须有它：
 *   `@sebastianwessel/quickjs` 的 `handleToNative` 会把 guest 的值**反向构造为真实宿主对象**
 *   （数组 → `[]`、普通对象 → `{}`、函数 → 宿主闭包、Error → 宿主 `Error` 实例），
 *   并且是用 `Object.defineProperty` 按 guest 提供的键名逐个落属性。也就是说
 *   「宿主对象图的形状」由 guest 决定：键名、嵌套深度、元素个数全都不受控。
 *
 *   这条路径还实测出一个副作用：`handleToNative` 处理**任何**非原始值时都会漏掉句柄，
 *   导致 QuickJS runtime 无法释放，最终在 `JS_FreeRuntime` 触发
 *   `Assertion failed: list_empty(&rt->gc_obj_list)` 直接 abort 掉整个进程。
 *   所以现在的约定是：guest 只准回一个**字符串**（在 guest 内部 `JSON.stringify`），
 *   宿主侧再 `JSON.parse`。这样一来上面的对象反向构造路径根本不会被走到。
 *
 * 本模块负责后半段：把 `JSON.parse` 出来的东西按白名单重建一遍。
 * 它不纠正语义（数字精度、BigInt 之类在 guest 侧就已定形），只保证形状可控：
 * 深度、节点数、数组长度、键数、单串长度都有上限，且危险键名一律丢弃。
 */

/** 这些键名一旦被当成「普通数据」继续参与合并/赋值，就有原型污染风险 */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** 单次结果的字符上限（序列化后）。父进程与子进程各自都会再收一次。 */
const MAX_RESULT_CHARS = 512 * 1024;

const LIMITS = Object.freeze({
  maxDepth: 8,
  maxNodes: 4000,
  maxArrayLength: 500,
  maxKeys: 200,
  maxStringLength: 128 * 1024,
});

/**
 * 序列化；失败时返回 undefined（循环引用、BigInt、getter 抛错等）。
 * @param {unknown} value
 * @returns {string|undefined}
 */
function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} value
 * @param {{ nodes: number, seen: WeakSet<object> }} state
 * @param {number} depth
 * @returns {unknown}
 */
function sanitize(value, state, depth) {
  if (value === null || value === undefined) return value ?? null;
  const type = typeof value;

  if (type === 'string') {
    state.nodes++;
    if (value.length <= LIMITS.maxStringLength) return value;
    return `${value.slice(0, LIMITS.maxStringLength)}…[truncated]`;
  }
  if (type === 'number') {
    state.nodes++;
    // NaN / Infinity 不是合法 JSON，统一折成 null，避免下游 JSON.stringify 又把它们变成 null 时「静默变形」
    return Number.isFinite(value) ? value : null;
  }
  if (type === 'boolean') {
    state.nodes++;
    return value;
  }
  if (type === 'bigint') {
    state.nodes++;
    return value.toString();
  }
  if (type === 'function' || type === 'symbol') return null;

  // 对象
  if (state.nodes >= LIMITS.maxNodes) return '[nodes truncated]';
  if (depth >= LIMITS.maxDepth) return '[depth truncated]';
  if (state.seen.has(value)) return '[circular]';

  state.nodes++;
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      const length = Math.min(value.length, LIMITS.maxArrayLength);
      const out = new Array(length);
      for (let i = 0; i < length; i++) out[i] = sanitize(value[i], state, depth + 1);
      if (value.length > length) out.push(`[+${value.length - length} more]`);
      return out;
    }

    const out = {};
    let count = 0;
    for (const key of Object.keys(value)) {
      if (DANGEROUS_KEYS.has(key)) continue;
      if (count >= LIMITS.maxKeys) {
        Object.defineProperty(out, '…', {
          value: '[keys truncated]', enumerable: true, writable: true, configurable: true,
        });
        break;
      }
      const child = sanitize(value[key], state, depth + 1);
      // 用 defineProperty 直接落自有属性：不经过任何原型链上的 setter
      Object.defineProperty(out, key, {
        value: child, enumerable: true, writable: true, configurable: true,
      });
      count++;
    }
    return out;
  } finally {
    state.seen.delete(value);
  }
}

/**
 * 把任意值重建为「只含原始类型 + 普通数组/对象」的结构。
 * @param {unknown} value
 * @returns {unknown}
 */
function sanitizeResult(value) {
  return sanitize(value, { nodes: 0, seen: new WeakSet() }, 0);
}

/**
 * 剥离 + 体积封顶。超过上限时换成 `{ truncated, size, preview }`，
 * 而不是截断出一段残缺 JSON（残缺 JSON 会让模型读不出东西）。
 * @param {unknown} value
 * @param {number} [maxChars]
 * @returns {unknown}
 */
function shrinkResult(value, maxChars = MAX_RESULT_CHARS) {
  const clean = sanitizeResult(value);
  const json = safeStringify(clean);
  if (json === undefined) return { truncated: true, size: 0, preview: '[unserializable]' };
  if (json.length <= maxChars) return clean;
  return { truncated: true, size: json.length, preview: json.slice(0, maxChars) };
}

export const aicodeSanitize = Object.freeze({
  MAX_RESULT_CHARS,
  sanitizeResult,
  shrinkResult,
});
