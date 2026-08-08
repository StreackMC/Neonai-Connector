/**
 * commandServer.js — 命令注册与执行引擎（纯逻辑，无 UI 依赖）
 *
 * 提供：
 *   registerCommand(name, handler, opts) — 注册命令（含权限）
 *   executeCommand(cmdName, ctx, ...args) — 执行 + auto-catch
 *   executeCommandSilent(cmdName, ctx, ...args) — 执行 + throw
 *   parseArgs(input) / inferNext(input) / getCommands() — 工具
 *
 * 权限：
 *   opts.permissions: "perm" (须拥有) | "!perm" (须缺失) | ["perm", "!other"]
 *   所有条件须同时满足。CLI 发起时 internalCall=true，跳过权限检查。
 *
 * 上下文（传入 handler 的 this）：
 *   { executor, internalCall, timestamp, this: originalThis }
 */

import { checkPermission } from './permissionServer.js';
import { getLogger } from '../system/logger/logger.js';

// ---- 颜色 ----
const RED   = '\x1b[31m';
const CYAN  = '\x1b[36m';
const DIM   = '\x1b[2m';
const BOLD  = '\x1b[1m';
const R     = '\x1b[0m';

/** @type {Map<string, { handler: Function, permissions: string[], description?: string, usage?: string }>} */
const commands = new Map();

// ---- 参数解析 ----

/** 按 POSIX 标准解析参数 */
export function parseArgs(input) {
  const args = [];
  let current = '', inSingle = false, inDouble = false, escape = false;

  for (const ch of input) {
    if (escape) {
      if (inDouble && ch !== '"' && ch !== '\\') current += '\\';
      current += ch; escape = false; continue;
    }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === ' ' && !inSingle && !inDouble) {
      if (current.length > 0) { args.push(current); current = ''; }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) args.push(current);
  return args;
}

// ---- 注册 ----

/**
 * @param {string} name
 * @param {(...args) => any} handler 参数以 ...args 展开传入，this 为命令上下文。**箭头函数无法接收上下文，需要使用<code>function() {}</code>**
 * @param {object} [opts]
 * @param {string|string[]} [opts.permissions] 权限。"perm" 须拥有，"!perm" 须缺失
 * @param {string} [opts.description]
 * @param {string} [opts.usage]
 * @this {CommandContext}
 */
export function registerCommand(name, /** @this {CommandContext} */handler, opts = {}) {
  if (commands.has(name)) throw new Error(`命令 "${name}" 已被注册`);
  const perms = opts.permissions
    ? (Array.isArray(opts.permissions) ? opts.permissions : [opts.permissions])
    : [];
  commands.set(name, { handler, permissions: perms, description: opts.description, usage: opts.usage });
}

// ---- 校验 ----

/**
 * @param {string} cmdName
 * @param {string|string[]|undefined} executor
 * @returns {string|null} 校验失败原因，成功返回 null
 */
export function checkCommandPerms(cmdName, executor) {
  let requiredPerms = commands.get(cmdName).permissions;
  if (!requiredPerms.length) return null; // 无权限要求

  for (const perm of requiredPerms) {
    const isNegate = perm.startsWith('!');
    const permName = isNegate ? perm.slice(1) : perm;
    const hasPerm = checkPermission(executor, permName);

    if (isNegate) {
      // "!perm" → 必须不拥有（即 checkPermission 返回 false 或 null）
      if (hasPerm !== false && hasPerm !== null) {
        return `缺少权限: ${perm}（须缺失）`;
      }
    } else {
      // "perm" → 必须拥有
      if (hasPerm !== true) {
        return `缺少权限: ${perm}`;
      }
    }
  }
  return null;
}

/**
 * 获取是否存在目标命令
 * @param {string} cmd 命令
 * @returns {boolean}
 */
export function hasCommand(cmd) { return commands.includes(cmd); };

// ---- 错误格式化 ----

function buildError(cmdName, reason, usage) {
  return usage
    ? `${BOLD}${cmdName}${R}${RED}: ${reason}${R}\n${DIM}用法: ${CYAN}${usage}${R}`
    : `${BOLD}${cmdName}${R}${RED}: ${reason}${R}`;
}

// ---- 执行 ----

/**
 * @typedef {Object} CommandContext
 * @property {string[]|string} executor 执行者
 * @property {boolean} internalCall 命令调用是否来自内部：来自内部的命令会绕过权限检查
 * @property {Date} timestamp 命令开始执行时的时间
 * @property {Object|undefined} this 命令执行时上下文，可以透传类对象。
 */

/**
 * 执行命令（自动 catch，错误打印到终端）。
 * @param {string} cmdName 命令名
 * @param {CommandContext} [ctx] 上下文，无法设置 timestamp 属性
 * @param {...*} args 命令参数（调用方负责解析）
 * @returns {*|Promise<*>}
 */
export function executeCommand(cmdName, ctx, ...args) {
  try {
    return executeCommandSilent(cmdName, ctx, ...args);
  } catch (err) {
    getLogger().cmd.error(err.message);
  }
}

/**
 * 执行命令（不 catch，throw 错误）。
 * @param {string} cmdName 命令名
 * @param {CommandContext} [ctx] 上下文，无法设置 timestamp 属性
 * @param {...*} args 命令参数
 * @returns {*|Promise<*>}
 * @throws {Error}
 */
export function executeCommandSilent(cmdName, ctx = {}, ...args) {
  if (typeof cmdName !== 'string' || !cmdName) return;

  const meta = commands.get(cmdName);

  if (!meta) {
    throw new Error(buildError(cmdName, '未知命令'));
  }

  const executor = ctx.executor;
  const internalCall = !!ctx.internalCall;
  const originalThis = ctx.this;

  // 权限检查：CLI / 内部调用跳过
  if (!internalCall && executor) {
    const permErr = checkCommandPerms(cmdName, executor);
    if (permErr) {
      throw new Error(buildError(cmdName, permErr));
    }
  }

  // 构建执行上下文
  const context = {
    executor: executor ?? undefined,
    internalCall,
    timestamp: new Date(),
    this: originalThis,
  };

  try {
    return meta.handler.call(context, ...args);
  } catch (err) {
    throw new Error(buildError(cmdName, `执行失败: ${err.message}`));
  }
}

// ---- TAB 建议 ----

export function inferNext(input) {
  const trimmed = input.trimStart();
  if (!trimmed || trimmed.includes(' ')) return { hits: [], prefix: trimmed };
  const hits = [...commands.keys()].filter(n => n.startsWith(trimmed));
  return { hits, prefix: trimmed };
}

// ---- 工具 ----

export function getCommands() { return commands; }

// ---- 内置命令 ----

registerCommand('help', function () {
  /** @type {CommandContext} */
  const ctx = this;// 箭头函数无法透传this，手动传一下
  const names = [...commands.keys()].filter((v) => {
    // 过滤掉无权限命令
    return checkCommandPerms(v, ctx.executor);
  }).sort();
  return names.join(', ') || '暂无注册命令';
}, { description: '显示可用命令列表' });
