import qqGuildBot from 'qq-guild-bot';
import { getConfigs } from '../../main.js';

const { createOpenAPI, createWebsocket } = qqGuildBot;

/** 当前生效的配置信息 */
export const bot_conf = {
  appID: getConfigs()?.secret?.qqbot?.appid,
  token: getConfigs()?.secret?.qqbot?.appsecret,
  intents: ['PUBLIC_GUILD_MESSAGES'],
  sandbox: false,
};

let client, ws;

export function init() {
  client = createOpenAPI(bot_conf);
  ws = createWebsocket(bot_conf);
  return { close };
}

/** 关闭 QQBot 连接（供 main.js 优雅关闭时调用） */
export function close() {
  try {
    ws?.close();
  } catch {
    // 忽略关闭时的错误
  }
  client = undefined;
  ws = undefined;
}

/** 获取 WebSocket 连接 */
export function getWebSocket() {
  return ws;
}

/** 获取 QQBot 对象 */
export function getClient() {
  return client;
}

export default {
  getClient, getWebSocket
}