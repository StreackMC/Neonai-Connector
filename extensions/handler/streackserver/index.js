/**
 * extensions/handler/streackserver — Streack 服务器状态查询扩展
 *
 * 通过扩展加载器（system/extensionLoader.js）自动发现：
 *   启动时扫描 extensions/handler/<name>/index.js 并动态 import，
 *   本模块在 import 时即注册 "mc" 命令（命名空间 streackserver），无需在入口硬编码。
 *
 * 行为：
 *   - 命令 "mc" 向 ADDRESS 发起状态查询；
 *   - 查询成功：根据返回数据格式化展示；
 *   - 查询失败（网络错误 / 超时 / 接口非 2xx / 显式 offline）：显示 "× 服务器离线"。
 */

import { registerCommand } from '../../../src/handler/commandServer.js';
import { getBotName } from '../../../src/system/conf.js';
import { getLogger } from '../../../src/system/logger/logger.js';

/** 服务器状态接口地址（查询目标） */
const ADDRESS = 'http://localhost:8080/api/status';

/** 请求超时（毫秒） */
const TIMEOUT_MS = 5000;

/** 展示玩家列表的最大数量，最小1 */
const MAX_PLAYER_LISTED = 3;

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

/** TPS 数值格式化：负数（如 -1 表示无数据）显示为 N/A */
function fmtTps(v) {
  return (typeof v === 'number' && v >= 0) ? v.toFixed(1) : 'N/A';
}

/**
 * 断言数据存在并尝试插入数组
 * @template T
 * @template V
 * @param {(value:T) => V} func 数据存在时的函数，如果数据存在会把返回值插入数组中
 * @param {T|null|undefined} which 数据
 * @param {Array<V>} array 目标数组
 * @returns {number} 插入后目标数组的长度；插入失败为 -1 。
 */
function assertDataAndInsert(which, func, array) {
  if (!(array instanceof Array) || (!(typeof func === 'function')) || !which) return -1;
  return array.push(func.call(this, which));
}

/**
 * 将状态数据格式化为可读文本。
 * 兼容常见 Minecraft / 通用状态接口字段；未知结构退化为逐字段展示。
 * @param {any} data
 * @returns {string}
 */
function formatStatus(data) {
  if (data == null) return '“栈流Streack”可能正在运行；没有可用的额外信息。';

  if (!data.online) {
    return `“栈流Streack”已离线；如果这不是计划维护，请向 Staff 报告。`;
  }

  const lines = ["“栈流Streack”正在运行；"];

  // TPS
  if (data?.tps?.avg_5m) lines.push(`最近5分钟的TPS：${data?.tps?.avg_5m}`);

  // 玩家列表
  if (data?.players?.max && data?.players?.online) {
    lines.push(`在线冒险家：${data?.players?.online}/${data?.players?.max}`);
    if (data?.players?.list instanceof Array) {
      let playerListText = [];
      for (let index = 0; index < data.players.list.length; index++) {
        // 枚举可展示玩家
        const player = data.players.list[index];
        if (player?.name?.text) playerListText.push("→ " + player.name.text);
        if (playerListText.length >= MAX_PLAYER_LISTED) {
          // 达到展示上限
          if (index < (data.players.list.length - 1)) {
            // 说明不是最后一个，计算余下量
            playerListText.push(`……以及另外${data.players.list.length - playerListText.length}位冒险家`);
          }
          break;
        }
      }
      lines.push(...playerListText, "");
    }
  }

  // 时间
  if (data?.expires_at) {
    lines.push(`下次更新应晚于${formatDateTime(data.expires_at)}。`);
  }

  return lines.join('\n');
}

/**
 * 命令 "mc" — 查询 Streack 服务器状态（命名空间 streackserver）。
 * 查询失败（网络错误 / 超时 / 接口非 2xx / 显式离线）一律返回 "× 服务器离线"。
 */
registerCommand('streackserver', 'mc', async function () {
  try {
    const res = await fetchWithTimeout(ADDRESS, TIMEOUT_MS);
    if (!res.ok) {
      getLogger().main.warn(`[mc] 状态接口返回非 2xx: ${res.status}`);
      return formatStatus({ online: false, retrieved_at: new Date().getTime(), expires_at: new Date().getTime() });
    }

    const text = await res.text();
    if (!text.trim()) return formatStatus({ online: false, retrieved_at: new Date().getTime(), expires_at: new Date().getTime() });

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // 非 JSON：原样作为在线信息展示
      return `${formatStatus({ online: false, retrieved_at: new Date().getTime(), expires_at: new Date().getTime() })}\n以下附加信息可能会起作用：${text.trim()}`;
    }
    return formatStatus(data);
  } catch (err) {
    // 网络错误 / 超时（AbortError）/ DNS 失败等
    getLogger().main.warn(`[mc] 查询服务器状态失败: ${err.message}`);
    return `“${getBotName()}”无法查询“栈流Streack”的状态，因为“${err.message}”。`;
  }
}, { description: '查询 Streack 服务器在线状态', usage: 'mc' });
