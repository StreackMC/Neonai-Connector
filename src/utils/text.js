import { neonaicConfManager } from '../system/confManager.js';

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