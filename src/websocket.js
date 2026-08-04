/**
 * websocket.js — WebSocket 服务模块
 *
 * 解耦约定：本模块不直接引用 conf.js / logger.js，
 * 而是通过依赖注入接收 { config, logger }，由组合根（main.js）组装。
 *
 * 用法：
 *   import { createWebSocketServer } from './websocket.js';
 *   const wss = createWebSocketServer({ config: configs.websocket, logger });
 */

import { WebSocketServer } from 'ws';

/**
 * 创建并启动 WebSocket 服务。
 * @param {object} deps 注入的依赖
 * @param {object} deps.config 来自 conf.js 的 websocket 配置
 * @param {object} deps.logger 来自 logger.js 的日志器
 * @returns {WebSocketServer} 已启动的服务器实例
 */
export function createWebSocketServer({ config, logger }) {
  const { host = '0.0.0.0', port, path = '/' } = config;

  const wss = new WebSocketServer({ host, port, path });

  wss.on('listening', () => {
    logger.ws.info(`WebSocket 服务已启动: ws://${host}:${port}${path}`);
  });

  wss.on('connection', (socket, req) => {
    const remote = req.socket.remoteAddress;
    logger.ws.info(`客户端已连接: ${remote}`);

    socket.on('message', (data, isBinary) => {
      const text = isBinary ? `<binary ${data.length} bytes>` : data.toString();
      logger.ws.info(`收到消息(${remote}): ${text}`);
    });

    socket.on('close', (code, reason) => {
      logger.ws.info(`客户端断开(${remote}): code=${code} reason=${reason || '无'}`);
    });

    socket.on('error', (err) => {
      logger.ws.error(`连接错误(${remote}): ${err.message}`);
    });
  });

  wss.on('error', (err) => {
    logger.ws.error(`WebSocket 服务器错误: ${err.message}`);
  });

  return wss;
}
