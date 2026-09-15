/**
 * watchdog.worker.js — 看门狗的「判定侧」（Worker 线程）
 *
 * 为什么非要开一个线程：主线程一旦被同步代码卡死，它自己的 `setTimeout` 同样不会触发，
 * 同线程的看门狗就永远发现不了「没喂狗」。Worker 跑在独立线程上，主线程卡住时它照样计时、
 * 照样能动手（spawn 新进程 + `SIGKILL`）。
 *
 * 协议（对 watchdog.js）：
 *   收到 'feed'       主线程喂狗，重新计时
 *   收到 'restarting' 主线程已接管重启（它在正常退出），放弃强杀
 *   收到 'stop'       停止看门狗
 *   发出 'stalled'    超过 timeoutMs 未喂狗
 *   发出 'recovered'  宽限期内恢复喂狗，取消本次重启
 *   发出 'killing'    宽限期已过，即将强杀并拉起新进程
 *   发出 'failed'     拉起新进程失败，放弃本次强杀（继续等下一次）
 *
 * @apiNote 本文件是 `new Worker()` 的入口，只通过消息与主线程通信，
 *          因此不做任何导出 —— 它不是被 import 的模块。
 */

import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';

import { neonaicRestartProcess } from './restartProcess.js';

// 只作为 Worker 入口：直接 import 是拿不到 parentPort 的。
// 这里刻意抛裸 Error —— import 错误类会顺着 NeonaicNewableError → chore.js → confManager
// 把 Logger 与 NeonaicConfig（含配置文件监视器）整套拖进 Worker 线程，代价远大于收益。
if (!parentPort) throw new Error('watchdog.worker.js 只能由 new Worker() 加载，不能直接 import');

const { timeoutMs, graceMs, delayMs, attempts, pidFile, stateFile, argv } = workerData ?? {};

/**
 * 记一笔「又重启了一次」，供下一次启动推算退避时长。
 * @apiNote `attempts` 是主进程已经按 backoffResetMs 归过零的值，这里只负责 +1；
 *          同样刻意不 import watchdog.js（会把配置与日志拖进 Worker）。
 */
function bumpRestartCount() {
  if (!stateFile) return;
  try {
    writeFileSync(stateFile, JSON.stringify({ attempts: (attempts ?? 0) + 1, lastAt: Date.now() }), 'utf8');
  } catch {
    // 记账失败不影响重启本身
  }
}

/**
 * 释放 PID 锁（仅当锁内 PID 是当前进程时）。
 * @apiNote 刻意不 import pidManager.js：那条链会经 NeonaicNewableError → chore → confManager
 *          把 Logger 与 NeonaicConfig（含配置文件监视器）整套拖进 Worker 线程，
 *          而这里只需要 6 行 fs 操作。
 * @param {String} file 锁文件路径
 */
function releasePidLockQuietly(file) {
  try {
    if (Number.parseInt(readFileSync(file, 'utf8'), 10) !== process.pid) return;
    unlinkSync(file);
  } catch {
    // 锁文件不存在或已被接棒进程改写：都不影响重启
  }
}

/** 判定「卡死」的计时器 @type {NodeJS.Timeout|null} */
let stallTimer = null;
/** 判定「确实该动手了」的计时器 @type {NodeJS.Timeout|null} */
let killTimer = null;
/** 当前是否处在「已判卡死、等宽限期」的状态 @type {boolean} */
let stalled = false;

/** 重新开始等待喂狗 */
function armStall() {
  if (stallTimer) clearTimeout(stallTimer);
  stallTimer = setTimeout(onStall, timeoutMs);
}

/** 主线程超时未喂狗 */
function onStall() {
  stalled = true;
  // 退避：连续重启时先等一会儿再动手，期间若恢复喂狗则取消（见 onFeed）
  const killIn = graceMs + delayMs;
  parentPort.postMessage({ type: 'stalled', waitedMs: timeoutMs, killInMs: killIn });
  if (killTimer) clearTimeout(killTimer);
  killTimer = setTimeout(onKill, killIn);
}

/** 宽限期已过：拉起新进程，然后强杀自己 */
async function onKill() {
  killTimer = null;
  parentPort.postMessage({ type: 'killing' });
  try {
    // argv 必须由主线程传进来：Worker 里 process.argv 指向的是 Worker 自己的入口文件
    await neonaicRestartProcess.spawnReplacement(argv);
  } catch (error) {
    // 拉不起新进程还把自己杀了，就彻底没人干活了 —— 宁可继续等下一次
    parentPort.postMessage({ type: 'failed', error: String(error?.message ?? error) });
    stalled = false;
    armStall();
    return;
  }
  // 新进程正在等这把锁，先释放再让自己死掉；即便不释放，它也认得出锁里是已死的 PID
  bumpRestartCount();
  releasePidLockQuietly(pidFile);
  process.kill(process.pid, 'SIGKILL');
}

/** 收到喂狗 */
function onFeed() {
  if (stalled) {
    // 在动手之前缓过来了，取消本次重启（退避的意义就在这里：别为一次抖动就重启）
    stalled = false;
    if (killTimer) { clearTimeout(killTimer); killTimer = null; }
    parentPort.postMessage({ type: 'recovered' });
  }
  armStall();
}

/** 停止看门狗 */
function onStop() {
  if (stallTimer) clearTimeout(stallTimer);
  if (killTimer) clearTimeout(killTimer);
  stallTimer = null;
  killTimer = null;
  parentPort.close();
}

/** 主线程已接管重启 */
function onRestarting() {
  if (stallTimer) clearTimeout(stallTimer);
  if (killTimer) clearTimeout(killTimer);
  stallTimer = null;
  killTimer = null;
  stalled = false;
}

parentPort.on('message', (message) => {
  switch (message) {
    case 'feed': onFeed(); break;
    case 'restarting': onRestarting(); break;
    case 'stop': onStop(); break;
    default: break;
  }
});

armStall();
