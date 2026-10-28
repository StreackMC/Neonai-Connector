#!/usr/bin/env node

/**
 * main.js — 项目入口
 *
 * 实际启动逻辑在 src/system/entry.js（组合根），本文件只负责：
 *   - 等待启动流程真正完成（否则启动中途的异常会变成「静默退出」）
 *   - 启动失败时打印原因并以非零码退出
 *
 * @apiNote 这里**不能**在 bootstrap() 之后调用 process.exit()：
 *          内核常驻与否由 lifeCycleManager 的保活定时器决定，
 *          提前退出会让「没有平台 / 没有拓展」的部署立刻停止运行。
 */

try {
  const entry = await import('./src/system/entry.js');
  await entry.neonaicEntry.bootstrap();
} catch (err) {
  console.error('[FATAL] 启动失败:', err);
  process.exit(1);
}
