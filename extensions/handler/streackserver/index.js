/**
 * extensions/handler/streackserver — Streack 服务器状态查询扩展
 *
 * 通过扩展加载器（system/extensionLoader.js）自动发现：
 *   启动时扫描 extensions/handler/<name>/index.js 并动态 import，
 *   本模块在 import 时即注册 "mc" 命令，无需在入口硬编码。
 *
 * 行为：
 *   - 命令 "mc" 向 ADDRESS 发起状态查询；
 *   - 查询成功：根据返回数据格式化展示；
 *   - 查询失败（网络错误 / 超时 / 接口非 2xx / 显式 offline）：显示 "× 服务器离线"。
 */

import { registerCommand } from '../../../src/handler/commandServer.js';
import { getLogger } from '../../../src/system/logger/logger.js';

/** 服务器状态接口地址（查询目标） */
const ADDRESS = 'http://localhost:8080/api/status';

/** 请求超时（毫秒） */
const TIMEOUT_MS = 5000;

/**
 * 带超时的 fetch，避免服务器无响应时长时间挂起。
 * @param {string} url
 * @param {number} timeout
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, timeout) {
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
function valToString(v) {
  if (v == null) return '';
  if (typeof v !== 'object') return String(v);
  if (v.name) return String(v.name);
  if (v.clean) return String(v.clean);
  if (v.raw) return String(v.raw);
  if (v.text) return String(v.text);
  return JSON.stringify(v);
}

/** 时间戳（毫秒）转为中文式 YYYY-MM-DD HH:mm:ss（本地时区，24 小时制） */
function formatDateTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 字节数转为易读单位（自动 GB / MB / KB） */
function formatBytes(bytes) {
  if (typeof bytes !== 'number') return valToString(bytes);
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / 1024 ** 2;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/** TPS 数值格式化：负数（如 -1 表示无数据）显示为 N/A */
function fmtTps(v) {
  return (typeof v === 'number' && v >= 0) ? v.toFixed(1) : 'N/A';
}

/**
 * 将状态数据格式化为可读文本。
 * 兼容常见 Minecraft / 通用状态接口字段；未知结构退化为逐字段展示。
 * @param {any} data
 * @returns {string}
 */
function formatStatus(data) {
  if (data == null) return '✓ 服务器在线（无附加信息）';

  // 显式离线标记（接口返回但声明离线）
  if (data.online === false || data.state === 'offline' || data.status === 'offline') {
    return '× 服务器离线';
  }

  const lines = [];
  const online = data.online === true || data.state === 'online' || data.status === 'online';
  lines.push(online ? '✓ 服务器在线' : '✓ 服务器状态');

  if (data.version != null) lines.push(`版本: ${valToString(data.version)}`);
  if (data.host != null) lines.push(`地址: ${data.host}${data.port != null ? ':' + data.port : ''}`);

  // 玩家信息：可能嵌套在 players 对象或扁平字段
  const players = data.players;
  if (players && typeof players === 'object') {
    const now = players.online ?? players.now ?? players.current;
    const max = players.max ?? players.maxPlayers;
    if (now != null || max != null) lines.push(`玩家: ${now ?? '?'} / ${max ?? '?'}`);
  } else if (players != null) {
    lines.push(`玩家: ${players}`);
  }

  if (data.motd != null) lines.push(`MOTD: ${valToString(data.motd)}`);
  else if (data.description != null) lines.push(`简介: ${valToString(data.description)}`);

  if (data.latency != null || data.ping != null) {
    lines.push(`延迟: ${data.latency ?? data.ping} ms`);
  }

  // 内存（已用 / 上限 + 占用率）
  const memory = data.memory;
  if (memory && typeof memory === 'object' && memory.used != null && memory.max != null) {
    const pct = memory.max ? Math.round((memory.used / memory.max) * 100) : '?';
    lines.push(`内存: ${formatBytes(memory.used)} / ${formatBytes(memory.max)}（占用 ${pct}%）`);
  } else if (memory != null) {
    lines.push(`内存: ${valToString(memory)}`);
  }

  // 更新时间（retrieved_at，毫秒时间戳 → 中文式时间）
  if (data.retrieved_at != null) {
    const ts = typeof data.retrieved_at === 'number' ? data.retrieved_at : Date.parse(data.retrieved_at);
    if (!Number.isNaN(ts)) lines.push(`更新时间: ${formatDateTime(ts)}`);
  }

  // TPS（实时 / 1m / 5m / 15m 均值）
  const tps = data.tps;
  if (tps && typeof tps === 'object') {
    lines.push(`TPS: 实时 ${fmtTps(tps.live)} | 1m ${fmtTps(tps.avg_1m)} | 5m ${fmtTps(tps.avg_5m)} | 15m ${fmtTps(tps.avg_15m)}`);
  } else if (tps != null) {
    lines.push(`TPS: ${valToString(tps)}`);
  }

  // 兜底：未识别字段附加展示（expires_at 等冗余字段不展示）
  const known = new Set([
    'online', 'state', 'status', 'version', 'host', 'port', 'players', 'motd', 'description',
    'latency', 'ping', 'memory', 'retrieved_at', 'tps', 'expires_at',
  ]);
  const extra = Object.entries(data).filter(([k]) => !known.has(k));
  if (extra.length) {
    lines.push('其他:');
    for (const [k, v] of extra) lines.push(`  ${k}: ${valToString(v)}`);
  }

  return lines.join('\n');
}

/**
 * 命令 "mc" — 查询 Streack 服务器状态。
 * 查询失败（网络错误 / 超时 / 接口非 2xx / 显式离线）一律返回 "× 服务器离线"。
 */
registerCommand('mc', async function () {
  try {
    const res = await fetchWithTimeout(ADDRESS, TIMEOUT_MS);
    if (!res.ok) {
      getLogger().main.warn(`[mc] 状态接口返回非 2xx: ${res.status}`);
      return '× 服务器离线';
    }

    const text = await res.text();
    if (!text.trim()) return '× 服务器离线';

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // 非 JSON：原样作为在线信息展示
      return `✓ 服务器在线\n${text.trim()}`;
    }
    return formatStatus(data);
  } catch (err) {
    // 网络错误 / 超时（AbortError）/ DNS 失败等
    getLogger().main.warn(`[mc] 查询服务器状态失败: ${err.message}`);
    return '× 服务器离线';
  }
}, { description: '查询 Streack 服务器在线状态', usage: 'mc' });
