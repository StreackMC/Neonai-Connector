#!/usr/bin/env node

/**
 * main.js — 项目入口
 *
 * 实际启动逻辑在 src/system/entry.js（组合根），本文件仅做错误兜底。
 */

import { NeonaicEntry } from './src/system/entry.js';

NeonaicEntry.bootstrap().catch((err) => {
  console.error('[FATAL] 启动失败:', err);
  process.exit(1);
});
