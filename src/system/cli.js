/**
 * cli.js — 命令行交互系统
 *
 * 提供注册式命令系统、带引号转义的参数解析器、TAB 补全，以及基于 readline 的 REPL。
 *
 * 用法：
 *   import { registerCommand, startCLI } from './cli.js';
 *
 *   registerCommand('say', (args) => {
 *     process.stdout.write(`You said: ${args.join(' ')}\n`);
 *   }, { description: '打印输入', argsCount: [1, Infinity], usage: 'say <words ...>' });
 *
 *   startCLI();
 */

import { createInterface } from 'node:readline';

// ---- ANSI 颜色 ----
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const R = '\x1b[0m';

/**
 * @typedef {object} CommandMeta
 * @property {(args: string[]) => void} handler 处理函数
 * @property {string} [description] 命令描述（用于 help）
 * @property {number | [number, number]} [argsCount] 期望参数数量（数字=精确，数组=[最小, 最大]，Infinity=无上限）
 * @property {string} [usage] 用法示例
 */

/** @type {Map<string, CommandMeta>} */
const commands = new Map();

// ---- 防抖状态 ----
let lastErrorMsg = '';
let lastErrorTime = 0;
const ERROR_DEBOUNCE_MS = 800;

// ---- 参数解析（保持原版逻辑不变）----

/**
 * 解析命令行参数字符串。
 *
 * 规则：
 *   - 空格分隔参数
 *   - 双引号 / 单引号包裹的内容视为一个参数（允许含空格）
 *   - 反斜杠转义下一个字符（\" 在引号内变为字面量 "）
 *   - 未匹配的引号视为普通字符
 *
 * 示例：
 *   parseArgs('cmd hello "world foo" baz')   → ['cmd', 'hello', 'world foo', 'baz']
 *   parseArgs('cmd "a \\"r g"')              → ['cmd', 'a "r g']
 *
 * @param {string} input 原始输入字符串
 * @returns {string[]} 解析后的参数数组
 */
export function parseArgs(input) {
  const args = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escape = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (escape) {
      if (inDouble && ch !== '"' && ch !== '\\') {
        current += '\\';
      }
      current += ch;
      escape = false;
      continue;
    }

    if (ch === '\\') {
      escape = true;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }

    if (ch === ' ' && !inSingle && !inDouble) {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (current.length > 0) {
    args.push(current);
  }

  return args;
}

// ---- 命令注册 ----

/**
 * 注册一条命令。
 *
 * @param {string} name 命令名
 * @param {(args: string[]) => void} handler 处理函数，接收已解析的参数数组
 * @param {object} [options] 命令元数据
 * @param {string} [options.description] 命令描述（用于 help）
 * @param {number | [number, number]} [options.argsCount] 期望参数数量：
 *   - number：精确匹配
 *   - [min, max]：闭区间，max 可用 Infinity 表示无上限
 * @param {string} [options.usage] 用法示例字符串（参数校验失败时显示）
 */
export function registerCommand(name, handler, options = {}) {
  if (commands.has(name)) {
    throw new Error(`命令 "${name}" 已被注册`);
  }
  commands.set(name, { handler, ...options });
}

// ---- 错误输出（防抖 + 红色高亮）----

/**
 * 输出红色错误提示，带防抖。
 * @param {string} msg 错误摘要
 * @param {string} [detail] 补充说明（另起一行）
 */
function showError(msg, detail) {
  const now = Date.now();
  const fullMsg = msg + (detail ? `\n${detail}` : '');

  if (fullMsg === lastErrorMsg && now - lastErrorTime < ERROR_DEBOUNCE_MS) {
    return;
  }
  lastErrorMsg = fullMsg;
  lastErrorTime = now;

  process.stdout.write(`${RED}${msg}${R}\n`);
  if (detail) {
    process.stdout.write(`${DIM}${detail}${R}\n`);
  }
}

/** 格式化参数范围为人可读文本 */
function formatArgsRange(count) {
  if (typeof count === 'number') return String(count);
  const [min, max] = count;
  if (max === Infinity) return `至少 ${min} 个`;
  if (min === max) return String(min);
  return `${min}-${max} 个`;
}

// ---- 命令执行（含参数校验）----

/**
 * 校验参数数量。
 * @returns {string | null} 错误信息，null 表示校验通过
 */
function validateArgsCount(meta, actualCount) {
  const count = meta.argsCount;
  if (count === undefined) return null;

  if (typeof count === 'number') {
    if (actualCount !== count) {
      return `参数数量不匹配（期望 ${count} 个，实际 ${actualCount} 个）`;
    }
    return null;
  }

  // [min, max]
  const [min, max] = count;
  if (actualCount < min) {
    return `参数不足（需要 ${formatArgsRange(count)}，实际 ${actualCount} 个）`;
  }
  if (actualCount > max) {
    return `参数过多（需要 ${formatArgsRange(count)}，实际 ${actualCount} 个）`;
  }
  return null;
}

/**
 * 执行一条命令字符串：解析参数 → 查找处理器 → 校验 → 调用。
 *
 * @param {string} input 原始命令输入
 */
export function executeCommand(input) {
  const trimmed = input.trim();
  if (!trimmed) return;

  const args = parseArgs(trimmed);
  const [cmdName, ...cmdArgs] = args;
  const meta = commands.get(cmdName);

  if (!meta) {
    showError(
      `${BOLD}${cmdName}${R}${RED}: 未知命令`,
      `输入 "help" 查看可用命令`
    );
    return;
  }

  // 参数校验
  const argError = validateArgsCount(meta, cmdArgs.length);
  if (argError) {
    const usage = meta.usage ? `用法: ${CYAN}${meta.usage}${R}` : '';
    showError(
      `${BOLD}${cmdName}${R}${RED}: ${argError}${R}`,
      usage
    );
    return;
  }

  try {
    meta.handler(cmdArgs);
  } catch (err) {
    showError(
      `${BOLD}${cmdName}${R}${RED}: 执行失败`,
      err.message
    );
  }
}

// ---- REPL ----

/** 保活定时器（防止无平台时进程退出） */
let keepAliveTimer = null;
/** 当前 readline 实例 */
let _rl = null;

/**
 * 启动交互式 REPL（readline，非阻塞）。
 * 同时设置保活定时器，确保即使没有平台运行，进程也不会退出。
 *
 * 非 TTY 环境（调试会话、管道输入等）跳过 REPL 启动，
 * 但保活定时器仍然生效，交互通过全局 $() 进行。
 */
export function startCLI() {
  // 保活定时器（无论是否 TTY 都生效）
  clearInterval(keepAliveTimer);
  keepAliveTimer = setInterval(() => {}, 86400000);

  // 非 TTY 环境：跳过 REPL，依赖全局 $() 交互
  if (!process.stdin.isTTY) return;

  _rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${CYAN}>${R} `,
    completer: (line) => {
      const trimmed = line.trimStart();
      // 仅对第一个词（命令名）做 TAB 补全
      if (!trimmed || trimmed.includes(' ')) {
        return [[], line];
      }
      const hits = [];
      for (const name of commands.keys()) {
        if (name.startsWith(trimmed)) {
          hits.push(name);
        }
      }
      if (hits.length === 1) {
        return [hits, trimmed];
      }
      if (hits.length > 1) {
        // 多个匹配：延迟写入候选项然后重新显示 prompt；用户继续输入时自然消失
        setTimeout(() => {
          process.stdout.write(`\n${DIM}${hits.join('  ')}${R}\n`);
          _rl.prompt(true);
        }, 0);
      }
      return [[], line];
    },
  });

  _rl.prompt();

  _rl.on('line', (line) => {
    executeCommand(line);
    _rl.prompt();
  });

  _rl.on('close', () => {
    // stdin 关闭时由 graceful shutdown 处理退出
  });

  return _rl;
}

/**
 * 停止 CLI：关闭 readline 接口并清除保活定时器。
 * 由 stop 命令调用，不主动 exit（留给 shutdown 流程处理）。
 */
export function stopCLI() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
  if (_rl) {
    _rl.close();
    _rl = null;
  }
}

// ---- 工具 ----

/**
 * 获取所有已注册命令（供 help 命令等使用）。
 *
 * @returns {Map<string, CommandMeta>}
 */
export function getCommands() {
  return commands;
}
