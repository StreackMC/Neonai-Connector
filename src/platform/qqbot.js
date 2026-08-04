/**
 * platform/qqbot.js — QQ 频道机器人平台适配器
 *
 * 职责：接收 QQ 频道消息流（IN），调用 Handler 获取回复（OUT），发送回平台。
 * 提供 close() 供优雅关闭，并通过 registerCommand 注册 CLI 命令。
 */

import qqGuildBot from 'qq-guild-bot';
import { getConfigs } from '../system/entry.js';
import { registerCommand } from '../system/cli.js';

const { createOpenAPI, createWebsocket } = qqGuildBot;

/** 当前生效的配置信息 */
const bot_conf = {
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

/** 关闭 QQBot 连接（供优雅关闭时调用） */
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

/** 获取 QQBot OpenAPI 对象 */
export function getClient() {
  return client;
}

// ---- CLI 命令 ----

registerCommand('qqbot', (args) => {
  const sub = args[0];

  if (sub === 'status') {
    const connected = !!ws;
    process.stdout.write(`QQBot 状态: ${connected ? '已连接' : '未连接'}\n`);
  } else if (sub === 'reconnect') {
    close();
    init();
    process.stdout.write('QQBot 已重新连接\n');
  } else {
    process.stdout.write('用法: qqbot status | qqbot reconnect\n');
  }
});

export default {
  getClient,
  getWebSocket,
};
