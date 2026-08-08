/**
 * commandServer.js — 命令注册与执行引擎（纯逻辑，无 UI 依赖）
 *
 * 提供：
 *   registerCommand(name, handler, opts) — 注册命令
 *   executeCommand(input)             — 执行，自动 catch 并打印错误到终端
 *   executeCommandSilent(input)       — 执行，不 catch（未知命令 / 执行失败 throw）
 *   inferNext(input)                  — 返回 TAB 补全建议
 *   getCommands()                     — 获取所有已注册命令
 */

import { getLogger } from "../system/logger/logger.js";

// ---- 颜色常量（仅 executeCommand 错误输出用）----
const RED   = '\x1b[31m';
const CYAN  = '\x1b[36m';
const DIM   = '\x1b[2m';
const BOLD  = '\x1b[1m';
const R     = '\x1b[0m';

/** @type {Map<string, { handler: Function, usage?: string }>} */
const commands = new Map();

// ---- 参数解析（保持原逻辑）----

export function parseArgs(input) {
  const args = [];
  let current = '', inSingle = false, inDouble = false, escape = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
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

// ---- 命令注册 ----

/**
 * 注册命令。参数校验由调用方（handler）自行处理，此处不限制参数数量。
 * @param {string} name 命令名
 * @param {(args: string[]) => void|Promise<void>} handler 处理函数，需自行校验参数
 * @param {{ description?: string, usage?: string }} [opts] 可选元数据
 */
export function registerCommand(name, handler, opts = {}) {
  if (commands.has(name)) throw new Error(`命令 "${name}" 已被注册`);
  commands.set(name, { handler, ...opts });
}

// ---- 执行 ----

function buildError(cmdName, reason, usage) {
  return usage
    ? `${BOLD}${cmdName}${R}${RED}: ${reason}${R}\n${DIM}用法: ${CYAN}${usage}${R}`
    : `${BOLD}${cmdName}${R}${RED}: ${reason}${R}`;
}

/**
 * 执行命令
 * @param {string} input
 * @return {Promise<Object>|Object} 执行结果
 */
export function executeCommand(input) {
  try {
    return executeCommandSilent(input);
  } catch (err) {
    getLogger().cmd.error(`${err.message}\n`);
  }
}

/**
 * 执行命令
 * @param {string} input
 * @return {Promise<Object>|Object} 执行结果
 * @throws {Error} 未知命令 / 参数错误 / 执行异常
 */
export function executeCommandSilent(input) {
  const trimmed = input.trim();
  if (!trimmed) return;

  const args = parseArgs(trimmed);
  const [cmdName, ...cmdArgs] = args;
  const meta = commands.get(cmdName);

  if (!meta) {
    throw new Error(buildError(cmdName, '未知命令'));
  }

  try {
    return meta.handler(cmdArgs);
  } catch (err) {
    throw new Error(buildError(cmdName, `执行失败: ${err.message}`));
  }
}

// ---- TAB 建议 ----

/**
 * 根据当前输入返回补全建议列表。
 * @param {string} input 当前行内容
 * @returns {{ hits: string[], prefix: string }} 匹配列表 + 用于补全的前缀
 */
export function inferNext(input) {
  const trimmed = input.trimStart();
  if (!trimmed) return { hits: [], prefix: '' };

  // 仅补全第一个词（命令名）
  if (trimmed.includes(' ')) {
    return { hits: [], prefix: trimmed };
  }

  const hits = [];
  for (const name of commands.keys()) {
    if (name.startsWith(trimmed)) hits.push(name);
  }
  return { hits, prefix: trimmed };
}

// ---- 工具 ----

export function getCommands() {
  return commands;
}

registerCommand('help', () => {
  const names = [...commands.keys()].sort();
  return names.join(', ') || '暂无注册命令\n';
}, { description: '显示可用命令列表' });