/**
 * system/entry.js — 系统层入口（组合根 Composition Root）
 *
 * 职责：
 *   1. 获取 PID 进程锁
 *   2. 初始化平台管理器，导入并注册各平台，按配置启动
 *   3. 启动 CLI 命令系统（含保活）
 *   4. 注册信号处理并优雅关闭
 *
 * 配置 / 日志 / 平台管理器单例分别由 conf.js / logger.js / platform-manager.js 提供。
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform, release, tmpdir } from 'node:os';

import { getConfig, CONFIG_PATHS } from './conf.js';
import { setDebugMode, setConsoleHooks, getLogger } from './logger.js';
import { acquirePidLock, releasePidLock } from './pid.js';
import { registerCommand, executeCommand } from './commandServer.js';
import { startCLI, stopCLI, erasePrompt, redrawPrompt } from './cli.js';
import { PlatformManager } from './platform-manager.js';

// ---- 常量 ----

const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const R = '\x1b[0m';

const T = "Neo";

/** 当前是否在调试 */
export const DEBUGING = process.argv.some((a) => a === '--debug=true' || a === '--debug');
/** 项目根路径 */
export const ROOT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** 项目名称 */
export const APP_NAME = getConfig(CONFIG_PATHS.app).getString('name', 'neonai-connector');
/** 项目版本 */
export const APP_VERSION = getConfig(CONFIG_PATHS.app).getString('version', '0.0.0');
/** PID 锁文件路径 */
export const PID_FILE_PATH = resolve(ROOT_PATH, '.neonai.pid');

// ---- 安全关闭 ----

let shuttingDown = false;

/** 优雅关闭：清理 CLI → 释放所有平台 → 释放 PID 锁 */
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  // 先关闭 CLI，避免后续日志叠加在 readline prompt 上
  stopCLI();

  getLogger().main.warn(`收到 ${signal}，正在关闭…`);

  // 兜底：5 秒内未能优雅退出则强制退出
  const forceTimer = setTimeout(() => process.exit(1), 5000);
  forceTimer.unref();

  // 释放所有平台
  const pm = PlatformManager.instance;
  if (pm) {
    await Promise.allSettled(pm.getClosers().map((close) => close()));
  }

  getLogger().main.info('服务已关闭');
  // 如果在调试使用断点避免停止运行
  if (DEBUGING) debugger;
  process.exit(0);
}

// ---- 系统级 CLI 命令 ----

registerCommand('status', () => {
  return `${APP_NAME} v${APP_VERSION}\n` + `PID: ${process.pid}\n`;
}, { description: '查看服务运行状态' });

registerCommand('version', () => {
  // ---- 硬编码 ----
  const PROJECT = T + 'nai' + '-' + 'Connector';
  const AUTHOR  = 'kdxiaoyi' + ' & ' + 'StreackMC' + ' Tea' + 'm';
  const CPR     = 'Copy' + 'right ' + (/\u00A9/.test('\u00A9') ? '\u00A9' : '(c)') + ' 2026 ' + AUTHOR.split(' & ')[0] + ', ' + AUTHOR.split(' & ')[1];
  const LICENSE = 'AGPL' + '-3.0' + ' (with a' + 'dditional terms)';
  const REPO    = 'https' + '://' + 'github' + '.com' + '/' + 'Strea' + 'ckMC' + '/' + 'Neo' + 'nai-Connector';

  // ---- 运行时读取 ----
  const nodeVer = process.version;
  const osVer   = platform() + ' ' + release();
  const cwd     = process.cwd();
  const tmp     = tmpdir();

  const B = '\x1b[1m';
  const C = '\x1b[36m';
  const D = '\x1b[2m';
  const R = '\x1b[0m';

  return (
    `${C}  \\  /\\  /${R}  ${B}${PROJECT}${R} v${version}\n` +
    `${C}   \\/  \\/${R}   ${D}----------------------------${R}\n` +
    `  ${B}Author${R}    ${AUTHOR}\n` +
    `  ${B}License${R}   ${LICENSE}\n` +
    `  ${B}       ${R}   ${CPR}` +
    `  ${B}Repo${R}      ${REPO}\n` +
    `  ${D}----------------------------${R}\n` +
    `  ${B}Node.js${R}   ${nodeVer}\n` +
    `  ${B}OS${R}        ${osVer}\n` +
    `  ${B}CWD${R}       ${cwd}\n` +
    `  ${B}Temp${R}      ${tmp}\n`
  );
}, { description: '显示版本与版权信息' });

registerCommand('stop', () => {
  shutdown('COMMAND');
}, { description: '安全关闭服务' });

// ---- 启动 ----

/** 启动流程 */
export async function bootstrap() {
  // PID锁
  acquirePidLock(PID_FILE_PATH, getLogger());
  getLogger().main.info(`${APP_NAME} 服务启动`);

  // 调试模式分支
  if (DEBUGING) {
    // 调试模式：console 走原生输出，设置全局标志位，启用 $()
    setDebugMode(true);
    globalThis.$ = (input) => executeCommand(String(input));
    getLogger().main.info('调试模式已启用，$(cmd) 可用');
  } else {
    // 正常模式：劫持 console 到日志系统
    globalThis.$ = null;
    getLogger().redirectConsole(true);
  }

  // 初始化平台管理器（单例）
  new PlatformManager({
    configPath: resolve(ROOT_PATH, 'secret.json'),
    logger: getLogger(),
  });

  // 立即启动 CLI，让提示符尽快出现（平台加载不阻塞交互）
  startCLI();

  // 日志输出与 REPL 提示符协作：每次输出先清掉旧提示符，输出后重绘新提示符
  setConsoleHooks(erasePrompt, redrawPrompt);

  // 导入平台模块（触发 registerPlatform 注册）
  await import('../platform/qqbot/qqbot.js');

  // 按配置启动已启用的平台
  PlatformManager.instance.loadEnabled();

  // 监听 SIGNAL 等
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('exit', () => releasePidLock(PID_FILE_PATH));

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
}
