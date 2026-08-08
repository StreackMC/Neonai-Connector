/**
 * commandServer.js — 命令注册与执行引擎（纯逻辑，无 UI 依赖）
 *
 * 提供：
 *   registerCommand(name, handler, opts) — 注册命令（含权限）
 *   executeCommand(input, ctx, ...params) — 执行 + auto-catch
 *   executeCommandSilent(input, ctx, ...params) — 执行 + throw
 *   inferNext(input) / getCommands() — 补全 & 工具
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
 * @param {(...args: string[]) => any} handler 参数以 ...args 展开传入，this 为命令上下文
 * @param {object} [opts]
 * @param {string|string[]} [opts.permissions] 权限。"perm" 须拥有，"!perm" 须缺失
 * @param {string} [opts.description]
 * @param {string} [opts.usage]
 */
export function registerCommand(name, handler, opts = {}) {
  if (commands.has(name)) throw new Error(`命令 "${name}" 已被注册`);
  const perms = opts.permissions
    ? (Array.isArray(opts.permissions) ? opts.permissions : [opts.permissions])
    : [];
  commands.set(name, { handler, permissions: perms, description: opts.description, usage: opts.usage });
}

// ---- 权限校验 ----

/**
 * @param {string} cmdName
 * @param {string[]} requiredPerms
 * @param {string|string[]|undefined} executor
 * @returns {string|null} 校验失败原因，成功返回 null
 */
function checkCommandPerms(cmdName, requiredPerms, executor) {
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

// ---- 错误格式化 ----

function buildError(cmdName, reason, usage) {
  return usage
    ? `${BOLD}${cmdName}${R}${RED}: ${reason}${R}\n${DIM}用法: ${CYAN}${usage}${R}`
    : `${BOLD}${cmdName}${R}${RED}: ${reason}${R}`;
}

// ---- 执行（公开 API）----

/**
 * 执行命令（自动 catch，错误打印到终端）。
 * @param {string} input
 * @param {object} [ctx] 上下文
 * @param {string|string[]} [ctx.executor] 执行者
 * @param {boolean} [ctx.internalCall] 是否由 CLI/内部发起（跳过权限校验）
 * @param {*} [ctx.this] 原始 this
 * @param {...*} params 额外参数
 */
export function executeCommand(input, ctx, ...params) {
  try {
    return executeCommandSilent(input, ctx, ...params);
  } catch (err) {
    getLogger().cmd.error(err.message);
  }
}

/**
 * 执行命令（不 catch，throw 错误）。
 * @param {string} input
 * @param {object} [ctx] 上下文
 * @param {string|string[]} [ctx.executor] 执行者
 * @param {boolean} [ctx.internalCall] 是否绕过权限校验
 * @param {*} [ctx.this] 原始 this
 * @param {...*} params 额外参数
 * @returns {*}
 * @throws {Error}
 */
export function executeCommandSilent(input, ctx = {}, ...params) {
  if (typeof input !== 'string' || !input.trim()) return;

  const args = parseArgs(input.trim());
  const [cmdName, ...cmdArgs] = args;
  const meta = commands.get(cmdName);

  if (!meta) {
    throw new Error(buildError(cmdName, '未知命令'));
  }

  const executor = ctx.executor;
  const internalCall = !!ctx.internalCall;
  const originalThis = ctx.this;

  // 权限检查：CLI / 内部调用跳过
  if (!internalCall && executor) {
    const permErr = checkCommandPerms(cmdName, meta.permissions, executor);
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
    return meta.handler.call(context, ...cmdArgs, ...params);
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
  const names = [...commands.keys()].sort();
  return names.join(', ') || '暂无注册命令';
}, { description: '显示可用命令列表' });
