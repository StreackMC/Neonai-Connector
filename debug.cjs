/**
 * debug.cjs — 调试会话入口（CommonJS → ESM 过渡）
 *
 * 用法：node debug.cjs
 *
 * VS Code 调试器通常没有标准输入，无法使用 CLI REPL。
 * 本文件通过 CommonJS 加载，再动态 import ESM main.js，
 * 启动后在调试控制台通过 $("command") 模拟 CLI 输入。
 *
 * 示例：
 *   $("platform list")
 *   $("qqbot status")
 *   $("help")
 */

import('./main.js').catch((err) => {
  console.error('[FATAL] 启动失败:', err);
  process.exit(1);
});
