/**
 * extensions/handler/joyous — Streack Joyous For Neonaic
 * 
 * Joyous插件与Neonaic衔接模块
 */

// -- 常量 --
/** 默认服务器状态接口地址（查询目标） */
const DEFAULT_ADDRESS = 'http://localhost:8080/api/status';
/** 默认服务器名称（查询目标） */
const DEFAULT_SRVNAME = '栈流Streack';
/** 请求超时（毫秒） */
const TIMEOUT_MS = 5000;
/** 展示玩家列表的最大数量，最小1 */
const MAX_PLAYER_LISTED = 3;

import z from 'zod';
import { registerAITool } from '../../../src/handler/ai.js';
// -- import --
import { registerCommand } from '../../../src/handler/commandServer.js';
import { getBotName } from '../../../src/system/conf.js';
import { getLogger } from '../../../src/system/logger/logger.js';
import { fetchWithTimeout, valToString, formatDateTime, formatMcTime } from "./utils.js";

// -- Tools --
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
 * @param {Object} data
 * @param {String} name 
 * @returns {string}
 */
function formatStatus(data, name) {
  if (data == null) return `“${name}”可能正在运行；没有可用的额外信息。`;

  if (!data.online) {
    return `“${name}”已离线；如果这不是计划维护，请向 Staff 报告。`;
  }

  const lines = [`“${name}”正在运行；`];

  // TPS
  if (data?.tps?.avg_5m) lines.push(`最近5分钟的TPS：${data?.tps?.avg_5m}`);

  // 玩家列表
  if (data?.players?.max != null && data?.players?.online != null) {
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

// -- API --

/**
 * 查询 Streack 服务器状态（命名空间 streackserver）；
 * 查询失败（网络错误 / 超时 / 接口非 2xx / 显式离线）一律返回 "× 服务器离线"。
 */
registerCommand('joyous', 'mc', async function (address) {
  try {
    const res = await fetchWithTimeout(address || DEFAULT_ADDRESS, TIMEOUT_MS);
    if (!res.ok) {
      getLogger().main.warn(`[mc] 状态接口返回非 2xx: ${res.status}`);
      return formatStatus({ online: false, retrieved_at: new Date().getTime(), expires_at: new Date().getTime() }, address || DEFAULT_SRVNAME);
    }

    const text = await res.text();
    if (!text.trim()) return formatStatus({ online: false, retrieved_at: new Date().getTime(), expires_at: new Date().getTime() }, address || DEFAULT_SRVNAME);

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // 非 JSON：原样作为在线信息展示
      return `${formatStatus({ online: false, retrieved_at: new Date().getTime(), expires_at: new Date().getTime() }, address || DEFAULT_SRVNAME)}\n以下附加信息可能会起作用：${text.trim()}`;
    }
    return formatStatus(data);
  } catch (err) {
    // 网络错误 / 超时（AbortError）/ DNS 失败等
    getLogger().main.warn(`[mc] 查询服务器状态失败: ${err.message}`);
    return `“${getBotName()}”无法查询“${address || DEFAULT_SRVNAME}”的状态，因为“${err.message}”。`;
  }
}, {
  description: '查询 Minecraft 服务器在线状态',
  usage: 'mc',
  permissions: [],
});

registerAITool("joyous", "worldMeta", {
  description: "查询世界天气状况与时间情况。默认从 " + DEFAULT_ADDRESS + " 处获取数据。",
  inputSchema: z.object({
    address: z.string().describe("数据来源，需要是Joyous StatusAPI格式。"),
  }),
  execute: async ({ address }) => {
    try {
      const res = await fetchWithTimeout(address || DEFAULT_ADDRESS, TIMEOUT_MS);
      if (!res.ok) {
        getLogger().main.warn(`[mc] 状态接口返回非 2xx: ${res.status}`);
        return "无法获取，接口响应不对。";
      }

      let data;
      try {
        data = JSON.parse(await res.text());
      } catch {
        // 非 JSON：原样作为在线信息展示
        return "无法获取，接口返回数据格式错误。";
      }
      if (data?.worlds?.world) {
        return (data?.worlds?.world?.has_storm ? "正在下雨雪，" : "未在下雨雪，")
          + (data?.worlds?.world?.is_thundering ? "正在打雷，" : "未在打雷，")
          + (data?.worlds?.world?.inday_time ? `现在是24小时制的${formatMcTime(data?.worlds?.world?.inday_time).join(':')}` : "时间未知。");
      } else if (data?.worlds?.overworld) {
        return ``;
      } else return "接口没有返回该信息。";
    } catch (err) {
      // 网络错误 / 超时（AbortError）/ DNS 失败等
      getLogger().main.warn(`[mc] 查询服务器状态失败: ${err.message}`);
      return "无法获取，请求失败。";
    }
  },
});