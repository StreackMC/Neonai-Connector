#!/usr/bin/env node

/**
 * main.js — 项目入口
 *
 * 实际启动逻辑在 src/system/entry.js（组合根），本文件仅做错误兜底。
 */

try {
  const neonaicEntry = await import('./src/system/entry.js');
  neonaicEntry.bootstrap();
  process.exit(0);
} catch (err) {
  console.error('[FATAL] 启动失败:', err);
  process.exit(1);
}