/**
 * main.js — 项目入口（组合根 Composition Root）
 *
 * 负责组装各子模块：加载配置 -> 创建日志器 -> 创建 WebSocket 服务，
 * 并通过依赖注入将 logger / config 传递给子模块，保持模块间解耦。
 */

import { loadAllConfigs } from './src/conf.js';
import { createLogger } from './src/logger.js';
import { createWebSocketServer } from './src/websocket.js';

/**
 * 启动流程。
 * @returns {Promise<{logger: object, wsServer: import('ws').WebSocketServer, configs: object}>}
 */
async function bootstrap() {
  // 1. 加载全部配置（内部名 -> 配置对象）
  const configs = loadAllConfigs();

  // 2. 创建日志器（配置来自 conf.js 的 logger 配置）
  const logger = createLogger({
    logDir: configs.logger.logDir,
    maxFileSize: configs.logger.maxFileSize,
  });

  logger.main.info(`${configs.main.name} 服务启动`);

  // 3. 创建 WebSocket 服务（依赖注入 config + logger）
  const wsServer = createWebSocketServer({
    config: configs.websocket,
    logger,
  });

  // 4. 优雅关闭
  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.main.warn(`收到 ${signal}，正在关闭…`);
    wsServer.close(() => {
      logger.main.info('服务已关闭');
      process.exit(0);
    });
    // 兜底：5 秒内未能优雅退出则强制退出
    setTimeout(() => process.exit(1), 5000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return { logger, wsServer, configs };
}

bootstrap().catch((err) => {
  // 日志器尚未就绪时的兜底输出
  console.error('[FATAL] 启动失败:', err);
  process.exit(1);
});
