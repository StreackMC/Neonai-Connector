/**
 * platform/qqbot.js — QQ 频道机器人平台适配器
 *
 * 职责：接收 QQ 频道消息流（IN），调用 Handler 获取回复（OUT），发送回平台。
 *
 * 通过 registerPlatform 向平台管理器注册自身（start / stop 生命周期），
 * 并通过 registerCommand 提供运维命令（status / reconnect）。
 */

import qqGuildBot from 'qq-guild-bot';
import { getConfigs } from '../system/entry.js';
import { registerCommand } from '../system/cli.js';
import { registerPlatform } from '../system/platform-manager.js';

const { createOpenAPI, createWebsocket } = qqGuildBot;

/** 当前生效的配置信息 */
const bot_conf = {
  appID: getConfigs()?.secret?.qqbot?.appid,
  token: getConfigs()?.secret?.qqbot?.appsecret,
  intents: ['PUBLIC_GUILD_MESSAGES'],
  sandbox: false,
};

let client, ws;

/** 启动 QQBot 连接（供平台管理器调用） */
function start() {
  client = createOpenAPI(bot_conf);
  ws = createWebsocket(bot_conf);
  return { close };
}

/** 关闭 QQBot 连接 */
function stop() {
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

// ---- 向平台管理器注册 ----
registerPlatform('qqbot', { start, stop });

// ---- CLI 运维命令 ----
registerCommand('qqbot', (args) => {
  const sub = args[0];

  if (sub === 'status') {
    const connected = !!ws;
    process.stdout.write(`QQBot 状态: ${connected ? '\x1b[32m已连接\x1b[0m' : '\x1b[33m未连接\x1b[0m'}\n`);
  } else if (sub === 'reconnect') {
    stop();
    start();
    process.stdout.write('QQBot 已重新连接\n');
  } else {
    process.stdout.write(`未知子命令: ${sub}，可用: status | reconnect\n`);
  }
}, { description: 'QQBot 运维操作', argsCount: 1, usage: 'qqbot status | qqbot reconnect' });

export default {
  getClient,
  getWebSocket,
};
