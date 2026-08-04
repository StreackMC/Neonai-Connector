/**
 * cli.js — 命令行交互系统
 *
 * 提供注册式命令系统、带引号转义的参数解析器，以及基于 readline 的 REPL。
 *
 * 用法：
 *   import { registerCommand, startCLI } from './cli.js';
 *
 *   registerCommand('say', (args) => {
 *     process.stdout.write(`You said: ${args.join(' ')}\n`);
 *   });
 *
 *   startCLI();
 */

import { createInterface } from 'node:readline';

/** @type {Map<string, (args: string[]) => void>} */
const commands = new Map();

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
      // 在双引号内仅 \" 和 \\ 需要转义，其余反斜杠原样保留
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

  // 末尾残留（含未闭合引号内容，按普通字符处理）
  if (current.length > 0) {
    args.push(current);
  }

  return args;
}

/**
 * 注册一条命令。
 *
 * @param {string} name 命令名
 * @param {(args: string[]) => void} handler 处理函数，接收已解析的参数数组
 */
export function registerCommand(name, handler) {
  if (commands.has(name)) {
    throw new Error(`命令 "${name}" 已被注册`);
  }
  commands.set(name, handler);
}

/**
 * 执行一条命令字符串：解析参数 → 查找处理器 → 调用。
 *
 * @param {string} input 原始命令输入
 */
export function executeCommand(input) {
  const trimmed = input.trim();
  if (!trimmed) return;

  const args = parseArgs(trimmed);
  const [cmdName, ...cmdArgs] = args;
  const handler = commands.get(cmdName);

  if (!handler) {
    process.stdout.write(`未知命令: ${cmdName}（输入 "help" 查看可用命令）\n`);
    return;
  }

  try {
    handler(cmdArgs);
  } catch (err) {
    process.stderr.write(`命令执行失败: ${err.message}\n`);
  }
}

/**
 * 启动交互式 REPL（readline，非阻塞）。
 *
 * @returns {import('node:readline').Interface}
 */
export function startCLI() {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\x1b[36m>\x1b[0m ',
  });

  rl.prompt();

  rl.on('line', (line) => {
    executeCommand(line);
    rl.prompt();
  });

  rl.on('close', () => {
    // stdin 关闭时由 graceful shutdown 处理退出
  });

  return rl;
}

/**
 * 获取所有已注册命令（供 help 命令等使用）。
 *
 * @returns {Map<string, Function>}
 */
export function getCommands() {
  return commands;
}
