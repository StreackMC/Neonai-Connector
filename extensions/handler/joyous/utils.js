/**
 * 带超时的 fetch，避免服务器无响应时长时间挂起。
 * @param {string} url
 * @param {number} timeout
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 将任意值转为可读字符串：
 *   对象优先取语义字段（name / clean / raw / text），否则 JSON 化；
 *   原始类型直接转字符串。
 * @param {*} v
 * @returns {string}
 */
export function valToString(v) {
  if (v == null) return '';
  if (typeof v !== 'object') return String(v);
  if (v.name) return String(v.name);
  if (v.clean) return String(v.clean);
  if (v.raw) return String(v.raw);
  if (v.text) return String(v.text);
  return JSON.stringify(v);
}

/** 时间戳（毫秒）转为中文式 YYYY-MM-DD HH:mm:ss（本地时区，24 小时制） */
export function formatDateTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}