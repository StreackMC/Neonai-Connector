/**
 * src/status.js — 状态业务层
 *
 * 这里放的是**业务语义**：把 Joyous StatusAPI 的 JSON 渲染成给人/给模型看的文本。
 * 它刻意不认识 HTTP，也不认识 UDS —— 只依赖一个注入的 `query(address)` 函数，
 * 由组合根（entry.js）决定这个查询究竟走 HTTP 还是走 UDS。
 *
 * 这样切分之后，「加一种新传输」不需要碰本文件，而「改一段文案」也不需要碰协议层。
 */

import { neonaicConfManager } from '../../../src/system/confManager.js';
import { NeonaicNewable } from '../../../src/utils/NeonaicNewableClass.js';
import { NeonaicIllegalArgumentError } from '../../../src/utils/NeonaicNewableError.js';
import { formatDateTime, formatMcTime, valToString } from './utils.js';

/**
 * 状态查询结果。
 * @typedef {{ ok: true, data: object } | { ok: false, reason: 'offline'|'invalid'|string }} StatusResult
 */

/**
 * 状态查询函数契约。
 * @callback StatusQuery
 * @param {string} address 目标地址
 * @returns {Promise<StatusResult>}
 */

/**
 * 把 StatusAPI 数据渲染为可读文本。
 * 兼容常见 Minecraft / 通用状态接口字段；未知结构退化为逐字段展示。
 * @param {object|null} data
 * @param {string} name 展示用服务器名
 * @param {number} [maxPlayerListed=3] 最多列出的玩家数
 * @returns {string}
 */
export function formatStatus(data, name, maxPlayerListed = 3) {
  if (data == null) return `“${name}”可能正在运行；没有可用的额外信息。`;
  if (!data.online) return `“${name}”已离线；如果这不是计划维护，请向 Staff 报告。`;

  const lines = [`“${name}”正在运行；`];

  // TPS
  if (data?.tps?.avg_5m != null) lines.push(`最近5分钟的TPS：${data.tps.avg_5m}`);

  // 玩家列表
  const list = data?.players?.list;
  if (data?.players?.max != null && data?.players?.online != null) {
    lines.push(`在线冒险家：${data.players.online}/${data.players.max}`);
    if (Array.isArray(list) && list.length > 0) {
      const shown = [];
      for (let index = 0; index < list.length && shown.length < maxPlayerListed; index++) {
        const label = valToString(list[index]?.name);
        if (label) shown.push(`→ ${label}`);
      }
      if (shown.length > 0) {
        const rest = list.length - shown.length;
        if (rest > 0) shown.push(`……以及另外${rest}位冒险家`);
        lines.push(...shown, '');
      }
    }
  }

  // 时间
  if (data?.expires_at) lines.push(`下次更新应晚于${formatDateTime(data.expires_at)}。`);

  return lines.join('\n');
}

/**
 * 把世界信息渲染为可读文本。
 * @param {object|null} data StatusAPI 数据
 * @returns {string}
 */
export function formatWorldMeta(data) {
  const world = data?.worlds?.world ?? data?.worlds?.overworld;
  if (!world) return '接口没有返回该信息。';
  const time = world.inday_time != null
    ? `现在是24小时制的${formatMcTime(world.inday_time).join(':')}`
    : '时间未知。';
  return (world.has_storm ? '正在下雨雪，' : '未在下雨雪，')
    + (world.is_thundering ? '正在打雷，' : '未在打雷，')
    + time;
}

/**
 * 把查询结果渲染为面向用户/模型的文本。
 * @param {StatusResult} result
 * @param {string} name 展示用服务器名
 * @param {string} botName 机器人名
 * @param {number} [maxPlayerListed=3]
 * @returns {string}
 */
export function renderStatus(result, name, botName, maxPlayerListed = 3) {
  if (result.ok) return formatStatus(result.data, name, maxPlayerListed);
  if (result.reason === 'offline') return formatStatus({ online: false }, name, maxPlayerListed);
  if (result.reason === 'invalid') {
    return `“${botName}”无法查询“${name}”的状态，因为返回的数据不符合“Joyous StatusAPI”的格式。`;
  }
  return `“${botName}”无法查询“${name}”的状态，因为“${result.reason}”。`;
}

/**
 * 状态读取器：把「查询传输」与「文本渲染」拼装起来。
 */
export class NeonaicStatusReader extends NeonaicNewable {
  static type = 'joyous.status';

  /** @type {StatusQuery} */
  #query;
  /** @type {string} */
  #serverName;
  /** @type {number} */
  #maxPlayerListed;
  /** @type {() => string} */
  #botName;

  /**
   * @param {object} options
   * @param {StatusQuery} options.query 查询实现（HTTP / UDS 由组合根决定）
   * @param {string} options.serverName 缺省展示名
   * @param {number} [options.maxPlayerListed=3]
   * @param {() => string} [options.botName] 机器人名提供者；缺省从内核配置读取
   */
  constructor(options = {}) {
    super();
    const { query, serverName, maxPlayerListed = 3, botName } = options;

    if (typeof query !== 'function') {
      throw new NeonaicIllegalArgumentError('状态读取器必须提供 query 查询函数');
    }
    if (typeof serverName !== 'string' || !serverName) {
      throw new NeonaicIllegalArgumentError('状态读取器必须提供 serverName');
    }

    this.#query = query;
    this.#serverName = serverName;
    this.#maxPlayerListed = maxPlayerListed;
    this.#botName = typeof botName === 'function' ? botName : () => neonaicConfManager.getBotName();
  }

  /** 缺省展示名 @returns {string} */
  get serverName() { return this.#serverName; }

  /**
   * 解析「地址或服务器名」参数。
   * @apiNote 沿用既有语义：传了地址就把它同时当作展示名，否则用缺省服务器名。
   * @param {string} [address]
   * @returns {{ address: string, name: string }}
   */
  resolveTarget(address) {
    const addr = typeof address === 'string' && address.trim() ? address.trim() : '';
    return { address: addr, name: addr || this.#serverName };
  }

  /**
   * 拉取原始状态数据。
   * @param {string} [address]
   * @returns {Promise<StatusResult>}
   */
  read(address) {
    const { address: target } = this.resolveTarget(address);
    return this.#query(target);
  }

  /**
   * 渲染服务器整体状态文本（`joyous:mc` 命令与 `serverStatus` AI 工具使用）。
   * @param {string} [address]
   * @returns {Promise<string>}
   */
  async describeServer(address) {
    const { address: target, name } = this.resolveTarget(address);
    const result = await this.#query(target);
    return renderStatus(result, name, this.#botName(), this.#maxPlayerListed);
  }

  /**
   * 渲染世界（天气 / 时间）文本（`worldMeta` AI 工具使用）。
   * @param {string} [address]
   * @returns {Promise<string>}
   */
  async describeWorld(address) {
    const { address: target } = this.resolveTarget(address);
    const result = await this.#query(target);
    if (!result.ok) {
      return result.reason === 'invalid'
        ? '无法获取，接口返回数据格式错误。'
        : '无法获取，请求失败。';
    }
    return formatWorldMeta(result.data);
  }
}
