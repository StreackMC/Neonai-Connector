import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { realpathSync } from 'node:fs';

import { neonaicLifeCycleManager } from '#src/system/lifeCycleManager.js';
import { getLogger } from '#src/logger/Logger.js';

import { IPC } from './ipc.js';

/**
 * 沙箱进程池。
 *
 * 设计取舍：
 *   - **不排队**：没有空闲进程且已达上限时立刻返回 busy，避免请求在队列里等到超时。
 *   - **按需拉起**：空闲/崩溃后不预拉；下一次任务再 spawn，省掉长期占用的内存。
 *   - **一进程一任务**：任务带唯一 id，结果按 id 关联；不匹配的 result 一律丢弃（防重放/错配）。
 *   - **硬超时直接 SIGKILL**：QuickJS 的软超时先触发；真到硬超时说明子进程已不可信，换新的。
 *   - **poison 不复用**：子进程报告资源超限后自杀，父进程只 reject 本次任务，不重试。
 */

const CHILD_ENTRY = fileURLToPath(new URL('./eval.js', import.meta.url));
const CHILD_CWD = dirname(CHILD_ENTRY);
const ROOT_PATH = neonaicLifeCycleManager.ROOT_PATH;
const TAIL_LIMIT = 8192;

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

/**
 * @typedef {object} Worker
 * @property {import('node:child_process').ChildProcess} child
 * @property {boolean} ready
 * @property {boolean} busy
 * @property {boolean} closed
 * @property {{ id: string, resolve: Function, reject: Function, timer: NodeJS.Timeout }|null} task
 * @property {NodeJS.Timeout|null} feedTimer
 * @property {{ resolve: Function, reject: Function, timer: NodeJS.Timeout }|null} readyWait
 * @property {string} tail
 */

/** @returns {ReturnType<typeof getLogger>['tool']} */
const log = () => getLogger().tool;

/**
 * 应用配置（在拓展 onEnable 时调用）。
 * @param {ReturnType<typeof import('./config.js').aicodeConfig.load>} cfg
 */
function configure(cfg) {
  config = cfg;
  closing = false;
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
 * @returns {Promise<Worker>}
 */
async function acquire() {
  for (const worker of workers) {
    if (!worker.closed && worker.ready && !worker.busy) return worker;
  }
  if (workers.size + pendingSpawns >= config.pool.maxChildren) {
    throw new PoolBusyError('pool exhausted');
  }
  pendingSpawns++;
  try {
    return await spawnWorker();
  } finally {
    pendingSpawns--;
  }
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

  const child = fork(CHILD_ENTRY, [], {
    cwd: CHILD_CWD,
    env,
    execArgv,
    // stdout/stderr 自己收，避免沙箱里的 console 直接污染内核日志
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });

  /** @type {Worker} */
  const worker = {
    child,
    ready: false,
    busy: false,
    closed: false,
    killedByParent: false,
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

  child.on('message', (message) => onMessage(worker, message));
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

/**
 * @param {Worker} worker
 * @param {object} message
 */
function onMessage(worker, message) {
  if (!message || typeof message !== 'object') return;
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
 * @param {Worker} worker
 * @param {{ id?: string, ok?: boolean, data?: unknown, error?: object|null, logs?: string[], durationMs?: number, reason?: string }} message
 * @param {boolean} poisoned
 */
function settle(worker, message, poisoned) {
  const task = worker.task;
  if (!task) return;
  // 一进程一任务 + 唯一 id：id 不匹配说明消息错配或重放，丢弃
  if (message.id != null && message.id !== task.id) {
    log().warn?.(`[aicode] 丢弃不匹配的任务结果（期望 ${task.id}，收到 ${message.id}）`);
    return;
  }

  worker.task = null;
  worker.busy = false;
  clearTimeout(task.timer);

  if (poisoned) {
    task.reject(new SandboxWorkerError(`沙箱进程因资源限制被回收：${message.reason ?? '未知原因'}`, 'sandbox_poisoned'));
    return;
  }

  const ok = message.ok === true;
  task.resolve({
    ok,
    data: message.data,
    error: message.error ?? null,
    logs: Array.isArray(message.logs) ? message.logs : [],
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
 * @param {Worker} worker
 * @param {string} code
 * @returns {Promise<{ ok: boolean, data?: unknown, error?: object|null, logs: string[], durationMs: number }>}
 */
function runOnWorker(worker, code) {
  if (closing) {
    return Promise.reject(new SandboxWorkerError('代码执行器正在关闭', 'sandbox_closing'));
  }
  if (worker.closed || !worker.ready) {
    return Promise.reject(new SandboxWorkerError('沙箱进程不可用', 'sandbox_unavailable'));
  }

  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (worker.task?.id !== id) return;
      worker.task = null;
      worker.busy = false;
      // 软超时没拦住（死循环/卡在 wasm），只能换进程
      killWorker(worker);
      reject(new SandboxWorkerError('沙箱执行超时，进程已回收', 'sandbox_timeout'));
    }, config.limits.taskTimeoutMs);

    worker.task = { id, resolve, reject, timer };
    worker.busy = true;

    safeSend(worker, { type: IPC.TASK, id, code }, (error) => {
      if (!error) return;
      if (worker.task?.id !== id) return;
      worker.task = null;
      worker.busy = false;
      clearTimeout(timer);
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
 * @param {Worker} worker
 * @param {object} message
 * @param {(error?: Error|null) => void} [callback]
 */
function safeSend(worker, message, callback) {
  if (worker.closed || !worker.child.connected) {
    callback?.(new Error('IPC 通道已关闭'));
    return;
  }
  try {
    worker.child.send(message, (error) => callback?.(error ?? null));
  } catch (error) {
    callback?.(error);
  }
}

/**
 * 关闭所有子进程（拓展停用时调用）。
 * @returns {Promise<void>}
 */
async function shutdown() {
  closing = true;
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
 * @returns {{ size: number, busy: number, max: number, conversations: number, closing: boolean }}
 */
function status() {
  return {
    size: workers.size,
    busy: [...workers].filter((worker) => worker.busy).length,
    max: config?.pool.maxChildren ?? 0,
    conversations: conversations.size,
    closing,
  };
}

export const aicodePool = Object.freeze({
  configure,
  run,
  shutdown,
  status,
});
