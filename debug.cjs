/**
 * debug.cjs — 调试会话入口（CommonJS → ESM 过渡）
 *
 * 用法：node debug.cjs
 *
 * 注入 --debug 参数后加载 main.js，启用：
 *   - 全局 $(cmd) 模拟 CLI 输入
 *   - 原生 console 输出（不截断，不通过日志系统）
 */

// 在导入前注入 --debug 参数
process.argv.push('--debug');

import('./main.js').catch((err) => {
  console.error('[FATAL] 启动失败:', err);
  process.exit(1);
});
