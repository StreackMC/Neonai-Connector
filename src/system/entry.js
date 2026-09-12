/**
 * system/entry.js — 系统层入口（组合根 Composition Root）
 *
 * 职责：
 *   1. 获取 PID 进程锁
 *   2. 初始化平台管理器，导入并注册各平台，按配置启动
 *   3. 启动 CLI 命令系统（含保活）
 *   4. 注册信号处理并优雅关闭
 *
 * 配置 / 日志 / 平台管理器单例分别由 confManager.js / Logger.js / platformManager.js 提供。
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform, release, tmpdir } from 'node:os';

import { NeonaicConfManager } from './confManager.js';
import { NeonaicLogger } from '../logger/Logger.js';
import { NeonaicPidManager } from './pidManager.js';
import { NeonaicCommandServer } from '../command/commandServer.js';
import { NeonaicCommandInterface } from '../command/commandInterface.js';
import { NeonaicPermissionServer } from '../command/permissionServer.js';
import { NeonaicCliProcessor } from './cliProcessor.js';
import { NeonaicPlatformManager } from '../platform/platformManager.js';

// ---- 常量 ----

const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const R = '\x1b[0m';
const T = 'Neo';

/** 当前是否在调试 */
const DEBUGING = process.argv.some((a) => a === '--debug=true' || a === '--debug');
/** 项目根路径 */
const ROOT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** 项目名称 */
const APP_NAME = NeonaicConfManager.getConfig(NeonaicConfManager.CONFIG_PATHS.app).getString('name', 'neonai-connector');
/** 项目版本 */
const APP_VERSION = NeonaicConfManager.getConfig(NeonaicConfManager.CONFIG_PATHS.app).getString('version', '0.0.0');
/** PID 锁文件路径 */
const PID_FILE_PATH = resolve(ROOT_PATH, '.neonai.pid');
/** 全局唯一ID */
const UniqueID = function uid() { if (typeof uid._ !== 'number') uid._ = 0; uid._ += 1; return uid._; };

// ---- 安全关闭 ----

let shuttingDown = false;

/** 优雅关闭：清理 CLI → 释放所有平台 → 释放 PID 锁 */
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  // 先关闭 CLI，避免后续日志叠加在 readline prompt 上
  NeonaicCliProcessor.stopCLI();

  NeonaicLogger.getLogger().main.warn(`收到 ${signal}，正在关闭…`);

  // 兜底：5 秒内未能优雅退出则强制退出
  const forceTimer = setTimeout(() => process.exit(1), 5000);
  forceTimer.unref();

  // 释放所有平台
  const pm = NeonaicPlatformManager.PlatformManager.instance;
  if (pm) {
    await Promise.allSettled(pm.getClosers().map((close) => close()));
  }

  NeonaicLogger.getLogger().main.info('服务已关闭');
  // 如果在调试使用断点避免停止运行
  if (DEBUGING) debugger;
  process.exit(0);
}

// ---- 系统级 CLI 命令 ----

NeonaicCommandServer.registerCommand('neonaic', 'version', function () {
  /** @type {import('../command/commandServer.js').NeonaicCommandServer.NeonaicCommandContext} */
  const ctx = this;

  // ---- 硬编码 ----
  let projectName = "\n" +
    `  _   _                        _     \n` +
    ` | \\ | | ___  ___  _ __   __ _(_)    \n` +
    ` |  \\| |/ _ \\/ _ \\| '_ \\ / _\` | |    \n` +
    ` | |\\  |  __/ (_) | | | | (_| | |    \n` +
    ` |_| \\_|\\___|\\___/|_| |_|\\__,_|_|    \n` +
    `   ____ ___  _   _ _____ _____ ____  \n` +
    `  / ___/ _ \\| \\ | |_   _| ____|  _ \\ \n` +
    ` | |  | | | |  \\| | | | |  _| | |_) |\n` +
    ` | |__| |_| | |\\  | | | | |___|  _ < \n` +
    `  \\____\\___/|_| \\_| |_| |_____|_| \\_\\\n\n`;
  if (!ctx.internalCall) projectName = T + 'nai' + 'Connector';

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

  const mayShowSys = NeonaicPermissionServer.checkPermissionFromContext(this);
  const sysLine = mayShowSys ? (
    `${B}Node.js${R}   ${nodeVer}\n` +
    `${B}OS${R}        ${osVer}\n` +
    `${B}CWD${R}       ${cwd}\n` +
    `${B}PID${R}       ${process.pid}\n` +
    `${B}Temp${R}      ${tmp}\n`
  ) : '';

  return (
    
    `${B}${projectName}${R} v${APP_VERSION}\n` +
    `${D}----------------------------${R}\n` +
    `${B}Author${R}    ${AUTHOR}\n` +
    `${B}License${R}   ${LICENSE}\n` +
    `${B}       ${R}   ${CPR}\n` +
    `${B}Repo${R}      ${REPO}\n` +
    `${D}----------------------------${R}\n` + sysLine
  );
}, { description: '显示版本与版权信息' });

NeonaicCommandServer.registerCommand('neonaic', 'stop', () => {
  shutdown('COMMAND');
}, { description: '安全关闭服务', permissions: [[NeonaicCommandInterface.COMMAND_ENUMS.PERM_SUPERADMIN, "neonaic.commmand.stop"]] });

// ---- 启动 ----

/** 启动流程 */
async function bootstrap() {
  // PID锁
  NeonaicPidManager.acquirePidLock(PID_FILE_PATH, NeonaicLogger.getLogger());
  NeonaicLogger.getLogger().main.info(`${APP_NAME} 服务启动`);

  // 调试模式分支
  if (DEBUGING) {
    // 调试模式：console 走原生输出，设置全局标志位，启用 $()
    NeonaicLogger.setDebugMode(true);
    globalThis.$ = (input) => {
      const args = NeonaicCommandServer.parseArgs(String(input));
      const [cmdName, cmdArgs] = args;
      return NeonaicCommandServer.executeCommand(cmdName, { internalCall: true, privateExecutor: true }, ...cmdArgs);
    };
    NeonaicLogger.getLogger().main.info('调试模式已启用，$(cmd) 可用');
  } else {
    // 正常模式：劫持 console 到日志系统
    globalThis.$ = null;
    NeonaicLogger.getLogger().redirectConsole(true);
  }

  // 初始化平台管理器（单例）
  new NeonaicPlatformManager.PlatformManager({
    configPath: resolve(ROOT_PATH, 'secret.json'),
    logger: NeonaicLogger.getLogger(),
  });

  // 立即启动 CLI，让提示符尽快出现（平台加载不阻塞交互）
  NeonaicCliProcessor.startCLI();

  // 日志输出与 REPL 提示符协作：每次输出先清掉旧提示符，输出后重绘新提示符
  NeonaicLogger.setConsoleHooks(NeonaicCliProcessor.erasePrompt, NeonaicCliProcessor.redrawPrompt);

  // 自动发现并加载扩展（无需硬编码路径）
  // todo: refactor

  // 安装权限管理命令（permission/perm）：需在 commandServer 就绪后，避免循环依赖
  NeonaicPermissionServer.installPermissionCommands(NeonaicCommandServer.registerCommand);
  NeonaicConfManager.installConfigCommands(NeonaicCommandServer.registerCommand);

  // 按配置启动已启用的平台
  NeonaicPlatformManager.PlatformManager.instance.loadEnabled();

  // 监听 SIGNAL 等
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('exit', () => NeonaicPidManager.releasePidLock(PID_FILE_PATH));

  // 顶层未捕获异常：写崩溃报告后走安全关闭流程
  process.on('uncaughtException', (err) => {
    NeonaicLogger.getLogger().main.error(`未捕获异常:`, err);
    NeonaicLogger.getLogger().writeCrashReport(err);
    // shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    NeonaicLogger.getLogger().main.error(`未处理的 Promise 拒绝异常:`, err);
    NeonaicLogger.getLogger().writeCrashReport(err);
    // shutdown('unhandledRejection');
  });
}

export const NeonaicEntry = {
  DEBUGING,
  ROOT_PATH,
  APP_NAME,
  APP_VERSION,
  PID_FILE_PATH,
  UniqueID,
  bootstrap,
};
