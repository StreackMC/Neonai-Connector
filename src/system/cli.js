/**
 * cli.js — CLI 交互层（终端 UI）
 *
 * 依赖 commandServer.js（纯逻辑），负责：
 *   - ">" 提示符显示
 *   - TAB 补全（自动隐藏，不驻留）
 *   - 上下键历史命令（readline 内置）
 *   - 命令执行后的染色输出（蓝色命令、红色错误）
 *   - 保活定时器
 */

import { createInterface } from 'node:readline';
import { executeCommandSilent, inferNext } from './commandServer.js';

// ---- 颜色 ----
const CYAN   = '\x1b[36m';
const DIM    = '\x1b[2m';
const R      = '\x1b[0m';

// ---- 内部状态 ----
let _rl = null;
let keepAliveTimer = null;

/**
 * 启动 REPL。
 */
export function startCLI() {
  clearInterval(keepAliveTimer);
  keepAliveTimer = setInterval(() => {}, 86400000);

  if (!process.stdin.isTTY) return;

  _rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${CYAN}>${R} `,
    history: [],
    completer: (line) => {
      const { hits, prefix } = inferNext(line);
      if (hits.length === 1) return [hits, prefix];
      if (hits.length > 1) {
        // 多候选项：延迟写入一行后重新 prompt，用户继续输入时自然消失
        setTimeout(() => {
          process.stdout.write(`\n${DIM}${hits.join('  ')}${R}\n`);
          _rl.prompt(true);
        }, 0);
      }
      return [[], line];
    },
  });

  // 将历史设为空数组后，readline 自动累积历史，上下键即可翻查

  process.stdout.write('\n');
  _rl.prompt();

  _rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (trimmed) {
      try {
        await executeCommandSilent(trimmed);
      } catch (err) {
        process.stdout.write(`${err.message}\n`);
      }
    }
    if (_rl) _rl.prompt();
  });

  _rl.on('close', () => {});
}

/** 停止 CLI */
export function stopCLI() {
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
  if (_rl) { _rl.close(); _rl = null; }
}

/** 刷新 prompt（供外部异步场景调用） */
export function refreshCLI() {
  if (_rl) _rl.prompt(true);
}
