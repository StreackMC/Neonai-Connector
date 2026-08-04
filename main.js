#!/bin/node

import { loadAllConfigs } from './src/conf.js';
import { createLogger } from './src/logger.js';

/** 全部配置 */
export const configs = loadAllConfigs();

/** 日志 */
export const logger = createLogger({
  logDir: configs.logger.logDir,
  maxFileSize: configs.logger.maxFileSize,
});

async function loadAllListeners() {
  if (configs?.main?.listening?.qqbot) {
    logger.main.info("正在加载 QQBot 传入流监听");
    (await import('./src/QQBot/entry.js')).init();
  } else {
    logger.main.info("由配置决定的不加载 QQBot 传入流监听");
  };
}

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.main.warn(`收到 ${signal}，正在关闭…`);
  // 兜底：5 秒内未能优雅退出则强制退出
  setTimeout(() => process.exit(1), 5000).unref();
}

try {
  await loadAllListeners();
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
} catch (err) {
  console.error('[FATAL] 启动失败:', err);
  process.exit(1);
}