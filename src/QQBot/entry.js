const { createOpenAPI, createWebsocket } = require('qq-guild-bot');
import { configs } from "../../main.js";

/** 当前生效的配置信息 */
export const bot_conf = {
  appID: configs?.secret?.qqbot?.appid,
  token: configs?.secret?.qqbot?.appsecret,
  intents: ['PUBLIC_GUILD_MESSAGES'],
  sandbox: false,
};

let client, ws;

export function init() {
  client = createOpenAPI(bot_conf);
  ws = createWebsocket(bot_conf);
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