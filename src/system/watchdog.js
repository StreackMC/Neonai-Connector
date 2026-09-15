/**
 * watchdog.js — 看门狗（主进程侧）
 *
 * 职责：
 *   1. 按期「喂狗」（默认 10s 一次），判定本身交给 Worker —— 原因见 watchdog.worker.js 开头；
 *   2. 把 Worker 的判定结果转成可读日志（卡死 / 已恢复 / 即将强杀 / 强杀失败）；
 *   3. 提供 {@link restart}：拉起新实例 → 交出 PID 锁与终端 → 退出，供 `/restart` 命令与优雅重启使用；
 *      「主线程卡死」那条路不经过这里，由 Worker 直接强杀（它才是不受阻塞影响的那一方）。
 *   4. 用「重启退避」避免反复重启：连续重启时逐次拉长下一次动手前的等待，稳定运行一段时间后清零。
 *
 * 与 `/restart` 命令共用同一条重启路径（{@link restart}），区别只在退避计数：
 * 人工触发的重启把计数清零，看门狗触发的才累加。
 *
 * 配置见 config/main.json 的 `watchdog` 段，全部有默认值，缺失也能跑。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { getLogger } from '../logger/Logger.js';
import { neonaicConfManager } from './confManager.js';
import { neonaicPidManager } from './pidManager.js';
import { neonaicRestartProcess } from './restartProcess.js';

/** 项目根路径（与 entry.js 同一算法；不 import entry.js 以免形成循环依赖） */
const ROOT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** 重启退避的状态文件，与 `.neonai.pid` 同目录、同样不入库 */
const STATE_FILE = resolve(ROOT_PATH, '.neonai.watchdog.json');

/** 配置默认值，可被 config/main.json 的 `watchdog` 段逐项覆盖 */
const DEFAULT_CONFIG = Object.freeze({
  /** 是否启用看门狗 */
  enabled: true,
  /** 超过这么久没有喂狗即视为卡死（毫秒） */
  timeoutMs: 2 * 60 * 1000,
  /** 主程序喂狗的间隔（毫秒），须明显小于 timeoutMs */
  feedIntervalMs: 10 * 1000,
  /** 判定卡死后的宽限时间（毫秒）：期间恢复喂狗就取消本次重启 */
  graceMs: 5 * 1000,
  /** 重启退避的起点（毫秒） */
  backoffInitialMs: 1000,
  /** 重启退避的倍率 */
  backoffMultiplier: 2,
  /** 重启退避的上限（毫秒） */
  backoffMaxMs: 5 * 60 * 1000,
  /** 稳定运行超过这么久就把退避计数清零（毫秒） */
  backoffResetMs: 10 * 60 * 1000,
});

/** 需要按数字读取的配置键 */
const NUMERIC_KEYS = [
  'timeoutMs', 'feedIntervalMs', 'graceMs',
  'backoffInitialMs', 'backoffMultiplier', 'backoffMaxMs', 'backoffResetMs',
];

// ---- 运行期状态 ----

/** @type {Worker|null} */
let worker = null;
/** @type {NodeJS.Timeout|null} 喂狗定时器 */
let feedTimer = null;
/** 本轮生效的配置 @type {typeof DEFAULT_CONFIG} */
let currentConfig = { ...DEFAULT_CONFIG };
/** PID 锁文件路径 @type {String|null} */
let pidFilePath = null;
/** 重启前的清理动作（由组合根注入：停 CLI、释放平台） @type {(() => Promise<void>)|null} */
let beforeExit = null;
/** 最近一次喂狗的时间 @type {number} */
let lastFeedAt = 0;

// ---- 配置 ----

/**
 * 读取看门狗配置。
 * @param {Partial<typeof DEFAULT_CONFIG>} [overrides] 覆盖项（供调试与自检脚本使用更短的超时）
 * @returns {typeof DEFAULT_CONFIG>} 补齐默认值并做过一致性兜底的配置
 */
function readConfig(overrides) {
  const cfg = { ...DEFAULT_CONFIG };
  try {
    const conf = neonaicConfManager.getConfig(neonaicConfManager.CONFIG_PATHS.main);
    cfg.enabled = conf.getBoolean('watchdog.enabled', cfg.enabled);
    for (const key of NUMERIC_KEYS) cfg[key] = conf.getInt(`watchdog.${key}`, cfg[key]);
  } catch (error) {
    // 配置读不到就用默认值：看门狗不该因为读配置失败而跟着罢工
    getLogger().watchdog.warn('读取看门狗配置失败，改用默认值：', error?.message ?? error);
  }
  Object.assign(cfg, overrides ?? {});
  // 兜底：喂狗间隔必须明显小于超时，否则每轮都会被判卡死
  if (!(cfg.timeoutMs > cfg.feedIntervalMs)) {
    cfg.feedIntervalMs = Math.min(10000, Math.max(50, Math.floor(cfg.timeoutMs / 4)));
  }
  if (!(cfg.backoffMultiplier >= 1)) cfg.backoffMultiplier = DEFAULT_CONFIG.backoffMultiplier;
  return cfg;
}

/**
 * 第 `attempts` 次连续重启前要等的时长。
 * @param {number} attempts 已连续重启的次数，0 表示还没重启过（首次立即重启）
 * @param {typeof DEFAULT_CONFIG} [cfg] 配置，缺省用当前配置
 * @returns {number} 毫秒
 */
function nextDelay(attempts, cfg = currentConfig) {
  if (!(attempts > 0)) return 0;
  return Math.min(
    cfg.backoffInitialMs * Math.pow(cfg.backoffMultiplier, attempts - 1),
    cfg.backoffMaxMs,
  );
}

/**
 * 读取退避状态文件。
 * @returns {{attempts: number, lastAt: number}}
 */
function readState() {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return { attempts: Number(raw?.attempts) || 0, lastAt: Number(raw?.lastAt) || 0 };
  } catch {
    return { attempts: 0, lastAt: 0 };
  }
}

/** 写入退避状态文件 @param {{attempts: number, lastAt: number}} state */
function writeState(state) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');
  } catch (error) {
    getLogger().watchdog.warn('写入重启退避状态失败：', error?.message ?? error);
  }
}

/**
 * 当前应当使用的退避计数。
 * @param {typeof DEFAULT_CONFIG} [cfg] 配置
 * @returns {number} 距上次重启已超过 backoffResetMs 时返回 0（视为已经稳定运行）
 */
function currentAttempts(cfg = currentConfig) {
  const { attempts, lastAt } = readState();
  if (Date.now() - lastAt >= cfg.backoffResetMs) return 0;
  return Math.max(0, Math.trunc(attempts));
}

// ---- 启停 ----

/**
 * 启动看门狗。
 * @param {{ pidFile?: String, onBeforeExit?: () => Promise<void>, overrides?: Partial<typeof DEFAULT_CONFIG> }} [options]
 * @returns {boolean} 是否真的启动了（配置禁用时返回 false）
 */
function start(options = {}) {
  if (worker) {
    getLogger().watchdog.warn('看门狗已经在运行，忽略本次启动');
    return false;
  }
  const cfg = readConfig(options.overrides);
  currentConfig = cfg;
  pidFilePath = options.pidFile ?? null;
  beforeExit = options.onBeforeExit ?? null;

  if (!cfg.enabled) {
    getLogger().watchdog.info('看门狗已禁用（config/main.json 的 watchdog.enabled）');
    return false;
  }

  const attempts = currentAttempts(cfg);
  const delayMs = nextDelay(attempts, cfg);

  worker = new Worker(new URL('./watchdog.worker.js', import.meta.url), {
    workerData: {
      timeoutMs: cfg.timeoutMs,
      graceMs: cfg.graceMs,
      delayMs,
      attempts,
      pidFile: pidFilePath,
      stateFile: STATE_FILE,
      // Worker 里的 process.argv 是它自己的入口文件，重启命令必须由主线程带过去
      argv: process.argv.slice(1),
    },
    // execArgv 会被 Worker 继承，而 --input-type / --eval / --print 对文件入口的 Worker 非法，
    // 会让 Worker 直接启动失败（看门狗静默失效）。这些只与「怎么跑起来的」有关，滤掉即可。
    execArgv: process.execArgv.filter((flag) => !/^--(input-type|eval|print)(=|$)/.test(flag)),
  });
  worker.on('message', onWorkerMessage);
  worker.on('error', (error) => getLogger().watchdog.error('看门狗线程异常：', error));
  worker.on('exit', (code) => getLogger().watchdog.warn(`看门狗线程已退出（code ${code}）`));
  // 看门狗只负责「该出手时出手」，不该成为「进程不肯退出」的原因
  worker.unref();

  feedTimer = setInterval(feed, cfg.feedIntervalMs);
  feedTimer.unref();
  feed();

  getLogger().watchdog.info(
    `看门狗已启动：${cfg.timeoutMs / 1000}s 未喂狗即判定卡死，喂狗间隔 ${cfg.feedIntervalMs / 1000}s`
    + (delayMs ? `；因已连续重启 ${attempts} 次，本次会先退避 ${delayMs / 1000}s` : ''),
  );
  return true;
}

/** 停止看门狗（不重启，仅回收） */
function stop() {
  if (feedTimer) { clearInterval(feedTimer); feedTimer = null; }
  const w = worker;
  worker = null;
  if (w) {
    try { w.postMessage('stop'); } catch { /* Worker 可能已不可用 */ }
    w.removeAllListeners();
    w.terminate().catch(() => { /* 忽略终止错误 */ });
  }
}

/** 喂狗：告诉判定侧「主程序还活着」 */
function feed() {
  lastFeedAt = Date.now();
  try { worker?.postMessage('feed'); } catch { /* Worker 已退出 */ }
}

/**
 * 把毫秒数写成便于阅读的时长
 * @param {number} ms
 * @returns {String}
 */
function humanMs(ms) {
  const n = Math.max(0, Number(ms) || 0);
  return n >= 1000 ? `${Math.round(n / 1000)}s` : `${Math.round(n)}ms`;
}

/**
 * Worker 的消息处理
 * @param {{type: String, waitedMs?: number, killInMs?: number, error?: String}} message
 */
function onWorkerMessage(message) {
  const log = getLogger().watchdog;
  switch (message?.type) {
    case 'stalled': {
      log.warn(`主程序已 ${humanMs(message.waitedMs)} 未喂狗，${humanMs(message.killInMs)} 内仍未恢复将强杀并重启`);
      break;
    }
    case 'recovered':
      log.warn('主程序已恢复喂狗，取消本次重启');
      break;
    case 'killing':
      log.error('主程序未能恢复，看门狗将强杀当前进程并拉起新实例');
      break;
    case 'failed':
      log.error(`看门狗拉起新实例失败：${message.error ?? '未知原因'}，本次不强杀，等待下一次判定`);
      break;
    default:
      break;
  }
}

// ---- 重启 ----

/**
 * 重启进程：拉起新实例 → 释放 PID 锁 → 跑一遍清理动作 → 退出当前进程。
 * @apiNote 顺序刻意如此：先确认新实例真的起来了，再交出 PID 锁与终端，
 *          避免「拉不起来却已经退位」把服务弄丢。
 * @param {String} reason 触发原因，会写进日志
 * @param {{ manual?: boolean }} [options] `manual` 为 true（默认）表示人工触发，会把退避计数清零
 * @returns {Promise<boolean>} 是否成功拉起了新实例
 */
async function restart(reason, options = {}) {
  const { manual = true } = options;
  const log = getLogger().watchdog;
  const cfg = currentConfig ?? readConfig();

  log.warn(`正在重启进程（${reason}）`);

  // 记账：人工重启视为回到健康状态；看门狗触发的才累加退避计数
  const previous = readState();
  writeState({ attempts: manual ? 0 : (previous.attempts ?? 0) + 1, lastAt: Date.now() });

  // 通知判定侧别再动手（它随后会随本进程一起退出）
  try { worker?.postMessage('restarting'); } catch { /* Worker 已不可用 */ }

  let pid;
  try {
    pid = await neonaicRestartProcess.spawnReplacement();
  } catch (error) {
    log.error(`拉起新实例失败：${error?.message ?? error}，取消本次重启`);
    return false;
  }
  log.info(`新实例已拉起（PID ${pid}），当前进程即将退出`);

  if (pidFilePath) neonaicPidManager.releasePidLock(pidFilePath);
  stop();
  try {
    await beforeExit?.();
  } catch (error) {
    log.warn('重启前的清理动作出错（不影响新实例）：', error?.message ?? error);
  }
  // 留一点时间让日志落盘（文件 appender 是异步的，立刻 process.exit 会丢这一段）
  await new Promise((resolve) => { setTimeout(resolve, 300); });
  log.info(`重启完成，交接给 PID ${pid}`);
  process.exit(0);
}

/** 取当前状态快照（诊断用） */
function getStatus() {
  const cfg = currentConfig ?? readConfig();
  const attempts = currentAttempts(cfg);
  return {
    running: !!worker,
    since: lastFeedAt,
    attempts,
    nextDelayMs: nextDelay(attempts, cfg),
    config: cfg,
  };
}

export const neonaicWatchdog = {
  DEFAULT_CONFIG,
  STATE_FILE,
  readConfig,
  nextDelay,
  currentAttempts,
  start,
  feed,
  stop,
  restart,
  getStatus,
  /** 看门狗是否在运行 */
  get isRunning() { return !!worker; },
};
