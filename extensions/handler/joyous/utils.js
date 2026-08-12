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

/**
 * 将 Minecraft 刻数转换为 24 小时制时间
 * @param {number} tick - 游戏刻数（0~24000）
 * @returns {[number, number]} - [小时, 分钟] 24小时制
 */
export function formatMcTime(tick) {
  // 1. 取余，确保在 0~23999 范围内
  const dayTick = Math.floor(tick) % 24000;

  // 2. 加上偏移量（0刻 = 6:00），得到从午夜开始的总分钟数
  //    24000刻 = 1440分钟（现实一天）
  //    每分钟 = 24000/1440 = 16.666...刻 ≈ 50/3 刻
  //    所以 6:00 = 6 * 60 = 360分钟，对应刻数 = 360 * (50/3) = 6000
  const totalMinutes = (dayTick + 6000) / (24000 / 1440);
  // 等价于：const totalMinutes = (dayTick + 6000) * 0.06;
  // 因为 1440 / 24000 = 0.06

  // 3. 提取小时和分钟，并向下取整
  let hours = Math.floor(totalMinutes / 60);
  let minutes = Math.floor(totalMinutes % 60);

  // 4. 确保 24 小时制（0~23）
  hours = hours % 24;

  return [hours, minutes];
}