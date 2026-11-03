/**
 * 沙箱结果的剥离器。
 *
 * 为什么必须有它：
 *   `@sebastianwessel/quickjs` 的 `handleToNative` 会把 guest 的值**反向构造为真实宿主对象**
 *   （数组 → `[]`、普通对象 → `{}`、函数 → 宿主闭包、Error → 宿主 `Error` 实例），
 *   并且是用 `Object.defineProperty` 按 guest 提供的键名逐个落属性。也就是说
 *   「宿主对象图的形状」由 guest 决定：键名、嵌套深度、元素个数全都不受控。
 *
 *   这条路径还是**句柄泄漏**的来源：实测 `console.log(function(){})` 这种「把 guest 函数交给宿主
 *   回调」的调用，会让 runtime 释放时 `JS_FreeRuntime` 触发
 *   `Assertion failed: list_empty(&rt->gc_obj_list)` 直接 abort 掉整个进程。
 *   所以约定是：**任何从 guest 回宿主的值都只能是字符串**
 *   （返回值和 console 参数都在 guest 内 `JSON.stringify`），宿主侧再 `JSON.parse`。
 *   这样一来上面的对象反向构造路径根本不会被走到。
 *
 * 本模块负责后半段：把 `JSON.parse` 出来的东西按白名单重建一遍。
 * 它不纠正语义（数字精度、BigInt 之类在 guest 侧就已定形），只保证形状可控：
 * 深度、节点数、数组长度、键数、单串长度都有上限，且危险键名一律丢弃。
 *
 * ⚠️ 体积上限一律按**字节**算。帧传输按字节限长（`framing.js` 的 `MAX_FRAME_BYTES`），
 * 而 `JSON.stringify` 不转义中文：一个中文字符在 UTF-8 下是 3 字节。
 * 早先这里按 `json.length`（字符数）判断，20 万个汉字的中文结果就能撑爆 1MB 的帧，
 * 被父进程判成协议异常并强杀子进程 —— 正常返回大量中文也会踩到。
 */

import { Buffer } from 'node:buffer';

/** 这些键名一旦被当成「普通数据」继续参与合并/赋值，就有原型污染风险 */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * 单次结果在 guest 内的**字符**上限：只是内存护栏，防止在 QuickJS 里拼出巨大字符串。
 * 真正决定帧大小的是下面的 {@link MAX_RESULT_BYTES}。
 */
const MAX_RESULT_CHARS = 512 * 1024;

/**
 * 单次结果序列化后的**字节**上限（UTF-8）。
 *
 * 取 256K 而不是 1M：结果对象会被塞进 `{type,id,ok,data,error,logs,durationMs}` 这一帧里再序列化一次，
 * 里面的 `preview` 字符串还要再转义一遍（`"` → `\"`），最坏会翻倍。
 * 256K 的净载荷留出足够余量让整帧稳定落在 {@link import('./framing.js').aicodeFraming.MAX_FRAME_BYTES} 之下。
 */
const MAX_RESULT_BYTES = 256 * 1024;

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
 * 按 UTF-8 字节截断，且**不切断多字节字符**。
 *
 * 直接按字节切会在中间切出一个残缺序列，落到下游就是 U+FFFD（或者更糟：一帧坏 JSON）。
 * UTF-8 的续字节都以 `10xxxxxx` 开头，往回退到字符首字节即可。
 *
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
function truncateToBytes(text, maxBytes) {
  if (maxBytes <= 0) return '';
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xC0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

/**
 * UTF-8 字节数。
 * @param {string} text
 * @returns {number}
 */
function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * 剥离 + 体积封顶。超过上限时换成 `{ truncated, size, preview }`，
 * 而不是截断出一段残缺 JSON（残缺 JSON 会让模型读不出东西）。
 *
 * `preview` 的长度是**反推**出来的：先按字节上限取一段，再把它塞进结果对象里重新序列化，
 * 确认整块（含 `"` → `\"` 这类转义膨胀）仍然不超限；超了就按 2/3 收缩重试。
 * 这样返回的对象自身体积就是有界的，不会出现「截断后的结果反而更大」。
 *
 * @param {unknown} value
 * @param {number} [maxBytes]
 * @returns {unknown}
 */
function shrinkResult(value, maxBytes = MAX_RESULT_BYTES) {
  const clean = sanitizeResult(value);
  const json = safeStringify(clean);
  if (json === undefined) return { truncated: true, size: 0, preview: '[unserializable]' };
  const total = byteLength(json);
  if (total <= maxBytes) return clean;

  let keep = maxBytes;
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = { truncated: true, size: total, preview: truncateToBytes(json, keep) };
    const text = safeStringify(candidate);
    if (text !== undefined && byteLength(text) <= maxBytes) return candidate;
    keep = Math.floor((keep * 2) / 3);
    if (keep < 1024) break;
  }
  return { truncated: true, size: total, preview: '[result too large]' };
}

export const aicodeSanitize = Object.freeze({
  MAX_RESULT_CHARS,
  MAX_RESULT_BYTES,
  sanitizeResult,
  shrinkResult,
  byteLength,
  truncateToBytes,
});
