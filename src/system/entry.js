/**
 * system/entry.js — 系统层入口（组合根 Composition Root）
 *
 * 职责：
 *   1. 启动内核生命周期（PID 锁 / 事件循环保活 / 信号监听）—— 具体由 lifeCycleManager.js 承担
 *   2. 初始化平台管理器，导入并注册各平台，按配置启动
 *   3. 启动 CLI 命令系统
 *   4. 把关闭步骤交给生命周期管理器，由它按「后进先出」顺序执行
 *
 * 本文件不再自己持有任何常量或进程级状态：常量归 lifeCycleManager.js，
 * 配置 / 日志 / 平台管理器单例分别由 confManager.js / Logger.js / platformManager.js 提供。
 */

import { platform, release, tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { neonaicCommandInterface } from '#/command/commandInterface.js';
import { neonaicCommandServer } from '#/command/commandServer.js';
import { neonaicPermissionServer } from '#/command/permissionServer.js';
import { neonaicEventBus } from '#/event/neonaicEventBus.js';
import { NeonaicLoadedEvent } from '#/event/neonaicEventInterface.js';
import { neonaicExtensionManager } from '#/extension/extManager.js';
import { getLogger, neonaicLogger } from '#/logger/Logger.js';
import { PlatformManager } from '#/platform/platformManager.js';
import { neonaicCliProcessor } from '#/system/cliProcessor.js';
import { neonaicConfManager } from '#/system/confManager.js';
import { neonaicLifeCycleManager } from '#/system/lifeCycleManager.js';
import { neonaicChore } from '#/utils/chore.js';
import { neonaicUtilsSupport } from '#/utils/registerUtilsSupport.js';

// ---- 常量 ----

// 内核级常量统一由生命周期管理器持有，这里只做本地取用
const { DEBUGING, ROOT_PATH, APP_NAME, APP_VERSION, ANSI } = neonaicLifeCycleManager;

// ---- 安全关闭 ----

/**
 * 优雅关闭：由生命周期管理器按注册顺序的反向执行全部关闭步骤。
 * @param {string} signal 触发关闭的原因
 */
async function shutdown(signal) {
  return neonaicLifeCycleManager.shutdown(signal);
}

// ---- 系统级 CLI 命令 ----

neonaicCommandServer.registerCommand('neonaic', 'version', function () {
  /** @type {import('#/command/commandServer.js').NeonaicCommandContext} */
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
  if (!ctx.internalCall) projectName = 'Neo' + 'nai' + 'Connector';

  const AUTHOR = 'kdxiaoyi' + ' & ' + 'StreackMC' + ' Tea' + 'm';
  const CPR = 'Copy' + 'right ' + (/\u00A9/.test('\u00A9') ? '\u00A9' : '(c)') + ' 2026 ' + AUTHOR.split(' & ')[0] + ', ' + AUTHOR.split(' & ')[1];
  const LICENSE = 'AGPL' + '-3.0' + ' (with a' + 'dditional terms)';
  const REPO = 'https' + '://' + 'github' + '.com' + '/' + 'Strea' + 'ckMC' + '/' + 'Neo' + 'nai-Connector';

  const B = ANSI.bold;
  const C = ANSI.cyan;
  const D = ANSI.dim;
  const R = ANSI.reset;

  return (
    `${B}${projectName}${R} v${APP_VERSION}\n` +
    `${D}----------------------------${R}\n` +
    `${B}作者${R}    ${AUTHOR}\n` +
    `${B}版权${R}   ${LICENSE}\n` +
    `${B}    ${R}   ${CPR}\n` +
    `${B}网址${R}      ${REPO}\n` +
    `${D}----------------------------${R}\n`
  );
}, {
  description: '显示版本与版权信息',
  alias: ["ver", "about"],
  permissions: ['neonaic.command.version'],
  permissionDefault: true,
});

neonaicCommandServer.registerCommand('neonaic', 'ping', function () {
  // ---- 格式化字符 ----
  const B = ANSI.bold;
  const C = ANSI.cyan;
  const D = ANSI.dim;
  const R = ANSI.reset;

  // ---- 运行时读取 ----
  const nodeVer = process.version;
  const osVer = platform() + ' ' + release();
  const cwd = process.cwd();
  const tmp = tmpdir();

  // ---- 额外信息 ----
  const mayShowAdditionalSys = neonaicPermissionServer.checkPermissionFromContext(this, [[neonaicCommandInterface.COMMAND_ENUMS.PERM_SUPERADMIN, "neonaic.commmand.version.detailed"]]);
  const AdditionalSysLine = mayShowAdditionalSys ? ([
    "\n",
    `${B}Node.js版本：${R}${nodeVer}`,
    `${B}操作系统：${R}${osVer}`,
    `${B}工作目录：${R}${cwd}`,
    `${B}PID：${R}${process.pid}`,
    `${B}父进程PID：${R}${process.ppid}`,
    `${B}内存：${R}已用${neonaicChore.parseStorageText(process.memoryUsage().rss)}`,
    `${B}临时目录：${R}${tmp}`,
    `${B}调试模式：${R}${DEBUGING ? '✓ 已启用' : '× 未启用'}`,
  ].join('\n')) : '';
  return [
    "Pong!",
    `${B}Neonaic版本：${R}${APP_VERSION}`,
    `${B}已运行：${R}${neonaicChore.parseDuration2Text(neonaicLifeCycleManager.KEEP_ALIVE_INTERVAL_MS)}`,
  ].join('\n') + AdditionalSysLine;
}, {
  description: '获取 Neonai Connector 的运行状态',
  permissions: ['neonaic.command.ping'],
  permissionDefault: true,
});

neonaicCommandServer.registerCommand('neonaic', 'stop', function () {
  shutdown('COMMAND');
}, {
  description: '安全关闭服务',
  permissions: [[neonaicCommandInterface.COMMAND_ENUMS.PERM_SUPERADMIN, "neonaic.commmand.stop"]],
});

// ---- 启动 ----

/** 启动流程 */
async function bootstrap() {
  const when_started = new Date();

  getLogger().main.info(`正在启动 ${APP_NAME} v${APP_VERSION}`);

  // 内核生命周期：PID 锁、事件循环保活、SIGNAL 监听（含退出时释放 PID 锁）
  // 这三件事与「有没有平台 / 有没有拓展」无关，必须在任何可能失败的动作之前完成
  neonaicLifeCycleManager.start();

  // 调试模式分支
  if (DEBUGING) {
    // 调试模式：console 走原生输出，设置全局标志位，启用 $()
    neonaicLogger.setDebugMode(true);
    globalThis.$ = (input) => {
      const args = neonaicCommandServer.resolveCommandArgs(String(input));
      const [cmdName, cmdArgs] = args;
      const result = neonaicCommandServer.executeCommand(cmdName, { internalCall: true, privateExecutor: true }, ...cmdArgs);
      return result;
    };
    getLogger().main.warn('你正处于调试模式，已启用某些有助于调试的特性。');
  } else {
    // 正常模式：劫持 console 到日志系统
    globalThis.$ = null;
    getLogger().redirectConsole(true);
  }

  getLogger().platM.debug(`初始化平台管理器`);
  // 初始化平台管理器（单例）
  new PlatformManager({
    configPath: resolve(ROOT_PATH, 'secret.json'),
    logger: getLogger(),
  });

  // 立即启动 CLI，让提示符尽快出现（平台加载不阻塞交互）
  getLogger().main.debug(`初始化 CLI 交互`);
  neonaicCliProcessor.startCLI();

  // 日志输出与 REPL 提示符协作：每次输出先清掉旧提示符，输出后重绘新提示符
  neonaicLogger.setConsoleHooks(neonaicCliProcessor.erasePrompt, neonaicCliProcessor.redrawPrompt);

  // 关闭步骤：后注册的先执行，所以按「pid-lock → platforms → extensions → cli」注册，
  // 实际执行顺序是 CLI → 拓展 → 平台 → PID 锁（先把提示符收起来，再拆上层依赖）。
  // 在拓展加载之前注册，是为了让「加载到一半失败」也能走完整套关闭流程。
  neonaicLifeCycleManager.registerCloser('platforms', async () => {
    const pm = PlatformManager.instance;
    if (!pm) return;
    await Promise.allSettled(pm.getClosers().map((close) => close()));
  });
  neonaicLifeCycleManager.registerCloser('extensions', async () => {
    const status = await neonaicExtensionManager.unloadAll();
    status.failed.forEach((item) => {
      getLogger().extH.error(`拓展“${item.id}”卸载失败：${item.error?.message ?? '未知原因'}`);
    });
  });
  neonaicLifeCycleManager.registerCloser('cli', () => neonaicCliProcessor.stopCLI());

  // 自动发现并加载扩展
  getLogger().extH.info(`正在加载可用拓展`);
  const extResult = await neonaicExtensionManager.loadAll([...(await neonaicExtensionManager.scan()).keys()]);
  getLogger().extH.info(`启动了${extResult.succeed.length}个拓展，另有${extResult.disabled.length}个拓展已被禁用。`);
  // 逐个列出加载失败的拓展，否则失败会静默埋在 debug 级 dump 里
  extResult.failed.forEach((item) => {
    getLogger().extH.error(`拓展“${item.id}”加载失败：${item.error?.message ?? '未知原因'}`);
  });
  getLogger().extH.debug(extResult);

  // 安装权限管理命令（permission/perm）：需在 commandServer 就绪后，避免循环依赖
  getLogger().cmd.debug(`初始化惰性管理命令`);
  neonaicPermissionServer.installPermissionCommands(neonaicCommandServer.registerCommand);
  neonaicConfManager.installConfigCommands(neonaicCommandServer.registerCommand);

  // 安装未分类的命令或AI工具
  getLogger().cmd.debug(`注册内置增强型命令或AI工具`);
  neonaicUtilsSupport.register();

  // 按配置启动已启用的平台
  getLogger().platM.info(`正在加载 Platform Profile`);
  PlatformManager.instance.loadEnabled();

  // 顶层未捕获异常：写崩溃报告后走安全关闭流程
  process.on('uncaughtException', (err) => {
    getLogger().main.error(`未捕获异常:`, err);
    getLogger().writeCrashReport(err);
    getLogger().main.error(`如果问题反复出现，请检查拓展运行，仍未解决请报告给我们→ https://github.com/StreackMC/Neonai-Connector/issues/new/choose`);
    // shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    getLogger().main.error(`未处理的 Promise 拒绝异常:`, err);
    getLogger().writeCrashReport(err);
    getLogger().main.error(`如果问题反复出现，请检查拓展运行，仍未解决请报告给我们→ https://github.com/StreackMC/Neonai-Connector/issues/new/choose`);
    // shutdown('unhandledRejection');
  });

  // LoadedEvent
  neonaicEventBus.dispatchEvent(new NeonaicLoadedEvent({ cancelable: false }));

  getLogger().main.info(`已启动“${neonaicConfManager.getBotName()}”，耗时 ${new Date() - when_started}ms。`);
}

export const neonaicEntry = {
  // 常量已移交 neonaicLifeCycleManager；这里保留同名转发，便于调试脚本沿用旧引用
  DEBUGING,
  ROOT_PATH,
  APP_NAME,
  APP_VERSION,
  PID_FILE_PATH: neonaicLifeCycleManager.PID_FILE_PATH,
  bootstrap,
};
