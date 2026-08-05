/**
 * platform/qqbot.js — QQ 频道机器人平台适配器
 *
 * 职责：接收 QQ 频道消息流（IN），调用 Handler 获取回复（OUT），发送回平台。
 *
 * 通过 registerPlatform 向平台管理器注册自身（start / stop 生命周期），
 * 并通过 registerCommand 提供运维命令（status / reconnect）。
 *
 * 注意：qq-guild-bot 动态导入（非顶层静态 import），确保其内嵌的 loglevel
 * 在 console 被劫持后才初始化，从而走截断输出。
 */

import { getConfigs } from '../system/conf.js';
import { registerCommand } from '../system/commandServer.js';
import { registerPlatform } from '../system/platform-manager.js';

/** qq-guild-bot 惰性加载缓存 */
let _qqGuildBot = null;

async function getQQGuildBot() {
  if (!_qqGuildBot) {
    _qqGuildBot = await import('qq-guild-bot');
  }
  return _qqGuildBot.default;
}

/** 当前生效的配置信息 */
const bot_conf = {
  appID: getConfigs()?.secret?.qqbot?.appid,
  token: getConfigs()?.secret?.qqbot?.appsecret,
  intents: ['PUBLIC_GUILD_MESSAGES'],
  sandbox: false,
};

let client, ws;

/** 启动 QQBot 连接（供平台管理器调用） */
async function start() {
  const qqGuildBot = await getQQGuildBot();
  const { createOpenAPI, createWebsocket } = qqGuildBot;
  client = createOpenAPI(bot_conf);
  ws = createWebsocket(bot_conf);
  return { close: stop };
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
registerCommand('qqbot', async (args) => {
  const sub = args[0];
  if (!sub) {
    process.stdout.write('用法: qqbot status | qqbot reconnect\n');
    return;
  }

  if (sub === 'status') {
    const connected = !!ws;
    process.stdout.write(`QQBot 状态: ${connected ? '\x1b[32m已连接\x1b[0m' : '\x1b[33m未连接\x1b[0m'}\n`);
  } else if (sub === 'reconnect') {
    stop();
    await start();
    process.stdout.write('QQBot 已重新连接\n');
  } else {
    process.stdout.write(`未知子命令: ${sub}，可用: status | reconnect\n`);
  }
}, { description: 'QQBot 运维操作', usage: 'qqbot status | qqbot reconnect' });

export default {
  getClient,
  getWebSocket,
};
