/**
 * system/entry.js — 系统层入口（组合根 Composition Root）
 *
 * 职责：
 *   1. 加载全部配置（惰性单例）
 *   2. 创建日志器（惰性单例）
 *   3. 获取 PID 进程锁
 *   4. 按配置加载各平台监听器
 *   5. 启动 CLI 命令系统
 *   6. 注册信号处理并优雅关闭
 *
 * 导出 getConfigs() / getLogger() 供其他模块复用（惰性初始化，import 无副作用）。
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAllConfigs } from './conf.js';
import { createLogger } from './logger.js';
import { acquirePidLock, releasePidLock } from './pid.js';
import { getCommands, registerCommand, startCLI } from './cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

/** PID 锁文件路径 */
const PID_FILE = resolve(ROOT, '.neonai.pid');

/** 共享单例（惰性初始化） */
let _configs = null;
let _logger = null;

/** 已加载监听器的清理函数集合 */
const closers = [];

/** 获取全部配置（首次调用时加载） */
export function getConfigs() {
  if (!_configs) _configs = loadAllConfigs();
  return _configs;
}

/**
 * 获取日志器（首次调用时创建）。
 *
 * @returns {import('./logger.js').Logger} 共享日志器实例
 */
export function getLogger() {
  if (!_logger) {
    const { logDir, maxFileSize } = getConfigs().logger;
    _logger = createLogger({ logDir, maxFileSize });
  }
  return _logger;
}

let shuttingDown = false;

/** 按配置加载各平台监听器，并收集其清理函数 */
async function loadPlatforms() {
  const { main } = getConfigs();
  if (main?.listening?.qqbot) {
    getLogger().main.info('正在加载 QQBot 平台监听');
    const module = await import('../platform/qqbot.js');
    const handle = module.init();
    if (typeof handle === 'function') {
      closers.push(handle);
    } else if (handle && typeof handle.close === 'function') {
      closers.push(() => handle.close());
    }
  } else {
    getLogger().main.info('由配置决定的不加载 QQBot 平台监听');
  }
}

/** 优雅关闭：依次释放监听器，5 秒内未完成则强制退出 */
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  getLogger().main.warn(`收到 ${signal}，正在关闭…`);

  // 兜底：5 秒内未能优雅退出则强制退出
  const forceTimer = setTimeout(() => process.exit(1), 5000);
  forceTimer.unref();

  await Promise.allSettled(closers.map((close) => close()));
  closers.length = 0;

  getLogger().main.info('服务已关闭');
  process.exit(0);
}

// ---- 系统级 CLI 命令 ----

registerCommand('help', () => {
  const cmds = [];
  for (const name of getCommands().keys()) {
    cmds.push(name);
  }
  process.stdout.write(`可用命令: ${cmds.sort().join(', ')}\n`);
});

registerCommand('status', () => {
  const { name, version } = getConfigs().app;
  process.stdout.write(`${name} v${version}\n`);
  process.stdout.write(`PID: ${process.pid}\n`);
  process.stdout.write(`平台: ${closers.length}\n`);
});

registerCommand('stop', () => {
  process.stdout.write('正在关闭服务…\n');
  shutdown('CLI');
});

/** 启动流程 */
export async function bootstrap() {
  const { name } = getConfigs().app;
  getLogger().main.info(`${name} 服务启动`);

  acquirePidLock(PID_FILE, getLogger());

  // 按配置决定是否把全局 console.log/warn/error 劫持到 Main 日志
  if (getConfigs().main?.log?.redirectConsole) {
    getLogger().redirectConsole(true);
  }

  await loadPlatforms();

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('exit', () => releasePidLock(PID_FILE));

  // 启动 CLI（非阻塞）
  startCLI();
}
