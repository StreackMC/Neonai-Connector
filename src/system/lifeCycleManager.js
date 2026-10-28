/**
 * lifeCycleManager.js — 内核生命周期管理器
 *
 * 职责：
 *   1. 持有内核级常量（调试标志、项目根路径、名称/版本、PID 锁路径、终端配色）
 *   2. 维护事件循环保活 —— 没有任何平台、没有任何拓展时，进程也应当常驻而不是静默退出
 *   3. 编排关闭流程 —— 注册的 closer 按「后进先出」执行，幂等、有超时兜底
 *
 * 为什么保活必须放在这里，而不是 CLI 层：
 *   - `cliProcessor` 是终端 UI，没有 TTY（systemd / 容器 / 重定向）时它会提前 return，
 *     顺带把保活一起丢掉；
 *   - `stopCLI()` 的本意是「收起提示符」，却会连进程的生命周期一起停掉，语义错位。
 *   把保活收进这里之后，「内核是否该活着」只由本模块回答，与 UI 是否可用无关。
 *
 * 状态机：idle → running → stopping → stopped
 *   `start()` 只允许从 idle 进入；`shutdown()` 幂等，重复调用共用同一次关闭流程。
 *
 * @since 0.1.0
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { neonaicConfManager } from './confManager.js';
import { neonaicPidManager } from './pidManager.js';
import { getLogger } from '../logger/Logger.js';
import { NeonaicIllegalArgumentError, NeonaicIllegalStateError } from '../utils/NeonaicNewableError.js';

// ---- 常量 ----

/** 是否处于调试模式（`--debug` / `--debug=true`） */
const DEBUGING = process.argv.some((a) => a === '--debug=true' || a === '--debug');
/** 项目根路径（本文件位于 `<root>/src/system/`） */
const ROOT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** 项目名称 */
const APP_NAME = neonaicConfManager.getConfig(neonaicConfManager.CONFIG_PATHS.app).getString('name', 'neonai-connector');
/** 项目版本 */
const APP_VERSION = neonaicConfManager.getConfig(neonaicConfManager.CONFIG_PATHS.app).getString('version', '0.0.0');
/** PID 锁文件路径 */
const PID_FILE_PATH = resolve(ROOT_PATH, '.neonai.pid');

/** 终端配色（内核级输出共用，避免转义序列散落各处） */
const ANSI = Object.freeze({
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
});

/**
 * 保活心跳间隔。
 *
 * @apiNote 这个定时器**只**用于持住事件循环，不做任何业务。所以间隔取长一点，
 *          别把它当定时任务用（那会让「保活」和「调度」两件事纠缠在一起）。
 */
const KEEP_ALIVE_INTERVAL_MS = 60 * 60 * 1000;
/** 关闭流程的总时限，超时强制退出（避免某个 closer 卡死拖住进程） */
const SHUTDOWN_TIMEOUT_MS = 5000;

/** 生命周期状态 */
const STATE = Object.freeze({
  idle: 'idle',
  running: 'running',
  stopping: 'stopping',
  stopped: 'stopped',
});

// ---- 内部状态 ----

/** 当前状态 @type {string} */
let _state = STATE.idle;
/** 保活句柄；非 null 即表示事件循环被本模块持住 @type {NodeJS.Timeout|null} */
let _keepAliveTimer = null;
/** 启动时刻（毫秒时间戳），未启动时为 0 */
let _startedAt = 0;
/** 关闭步骤：名字 → closer。Map 保留插入顺序，关闭时反向遍历 */
const _closers = new Map();
/** 进行中的关闭流程，用于保证幂等 @type {Promise<Object>|null} */
let _stopping = null;
/** 信号监听是否已挂载 */
let _signalsInstalled = false;

// ---- 保活 ----

/**
 * 开启事件循环保活。
 *
 * 只要有一个 ref 状态的 handle 存在，Node 就不会因为「没事可做」而退出；
 * 定时器正是这样一个 handle，且比 `process.stdin.resume()` 更干净
 * （后者会抢占输入流，跟 readline 打架，还会让进程无法自然退出）。
 *
 * @returns {boolean} 本次是否新开了句柄（已在保活时返回 false）
 */
function startKeepAlive() {
  if (_keepAliveTimer) return false;
  _keepAliveTimer = setInterval(() => { }, KEEP_ALIVE_INTERVAL_MS);
  // setInterval 默认就是 ref 的。显式 ref 一次是把意图写进代码：
  // 谁取消引用，谁就要为「进程随后自行退出」负责。
  _keepAliveTimer.ref?.();
  return true;
}

/**
 * 停止保活。调用后若再无其他 ref handle，进程会自然退出。
 * @returns {boolean} 本次是否真的停掉了句柄
 */
function stopKeepAlive() {
  if (!_keepAliveTimer) return false;
  clearInterval(_keepAliveTimer);
  _keepAliveTimer = null;
  return true;
}

// ---- 信号 ----

/**
 * 挂载 SIGINT / SIGTERM 处理（幂等）。
 * @returns {boolean} 本次是否真的挂载了
 */
function installSignalHandlers() {
  if (_signalsInstalled) return false;
  _signalsInstalled = true;

  const onSignal = (signal) => {
    // shutdown 内部已捕获所有异常，这里兜一层只为避免「关闭流程自己炸出未处理拒绝」
    shutdown(signal).catch((err) => {
      try {
        console.error('[FATAL] 关闭流程异常:', err);
      } catch { /* 终端可能已不可用 */ }
      process.exit(1);
    });
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    getLogger().main.debug('已挂载 SIGNAL 监听（SIGINT / SIGTERM）');
  } catch { /* 日志系统不可用时不影响信号处理 */ }
  return true;
}

// ---- 关闭步骤 ----

/**
 * 注册一个关闭步骤。
 *
 * @param {string} name 唯一名字。重复注册会**覆盖**，并沿用原有位置（不改变执行顺序）。
 * @param {() => (void|Promise<void>)} closer 关闭动作，可为异步
 * @returns {() => boolean} 取消注册；已执行过关闭流程时返回 false
 * @throws {NeonaicIllegalArgumentError} 名字为空或 closer 不是函数
 */
function registerCloser(name, closer) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new NeonaicIllegalArgumentError('关闭步骤需要一个非空名字');
  }
  if (typeof closer !== 'function') {
    throw new NeonaicIllegalArgumentError(`关闭步骤“${name}”必须是一个函数`);
  }
  _closers.set(name, closer);
  return () => _closers.delete(name);
}

/**
 * @typedef {Object} NeonaicTLifeCycleStopReport
 * @property {string} reason 触发关闭的原因（信号名、命令名等）
 * @property {{name: string, elapsedMs: number}[]} ok 执行成功的步骤
 * @property {{name: string, error: Error}[]} failed 抛错的步骤（不会中断后续步骤）
 * @property {number} elapsedMs 整个关闭流程耗时
 */

/**
 * 执行关闭流程，**不退出进程**。
 *
 * 幂等：重复调用返回同一个 Promise，关闭步骤只跑一次。
 *
 * @param {string} [reason='UNKNOWN'] 关闭原因，仅用于日志与报告
 * @returns {Promise<NeonaicTLifeCycleStopReport>}
 */
function stop(reason = 'UNKNOWN') {
  if (_stopping) return _stopping;
  _stopping = runStop(reason);
  return _stopping;
}

/**
 * 关闭流程的实际实现。
 *
 * 顺序是**反向**的：后注册的 closer 通常依赖先注册的那些（例如拓展依赖平台连接），
 * 所以要先拆后者。某个 closer 抛错不会中断整条链路，只会被记进报告。
 *
 * @param {string} reason 关闭原因
 * @returns {Promise<NeonaicTLifeCycleStopReport>}
 * @private
 */
async function runStop(reason) {
  const began = Date.now();
  _state = STATE.stopping;

  /** @type {{name: string, elapsedMs: number}[]} */
  const ok = [];
  /** @type {{name: string, error: Error}[]} */
  const failed = [];

  try {
    getLogger().main.warn(`收到 ${reason}，正在关闭…`);
  } catch { /* 日志系统可能已经半死不活 */ }

  for (const [name, closer] of [..._closers].reverse()) {
    const stepBegan = Date.now();
    try {
      await closer();
      ok.push({ name, elapsedMs: Date.now() - stepBegan });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      failed.push({ name, error: err });
      try {
        getLogger().main.error(`关闭步骤“${name}”失败：`, err);
      } catch { /* 同上 */ }
    }
  }

  // 保活必须留到最后再关：中途清掉它，此刻若没有别的 ref handle，
  // 事件循环会立即空转退出，后面的关闭步骤就再也跑不到了。
  stopKeepAlive();

  _state = STATE.stopped;
  return { reason, ok, failed, elapsedMs: Date.now() - began };
}

/**
 * 关闭并退出进程（信号、`neonaic:stop` 命令、致命错误都走这里）。
 *
 * @param {string} [reason='UNKNOWN'] 关闭原因
 * @returns {Promise<never>}
 */
async function shutdown(reason = 'UNKNOWN') {
  // 兜底：任何 closer 卡死都不该拖住进程
  const forceTimer = setTimeout(() => {
    try {
      getLogger().main.error(`关闭超时（${SHUTDOWN_TIMEOUT_MS}ms），强制退出`);
    } catch { /* 同上 */ }
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceTimer.unref?.();

  const report = await stop(reason);
  clearTimeout(forceTimer);

  try {
    getLogger().main.info(
      `服务已关闭（${report.ok.length} 个步骤成功` +
      `${report.failed.length ? `，${report.failed.length} 个失败` : ''}，耗时 ${report.elapsedMs}ms）`,
    );
  } catch { /* 同上 */ }

  // 调试模式下留一个断点，方便查看关闭时的现场
  if (DEBUGING) debugger;
  process.exit(0);
}

// ---- 启动 ----

/**
 * 启动内核：取 PID 锁、挂信号、开保活。
 *
 * @returns {boolean} 本次是否真的启动了（已在运行时返回 false）
 * @throws {NeonaicIllegalStateError} 已进入关闭流程，或检测到已有实例在运行
 */
function start() {
  if (_state === STATE.running) return false;
  if (_state === STATE.stopping || _state === STATE.stopped) {
    throw new NeonaicIllegalStateError(`生命周期已进入“${_state}”，无法重新启动`);
  }

  neonaicPidManager.acquirePidLock(PID_FILE_PATH, getLogger());
  // 兜底：无论从哪条路径退出（包括 process.exit），都别把锁文件留在磁盘上
  process.once('exit', () => neonaicPidManager.releasePidLock(PID_FILE_PATH));

  _startedAt = Date.now();
  _state = STATE.running;

  startKeepAlive();
  installSignalHandlers();
  // 第一个注册 → 最后一个执行：PID 锁要等所有资源都放开后再释放
  registerCloser('pid-lock', () => neonaicPidManager.releasePidLock(PID_FILE_PATH));
  return true;
}

export const neonaicLifeCycleManager = {
  // ---- 常量 ----
  DEBUGING,
  ROOT_PATH,
  APP_NAME,
  APP_VERSION,
  PID_FILE_PATH,
  ANSI,
  STATE,
  KEEP_ALIVE_INTERVAL_MS,
  SHUTDOWN_TIMEOUT_MS,

  // ---- 状态 ----
  get state() { return _state; },
  /** 是否处于运行中 */
  get running() { return _state === STATE.running; },
  /** 事件循环是否正被本模块持住 */
  get keepAliveActive() { return _keepAliveTimer !== null; },
  /** 已运行时长（毫秒），未启动时为 0 */
  get uptimeMs() { return _startedAt ? Date.now() - _startedAt : 0; },
  /** 已注册的关闭步骤名（按注册顺序，执行时反向） */
  get closerNames() { return [..._closers.keys()]; },

  // ---- 操作 ----
  start,
  installSignalHandlers,
  startKeepAlive,
  stopKeepAlive,
  registerCloser,
  stop,
  shutdown,
};
