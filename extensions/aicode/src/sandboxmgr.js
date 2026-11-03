import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { realpathSync } from 'node:fs';

import { neonaicLifeCycleManager } from '#src/system/lifeCycleManager.js';
import { getLogger } from '#src/logger/Logger.js';

import { IPC } from './ipc.js';
import { aicodeFraming } from './framing.js';
import { aicodeSanitize } from './sanitize.js';

/**
 * 沙箱进程池 —— 削峰缓冲调度。
 *
 * 设计取舍：
 *   - **削峰不排队**：突发请求可以撑到 `pool.maxChildren` 个并发进程；没有空位时立刻返回 busy，
 *     避免请求在队列里等到自己超时。
 *   - **按需拉起**：空闲/崩溃后不预拉；下一次任务再 spawn，省掉长期占用的内存。
 *   - **待机阶梯**：待机进程不是「同一时刻集体到期」，而是按等差数列排开——
 *     待机进程越多，最久没用的那个越早被回收（省内存），而**最后**一个待机进程
 *     恰好活满 `pool.idleMaxMinutes`（保住「下一波突发不用冷启动」的缓冲）。
 *     见 {@link idleBudgetMs}。
 *   - **一进程一任务**：任务带唯一 id，结果按 id 关联；id 不匹配一律丢弃（防重放/错配）。
 *   - **协议错误即回收**：子进程只应发出已知类型的消息；出现非对象/未知类型，
 *     或结果帧不是我们生成的形状，说明它已被污染，立刻强杀换新。
 *   - **硬超时直接 SIGKILL**：QuickJS 的软超时先触发；真到硬超时说明子进程已不可信，换新的。
 *   - **poison 不复用**：子进程报告资源超限后自杀，父进程只 reject 本次任务，不重试。
 */

const CHILD_ENTRY = fileURLToPath(new URL('./eval.js', import.meta.url));
const CHILD_CWD = dirname(CHILD_ENTRY);
const ROOT_PATH = neonaicLifeCycleManager.ROOT_PATH;
const TAIL_LIMIT = 8192;
/** 待机预算的下限：防止「刚跑完就被回收」的抖动（尤其 idleDecay 调到 1 时） */
const IDLE_BUDGET_FLOOR_MS = 5000;

/**
 * 子进程需要读取的根：项目根 + node_modules 的 realpath + 拓展目录的 realpath。
 * pnpm/工作区/测试沙箱里 node_modules 常常是软链，只授权 ROOT 会被 permission 模型按
 * realpath 拒绝，所以这里把真实路径也显式列出。
 */
const READ_ROOTS = (() => {
  const roots = new Set([ROOT_PATH]);
  for (const candidate of [resolve(ROOT_PATH, 'node_modules'), CHILD_CWD]) {
    try {
      roots.add(realpathSync(candidate));
    } catch {
      // 路径不存在就算了，ROOT 仍然兜底
    }
  }
  return [...roots];
})();

/** 池满时抛出；`run()` 会把它翻译成 `busy` 结果，而不是让工具调用失败。 */
class PoolBusyError extends Error {}

/** 子进程退出/超时/poison 时抛出。`code` 供上层区分原因。 */
class SandboxWorkerError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   */
  constructor(message, code) {
    super(message);
    this.name = 'SandboxWorkerError';
    this.code = code;
  }
}

/** @type {Set<Worker>} */
const workers = new Set();
/** @type {ReturnType<typeof import('./config.js').aicodeConfig.load>|null} */
let config = null;
let closing = false;
/** 正在 spawn 的数量：只靠 workers.size 判断会超发（spawn 是异步的） */
let pendingSpawns = 0;
/** Node 是否支持权限模型（Node < 20 不认 --permission，不能硬加） */
const SUPPORTS_PERMISSION = process.allowedNodeEnvironmentFlags?.has?.('--permission') ?? false;
let permissionDegradeWarned = false;
/** 对话键 → 正在执行的任务数 */
const conversations = new Map();
/** 待机阶梯的扫描定时器（全池一个，不是每进程一个） */
/** @type {NodeJS.Timeout|null} */
let idleSweeper = null;

/**
 * @typedef {object} Worker
 * @property {import('node:child_process').ChildProcess} child
 * @property {import('node:stream').Writable|null} toChild 父 → 子（子进程的 fd 3）
 * @property {import('node:stream').Readable|null} fromChild 子 → 父（子进程的 fd 4）
 * @property {boolean} ready
 * @property {boolean} busy
 * @property {boolean} closed
 * @property {boolean} killedByParent
 * @property {number} lastTaskAt 最近一次任务结束（或 spawn 完成）的时刻，待机阶梯的起点
 * @property {{ id: string, resolve: Function, reject: Function, timer: NodeJS.Timeout }|null} task
 * @property {NodeJS.Timeout|null} feedTimer
 * @property {{ resolve: Function, reject: Function, timer: NodeJS.Timeout }|null} readyWait
 * @property {string} tail
 */

/** @returns {ReturnType<typeof getLogger>['tool']} */
const log = () => getLogger().tool;

/**
 * 把毫秒渲染成人读的形式（日志用）。
 * @param {number} ms
 * @returns {string}
 */
function formatMs(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}min`;
}

/**
 * 待机阶梯：第 `index` 个（按「最久没用」升序）待机进程的待机预算。
 *
 * 公式是一个等差数列：
 * ```
 *   step   = idleMaxMs * idleDecay / idleCount
 *   budget = idleMaxMs - (idleCount - 1 - index) * step
 * ```
 * 于是：
 *   - `index = idleCount - 1`（最后一个 / 最新闲下来的）→ `idleMaxMs`，即最大待机时长；
 *   - `idleCount` 越大，最久没用的那个预算越小 → **进程越多，杀得越快**；
 *   - 全程恒为正：`(idleCount - 1) * step < idleMaxMs * idleDecay <= idleMaxMs`；
 *   - `idleDecay = 0` 时全部等于 `idleMaxMs`（退化成「所有进程同时到期」）。
 *
 * @param {number} index 0 = 最久没用
 * @param {number} idleCount 当前待机进程数
 * @returns {number} 毫秒
 */
function idleBudgetMs(index, idleCount) {
  if (!config) return 0;
  const max = config.pool.idleMaxMs;
  const step = (max * config.pool.idleDecay) / Math.max(1, idleCount);
  const budget = max - (idleCount - 1 - index) * step;
  return Math.min(max, Math.max(IDLE_BUDGET_FLOOR_MS, Math.round(budget)));
}

/**
 * 扫描待机进程，把超预算的回收掉。
 *
 * 因为 `budget` 与 `lastTaskAt` 都随 index 单调递增，`lastTaskAt + budget`（真实到期时刻）
 * 也是单调的：最久没用的那个一定最先到期。这一 tick 里没到期的，后面的也不会到期。
 */
function sweepIdle() {
  if (closing || !config) return;
  const now = Date.now();
  const idle = [...workers].filter((worker) => !worker.closed && worker.ready && !worker.busy);
  if (idle.length === 0) return;
  idle.sort((a, b) => a.lastTaskAt - b.lastTaskAt);

  for (let index = 0; index < idle.length; index++) {
    const worker = idle[index];
    const budget = idleBudgetMs(index, idle.length);
    const idleFor = now - worker.lastTaskAt;
    if (idleFor < budget) continue;
    log().info?.(
      `[aicode] 回收待机进程 pid=${worker.child.pid}（阶梯 ${index + 1}/${idle.length}，`
      + `已待机 ${formatMs(idleFor)}，预算 ${formatMs(budget)}）`,
    );
    // 待机进程没有未完成的工作，直接 SIGKILL：省掉优雅退出那几百毫秒的窗口，
    // 池容量立刻释放，突发请求可以马上拉起新进程。
    killWorker(worker);
    cleanupWorker(worker);
  }
}

/** 启动全池唯一的待机扫描器（幂等）。 */
function startIdleSweeper() {
  if (idleSweeper) return;
  const tick = Math.max(500, Math.min(2000, Math.floor(config.pool.idleMaxMs / 20)));
  idleSweeper = setInterval(sweepIdle, tick);
  idleSweeper.unref?.();
}

/** @returns {void} */
function stopIdleSweeper() {
  if (!idleSweeper) return;
  clearInterval(idleSweeper);
  idleSweeper = null;
}

/**
 * 应用配置（在拓展 onEnable 时调用）。
 * @param {ReturnType<typeof import('./config.js').aicodeConfig.load>} cfg
 */
function configure(cfg) {
  config = cfg;
  closing = false;
  startIdleSweeper();
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {{ ok: false, code: string, message: string, logs: string[], durationMs: number }}
 */
function fail(code, message) {
  return { ok: false, code, message, logs: [], durationMs: 0 };
}

/**
 * 对话键：执行者链最近的一位（通常是说话者本人）。
 * @param {{ executor?: string[] }|undefined} ctx
 * @returns {string}
 */
function conversationKey(ctx) {
  const executor = Array.isArray(ctx?.executor) ? ctx.executor : [];
  return executor[0] ?? '$unknown';
}

/**
 * 执行一段代码。
 *
 * @param {string} code
 * @param {{ executor?: string[] }} ctx 本轮命令上下文
 * @returns {Promise<{ ok: boolean, data?: unknown, error?: object|null, logs: string[], durationMs: number, code?: string, message?: string }>}
 */
async function run(code, ctx) {
  if (!config || closing) return fail('not_ready', '代码执行器未就绪');
  if (typeof code !== 'string' || !code.trim()) return fail('invalid_argument', '代码必须是非空字符串');

  const bytes = Buffer.byteLength(code, 'utf8');
  if (bytes > config.limits.maxCodeBytes) {
    return fail('code_too_large', `代码过大：${bytes} 字节，上限 ${config.limits.maxCodeBytes}`);
  }

  const key = conversationKey(ctx);
  const inflight = conversations.get(key) ?? 0;
  if (inflight >= config.conversation.maxConcurrent) {
    return fail('busy', '该对话已有代码任务在执行，请稍后再试');
  }
  conversations.set(key, inflight + 1);

  try {
    let worker;
    try {
      worker = await acquire();
      // spawn 是异步的：等它回来时拓展可能已经在关停了
      if (closing) {
        killWorker(worker);
        cleanupWorker(worker);
        return fail('not_ready', '代码执行器正在关闭');
      }
    } catch (error) {
      if (error instanceof PoolBusyError) {
        return fail('busy', `系统忙：代码执行进程已全部占用（上限 ${config.pool.maxChildren}），请稍后再试`);
      }
      throw error;
    }
    return await runOnWorker(worker, code);
  } catch (error) {
    log().warn?.(`[aicode] 执行失败：${error?.message ?? error}`);
    return fail(error?.code ?? 'sandbox_error', String(error?.message ?? error));
  } finally {
    const left = (conversations.get(key) ?? 1) - 1;
    if (left > 0) conversations.set(key, left);
    else conversations.delete(key);
  }
}

/**
 * 取一个空闲进程；没有就按需拉起；已达上限则 busy。
 *
 * **交付即占用**：`busy` 在返回之前就置为 true。早先是「`acquire` 只挑选、
 * `runOnWorker` 再置忙」，两个并发任务会在同一个微任务间隙里挑中同一个空闲进程，
 * 后一个把 `worker.task` 覆盖掉，前一个任务就永远等不到结论
 * （硬超时又因为 id 不匹配静默返回 → 永久悬挂）。
 *
 * @returns {Promise<Worker>}
 */
async function acquire() {
  for (const worker of workers) {
    if (worker.closed || !worker.ready || worker.busy) continue;
    worker.busy = true;
    return worker;
  }
  if (workers.size + pendingSpawns >= config.pool.maxChildren) {
    throw new PoolBusyError('pool exhausted');
  }
  pendingSpawns++;
  try {
    const worker = await spawnWorker();
    worker.busy = true;
    return worker;
  } finally {
    pendingSpawns--;
  }
}

/**
 * 归还占用：任务没有真正派发出去（进程不可用、通道写失败等）时的兜底。
 * @param {Worker} worker
 */
function releaseWorker(worker) {
  worker.busy = false;
  worker.lastTaskAt = Date.now();
}

/**
 * 拉起一个子进程并等它 ready。
 * @returns {Promise<Worker>}
 */
async function spawnWorker() {
  const env = { ...process.env };
  // 内核会设置 NEONAIC；子进程带着它会立刻自杀（那是防「内核内直接 import」的哨兵）
  delete env.NEONAIC;
  env.AICODE_CONFIG = JSON.stringify({ pool: config.pool, limits: config.limits });

  /** @type {string[]} */
  const execArgv = [];
  if (config.pool.nodePermissionModel) {
    if (SUPPORTS_PERMISSION) {
      // 系统级隔离：子进程只允许读项目根（QuickJS 自身再关掉 fs/fetch，形成两层）
      execArgv.push('--permission', ...READ_ROOTS.map((root) => `--allow-fs-read=${root}`), '--no-warnings');
      // 子进程内的 RSS 监控线程需要 worker 权限；没有它，大数组绕过 QuickJS 记账时无人兜底
      if (process.allowedNodeEnvironmentFlags?.has?.('--allow-worker')) {
        execArgv.push('--allow-worker');
      }
    } else if (!permissionDegradeWarned) {
      permissionDegradeWarned = true;
      log().warn?.('[aicode] 当前 Node 不支持 --permission，已跳过系统级文件权限隔离（QuickJS 层仍然禁用 fs/fetch）');
    }
  }
  if (config.pool.maxOldSpaceMB > 0) {
    execArgv.push(`--max-old-space-size=${config.pool.maxOldSpaceMB}`);
  }

  const child = spawn(process.execPath, [...execArgv, CHILD_ENTRY], {
    cwd: CHILD_CWD,
    env,
    // fd 3 = 父 → 子，fd 4 = 子 → 父。**刻意不用 fork 的 IPC 通道**：
    // 那条通道的解析在 Node 内部，子进程写一条非法 JSON 会把内核打崩（见 framing.js）。
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  /** @type {Worker} */
  const worker = {
    child,
    toChild: child.stdio[3],
    fromChild: child.stdio[4],
    ready: false,
    busy: false,
    closed: false,
    killedByParent: false,
    lastTaskAt: Date.now(),
    task: null,
    feedTimer: null,
    readyWait: null,
    tail: '',
  };
  workers.add(worker);

  const appendTail = (chunk) => {
    worker.tail = (worker.tail + String(chunk)).slice(-TAIL_LIMIT);
  };
  child.stdout?.on('data', appendTail);
  child.stderr?.on('data', appendTail);

  // 帧解码器：任何非法帧（非 JSON / 非对象 / 超长）都按「协议异常」强杀，
  // 而且错误只发生在我们自己的解码器里，绝不会冒泡成内核的未捕获异常。
  const decoder = aicodeFraming.createFrameDecoder(
    (message) => onMessage(worker, message),
    (reason) => protocolViolation(worker, reason),
  );
  worker.fromChild?.on('data', (chunk) => decoder.push(chunk));
  worker.fromChild?.on('error', (error) => onError(worker, error));
  // 子进程主动关掉写端（正常退出前）等同它不会再说话了
  worker.fromChild?.on('end', () => {
    if (!worker.closed && !worker.task) cleanupWorker(worker);
  });

  child.on('error', (error) => onError(worker, error));
  child.on('exit', (code, signal) => onExit(worker, code, signal));

  worker.feedTimer = setInterval(() => {
    if (worker.closed) return;
    safeSend(worker, { type: IPC.FEED });
  }, config.pool.feedIntervalMs);
  worker.feedTimer.unref?.();

  try {
    await waitReady(worker);
    if (closing) {
      killWorker(worker);
      cleanupWorker(worker);
      throw new SandboxWorkerError('代码执行器正在关闭', 'sandbox_closing');
    }
    worker.lastTaskAt = Date.now();
    return worker;
  } catch (error) {
    killWorker(worker);
    cleanupWorker(worker);
    throw new SandboxWorkerError(`沙箱进程启动失败：${error?.message ?? error}`, 'sandbox_spawn');
  }
}

/**
 * 等待子进程 READY，超时则失败。
 * @param {Worker} worker
 * @returns {Promise<void>}
 */
function waitReady(worker) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.readyWait = null;
      reject(new Error('启动超时'));
    }, config.pool.spawnTimeoutMs);
    worker.readyWait = { resolve, reject, timer };
  });
}

/** 子进程允许发来的消息类型；出现别的说明它已不可信 */
const KNOWN_MESSAGE_TYPES = new Set(Object.values(IPC));

/**
 * 协议异常：子进程发的帧不是我们约定的形状。
 *
 * 这里的选择是**强杀**而不是忽略：正常子进程不会发出未知类型，
 * 一旦出现就说明它已经跑的不是我们那份 `eval.js`（被改写/被污染），
 * 继续复用等于把不可信进程放回池里。宁可付一次 spawn 成本。
 *
 * @param {Worker} worker
 * @param {string} reason
 */
function protocolViolation(worker, reason) {
  log().warn?.(`[aicode] 沙箱进程协议异常（${reason}），视为已被污染并回收 pid=${worker.child.pid}`);
  const task = worker.task;
  worker.task = null;
  worker.busy = false;
  if (task) {
    clearTimeout(task.timer);
    task.reject(new SandboxWorkerError(`沙箱进程协议异常：${reason}`, 'sandbox_protocol'));
  }
  killWorker(worker);
  cleanupWorker(worker);
}

/**
 * @param {Worker} worker
 * @param {object} message
 */
function onMessage(worker, message) {
  if (!message || typeof message !== 'object') {
    protocolViolation(worker, `消息不是对象（${typeof message}）`);
    return;
  }
  if (!KNOWN_MESSAGE_TYPES.has(message.type)) {
    protocolViolation(worker, `未知消息类型 ${String(message.type).slice(0, 32)}`);
    return;
  }
  switch (message.type) {
    case IPC.READY: {
      worker.ready = true;
      const wait = worker.readyWait;
      worker.readyWait = null;
      if (wait) {
        clearTimeout(wait.timer);
        wait.resolve();
      }
      log().info?.(`[aicode] 沙箱进程已就绪 pid=${worker.child.pid}`);
      return;
    }
    case IPC.RESULT: {
      settle(worker, message, false);
      return;
    }
    case IPC.POISON: {
      log().warn?.(`[aicode] 沙箱进程报告资源超限，即将回收：${message.reason ?? '未知原因'}`);
      settle(worker, message, true);
      // 不等它自己退出：立刻摘出池并杀掉，否则下一次 acquire 会把任务派给这个将死的进程
      killWorker(worker);
      cleanupWorker(worker);
      return;
    }
    case IPC.BYE: {
      log().debug?.(`[aicode] 沙箱进程主动退出：${message.reason ?? '未说明'}`);
      return;
    }
    default:
      return;
  }
}

/**
 * 结算当前任务。
 *
 * 结果里的 `data` 一定要再过一次 `shrinkResult`：子进程那份是自己写的，
 * 但「子进程还跑着我们那份代码」这件事本身不该被信任。
 *
 * @param {Worker} worker
 * @param {{ id?: string, ok?: boolean, data?: unknown, error?: object|null, logs?: string[], durationMs?: number, reason?: string }} message
 * @param {boolean} poisoned
 */
function settle(worker, message, poisoned) {
  const task = worker.task;
  if (!task) return;
  // 一进程一任务 + 唯一 id：**必须严格相等**。
  // 早先写成「id 存在才校验」，等于允许子进程省略 id 来顶掉当前任务。
  if (message.id !== task.id) {
    log().warn?.(`[aicode] 丢弃不匹配的任务结果（期望 ${task.id}，收到 ${String(message.id)}）`);
    return;
  }

  worker.task = null;
  worker.busy = false;
  worker.lastTaskAt = Date.now();
  clearTimeout(task.timer);

  if (poisoned) {
    task.reject(new SandboxWorkerError(`沙箱进程因资源限制被回收：${message.reason ?? '未知原因'}`, 'sandbox_poisoned'));
    return;
  }

  const ok = message.ok === true;
  task.resolve({
    ok,
    data: ok ? aicodeSanitize.shrinkResult(message.data) : undefined,
    error: message.error && typeof message.error === 'object'
      ? {
        name: String(message.error.name ?? 'Error').slice(0, 64),
        message: String(message.error.message ?? '').slice(0, 2000),
      }
      : null,
    logs: Array.isArray(message.logs)
      ? message.logs.filter((line) => typeof line === 'string').slice(0, 200).map((line) => line.slice(0, 2000))
      : [],
    durationMs: Number(message.durationMs) || 0,
    // 让「沙箱里报错」和「池拒绝」在上层形状一致
    ...(ok ? {} : {
      code: 'sandbox_error',
      message: String(message.error?.message ?? '代码执行失败'),
    }),
  });
}

/**
 * 在指定进程上执行一次任务；带硬超时。
 *
 * 调用前 `acquire` 已经把 `worker.busy` 置为 true（交付即占用），
 * 所以这里**只负责派发与结算**，任何提前失败都要把占用还回去。
 *
 * @param {Worker} worker
 * @param {string} code
 * @returns {Promise<{ ok: boolean, data?: unknown, error?: object|null, logs: string[], durationMs: number }>}
 */
function runOnWorker(worker, code) {
  if (closing) {
    releaseWorker(worker);
    return Promise.reject(new SandboxWorkerError('代码执行器正在关闭', 'sandbox_closing'));
  }
  if (worker.closed || !worker.ready) {
    releaseWorker(worker);
    return Promise.reject(new SandboxWorkerError('沙箱进程不可用', 'sandbox_unavailable'));
  }

  const id = randomUUID();
  return new Promise((resolve, reject) => {
    /** @type {{ id: string, resolve: Function, reject: Function, timer: NodeJS.Timeout }} */
    const task = { id, resolve, reject, timer: null };

    task.timer = setTimeout(() => {
      // 无论 worker.task 现在指向谁，本次任务的 promise 都必须有结论：
      // 早先写成「id 不匹配就 return」，一旦发生错配这条任务就永久悬挂。
      if (worker.task === task) {
        worker.task = null;
        worker.busy = false;
      }
      // 软超时没拦住（死循环/卡在 wasm），只能换进程
      killWorker(worker);
      reject(new SandboxWorkerError('沙箱执行超时，进程已回收', 'sandbox_timeout'));
    }, config.limits.taskTimeoutMs);

    worker.task = task;

    safeSend(worker, { type: IPC.TASK, id, code }, (error) => {
      if (!error) return;
      if (worker.task === task) {
        worker.task = null;
        releaseWorker(worker);
      }
      clearTimeout(task.timer);
      reject(new SandboxWorkerError(`无法向沙箱进程发送任务：${error.message}`, 'sandbox_ipc'));
    });
  });
}

/**
 * @param {Worker} worker
 * @param {Error} error
 */
function onError(worker, error) {
  log().error?.(`[aicode] 沙箱进程错误：${error?.message ?? error}`);
  const wait = worker.readyWait;
  worker.readyWait = null;
  if (wait) {
    clearTimeout(wait.timer);
    wait.reject(error);
  }
  if (worker.task) {
    const task = worker.task;
    worker.task = null;
    worker.busy = false;
    clearTimeout(task.timer);
    task.reject(new SandboxWorkerError(`沙箱进程错误：${error?.message ?? error}`, 'sandbox_error'));
  }
  killWorker(worker);
  cleanupWorker(worker);
}

/**
 * @param {Worker} worker
 * @param {number|null} code
 * @param {string|null} signal
 */
function onExit(worker, code, signal) {
  const wasClosed = worker.closed;
  cleanupWorker(worker);

  const wait = worker.readyWait;
  worker.readyWait = null;
  if (wait) {
    clearTimeout(wait.timer);
    wait.reject(new Error(`进程退出（code=${code}, signal=${signal}）`));
  }

  if (worker.task) {
    const task = worker.task;
    worker.task = null;
    worker.busy = false;
    clearTimeout(task.timer);
    // 不是父进程发起的 SIGKILL ⇒ 子进程的自杀式回收（RSS 监控 / OOM killer）
    const selfKilled = signal === 'SIGKILL' && !worker.killedByParent;
    task.reject(new SandboxWorkerError(
      selfKilled
        ? '沙箱进程因内存超限被监控线程回收'
        : `沙箱进程意外退出（code=${code}, signal=${signal}）`,
      selfKilled ? 'sandbox_poisoned' : 'sandbox_exit',
    ));
  }

  if (!wasClosed) {
    log().warn?.(`[aicode] 沙箱进程退出 pid=${worker.child.pid} code=${code} signal=${signal}`
      + (worker.tail ? ` | stderr/stdout: ${worker.tail.slice(-1000)}` : ''));
  }
}

/**
 * 从池中移除并停止定时器（不负责杀进程）。
 * @param {Worker} worker
 */
function cleanupWorker(worker) {
  worker.closed = true;
  worker.ready = false;
  if (worker.feedTimer) {
    clearInterval(worker.feedTimer);
    worker.feedTimer = null;
  }
  workers.delete(worker);
}

/**
 * @param {Worker} worker
 */
function killWorker(worker) {
  worker.killedByParent = true;
  try {
    worker.child.kill('SIGKILL');
  } catch {
    // 已经退出
  }
}

/**
 * 往子进程写一帧。
 * @param {Worker} worker
 * @param {object} message
 * @param {(error?: Error|null) => void} [callback]
 * @returns {boolean} 是否成功写入了通道
 */
function safeSend(worker, message, callback) {
  const stream = worker.toChild;
  if (worker.closed || !stream || stream.destroyed || !stream.writable) {
    callback?.(new Error('IPC 通道已关闭'));
    return false;
  }
  try {
    const frame = aicodeFraming.encodeFrame(message);
    stream.write(frame, (error) => callback?.(error ?? null));
    return true;
  } catch (error) {
    callback?.(error);
    return false;
  }
}

/**
 * 关闭所有子进程（拓展停用时调用）。
 * @returns {Promise<void>}
 */
async function shutdown() {
  closing = true;
  stopIdleSweeper();
  const list = [...workers];
  const exits = list.map((worker) => new Promise((resolve) => {
    if (worker.closed) {
      resolve();
      return;
    }
    worker.child.once('exit', resolve);
  }));

  for (const worker of list) {
    if (worker.task) {
      const task = worker.task;
      worker.task = null;
      worker.busy = false;
      clearTimeout(task.timer);
      task.reject(new SandboxWorkerError('代码执行器正在关闭', 'sandbox_closing'));
    }
    if (worker.feedTimer) {
      clearInterval(worker.feedTimer);
      worker.feedTimer = null;
    }
    safeSend(worker, { type: IPC.SHUTDOWN });
  }

  await Promise.race([
    Promise.all(exits),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);

  for (const worker of list) {
    if (!worker.closed) {
      killWorker(worker);
      cleanupWorker(worker);
    }
  }
  workers.clear();
  conversations.clear();
}

/**
 * 可观测状态（日志/排障用）。
 *
 * `idleBudgets` 是当前这一轮阶梯实际会用的预算（秒），按「最久没用」升序，
 * 排障时可以直接看出「为什么这个进程刚被杀」。
 *
 * @returns {{ size: number, busy: number, max: number, idle: number, conversations: number,
 *             closing: boolean, idleBudgets: number[] }}
 */
function status() {
  const idle = [...workers].filter((worker) => !worker.closed && worker.ready && !worker.busy);
  idle.sort((a, b) => a.lastTaskAt - b.lastTaskAt);
  return {
    size: workers.size,
    busy: [...workers].filter((worker) => worker.busy).length,
    max: config?.pool.maxChildren ?? 0,
    idle: idle.length,
    conversations: conversations.size,
    closing,
    idleBudgets: config
      ? idle.map((_, index) => Math.round(idleBudgetMs(index, idle.length) / 1000))
      : [],
  };
}

export const aicodePool = Object.freeze({
  configure,
  run,
  shutdown,
  status,
  idleBudgetMs,
});
