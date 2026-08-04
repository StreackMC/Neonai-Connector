/**
 * system/entry.js — 系统层入口（组合根 Composition Root）
 *
 * 职责：
 *   1. 加载全部配置（惰性单例）
 *   2. 创建日志器（惰性单例）
 *   3. 获取 PID 进程锁
 *   4. 初始化平台管理器，导入并注册各平台，按配置启动
 *   5. 启动 CLI 命令系统（含保活）
 *   6. 注册信号处理并优雅关闭
 *
 * 导出 getConfigs() / getLogger() 供其他模块复用（惰性初始化，import 无副作用）。
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform, release, tmpdir } from 'node:os';

import { loadAllConfigs } from './conf.js';
import { createLogger } from './logger.js';
import { acquirePidLock, releasePidLock } from './pid.js';
import { getCommands, registerCommand, startCLI, stopCLI, executeCommand } from './cli.js';
import { createPlatformManager } from './platform-manager.js';

const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const R = '\x1b[0m';

const T = "Neo";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

/** PID 锁文件路径 */
const PID_FILE = resolve(ROOT, '.neonai.pid');

/** 共享单例（惰性初始化） */
let _configs = null;
let _logger = null;

/** 平台管理器实例 */
let pm = null;

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

/** 优雅关闭：释放所有平台 → 清理 CLI → 释放 PID 锁 */
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  getLogger().main.warn(`收到 ${signal}，正在关闭…`);

  // 兜底：5 秒内未能优雅退出则强制退出
  const forceTimer = setTimeout(() => process.exit(1), 5000);
  forceTimer.unref();

  // 释放所有平台
  if (pm) {
    await Promise.allSettled(pm.getClosers().map((close) => close()));
  }

  // 关闭 CLI（包括保活定时器）
  stopCLI();

  getLogger().main.info('服务已关闭');
  process.exit(0);
}

// ---- 系统级 CLI 命令 ----

registerCommand('help', () => {
  const names = [...getCommands().keys()].sort();
  process.stdout.write(names.join(', ') || '暂无注册命令\n');
}, { description: '显示可用命令列表', argsCount: 0 });

registerCommand('status', () => {
  const { name, version } = getConfigs().app;
  process.stdout.write(`${name} v${version}\n`);
  process.stdout.write(`PID: ${process.pid}\n`);
}, { description: '查看服务运行状态', argsCount: 0 });

registerCommand('version', () => {
  // ---- 硬编码 ----
  const PROJECT = T + 'nai' + '-' + 'Connector';
  const AUTHOR  = 'kdxiaoyi' + ' & ' + 'StreackMC' + ' Tea' + 'm';
  const CPR     = 'Copy' + 'right ' + (/\u00A9/.test('\u00A9') ? '\u00A9' : '(c)') + ' 2026 ' + AUTHOR.split(' & ')[0] + ', ' + AUTHOR.split(' & ')[1];
  const LICENSE = 'AGPL' + '-3.0' + ' (with a' + 'dditional terms)';
  const REPO    = 'https' + '://' + 'github' + '.com' + '/' + 'Strea' + 'ckMC' + '/' + 'Neo' + 'nai-Connector';

  // ---- 运行时读取 ----
  const { version } = getConfigs().app;
  const nodeVer = process.version;
  const osVer   = platform() + ' ' + release();
  const cwd     = process.cwd();
  const tmp     = tmpdir();

  const B = '\x1b[1m';
  const C = '\x1b[36m';
  const D = '\x1b[2m';
  const R = '\x1b[0m';

  process.stdout.write(
    `${C}  \\  /\\  /${R}  ${B}${PROJECT}${R} v${version}\n` +
    `${C}   \\/  \\/${R}   ${D}----------------------------${R}\n` +
    `  ${B}Author${R}    ${AUTHOR}\n` +
    `  ${B}License${R}   ${LICENSE}\n` +
    `  ${B}Repo${R}      ${REPO}\n` +
    `  ${D}----------------------------${R}\n` +
    `  ${B}Node.js${R}   ${nodeVer}\n` +
    `  ${B}OS${R}        ${osVer}\n` +
    `  ${B}CWD${R}       ${cwd}\n` +
    `  ${B}Temp${R}      ${tmp}\n`
  );
}, { description: '显示版本与版权信息', argsCount: 0 });

registerCommand('stop', () => {
  process.stdout.write('正在关闭服务…\n');
  shutdown('CLI');
}, { description: '安全关闭服务', argsCount: 0 });

/** 启动流程 */
export async function bootstrap() {
  const { name } = getConfigs().app;
  getLogger().main.info(`${name} 服务启动`);

  acquirePidLock(PID_FILE, getLogger());

  const isDebug = !process.stdin.isTTY;

  if (isDebug) {
    // 调试会话：日志强制输出到终端
    // 若 config 显式关闭了 redirectConsole，则降级为 DEBUG 级别
    const debugMode = !(getConfigs().main?.log?.redirectConsole);
    getLogger().redirectConsole(true, debugMode);
    if (debugMode) {
      getLogger().main.info('调试模式：config 关闭终端日志，已降级为 DEBUG 级别');
    }
  } else if (getConfigs().main?.log?.redirectConsole) {
    // 普通 CLI：按 config 决定
    getLogger().redirectConsole(true);
  }

  // 初始化平台管理器
  pm = createPlatformManager({
    configPath: resolve(ROOT, 'config', 'main.json'),
    logger: getLogger(),
  });

  // 导入平台模块（触发 registerPlatform 注册）
  await import('../platform/qqbot.js');

  // 按配置启动已启用的平台
  await pm.loadEnabled();

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('exit', () => releasePidLock(PID_FILE));

  // 顶层未捕获异常：写崩溃报告后走安全关闭流程
  process.on('uncaughtException', (err) => {
    getLogger().main.error(`未捕获异常: ${err.message}`);
    getLogger().writeCrashReport(err);
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    getLogger().main.error(`未处理的 Promise 拒绝: ${err.message}`);
    getLogger().writeCrashReport(err);
    shutdown('unhandledRejection');
  });

  // 非 TTY 环境（调试会话）：暴露全局 $() 模拟标准输入
  if (isDebug) {
    globalThis.$ = (input) => executeCommand(String(input));
  }

  // 启动 CLI（含保活；非 TTY 时仅保活，不启 REPL）
  startCLI();
}
