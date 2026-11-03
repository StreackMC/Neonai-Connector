import vm from 'node:vm';
import { Worker } from 'node:worker_threads';

import { IPC } from './ipc.js';

/**
 * 沙箱子进程。
 *
 * 职责边界：
 *   - 只通过 IPC 收任务、回结果；不读配置、不碰父进程状态。
 *   - **每个任务**都新建一个 `vm` 上下文（NodeVM 隔离）并调用一次 `runSandboxed`
 *     （它内部 `module.newContext()`，即全新的 QuickJS 运行时），任务结束即 dispose。
 *     因此上一段代码的全局变量、原型污染、未释放的句柄都不会进入下一段代码。
 *   - QuickJS 侧关闭 fs/fetch，并设置执行超时、内存上限、栈上限。
 *   - 一旦发现资源超限（OOM/超时/中断）或 RSS 超限，先通知父进程 `poison`，再自杀：
 *     宁可换一个新进程，也不让可能已被污染的作用域继续服务下一段代码。
 *   - 父进程必须持续喂食；超过 feedTimeoutMs 没喂食就自杀（父进程消失时不留孤儿）。
 *   - 连续 idleMs 没有任务就自行退出，由父进程按需再拉起。
 */

if (!process.channel) {
  console.error('[FATAL] 无法与 Neonai Connector 内核建立通信通道');
  process.exit(1);
}
// 内核会把 NEONAIC 写进自己的环境；父进程 spawn 时会剔除，这里只防「被内核直接 import」。
if (process.env.NEONAIC) {
  console.error('[FATAL] 不允许在 Neonai Connector 内核中执行 Sandbox 逻辑代码');
  process.exit(1);
}

/** 父进程通过环境变量下发的配置（只含 pool/limits，不含权限等敏感项） */
const CONFIG = (() => {
  try {
    return JSON.parse(process.env.AICODE_CONFIG || '{}');
  } catch {
    return {};
  }
})();

const POOL = CONFIG.pool ?? {};
const LIMITS = CONFIG.limits ?? {};

const FEED_TIMEOUT_MS = Number(POOL.feedTimeoutMs) || 60000;
const IDLE_MS = Number(POOL.idleMs) || 300000;
const EXECUTION_TIMEOUT_MS = Number(LIMITS.executionTimeoutMs) || 10000;
const MEMORY_LIMIT_BYTES = Number(LIMITS.memoryLimitBytes) || 64 * 1024 * 1024;
const MAX_STACK_SIZE_BYTES = Number(LIMITS.maxStackSizeBytes) || 256 * 1024;
const MAX_RSS_BYTES = Number(LIMITS.maxRssBytes) || 256 * 1024 * 1024;
/** 单次结果的上限：避免超大字符串/对象把 IPC 与父进程内存打满 */
const MAX_RESULT_CHARS = 512 * 1024;

// RSS 监控线程：主线程被 wasm 阻塞时依然能跑。
// 大数组等分配可能绕过 QuickJS 的记账，所以必须有进程级兜底；超限直接 SIGKILL，
// 父进程会把「非父进程发起的 SIGKILL」判定为资源超限并回收。
// 必须在任何任务开始前启动，否则 worker 还没完成握手就被阻塞，监控形同虚设。
if (MAX_RSS_BYTES > 0) {
  try {
    const watchdog = new Worker(`
      const limit = ${Math.round(MAX_RSS_BYTES)};
      const timer = setInterval(() => {
        if (process.memoryUsage().rss <= limit) return;
        clearInterval(timer);
        process.kill(process.pid, 'SIGKILL');
      }, 250);
    `, { eval: true });
    watchdog.unref();
    watchdog.on('error', (error) => {
      process.stderr.write(`[aicode] RSS 监控线程异常：${error?.message ?? error}\n`);
    });
  } catch (error) {
    process.stderr.write(`[aicode] 无法启动 RSS 监控线程：${error?.message ?? error}\n`);
  }
}

// 放到 guard 之后再加载：万一本文件被内核误 import，不会先白加载一遍 wasm。
const [{ loadQuickJs }, { default: variant }] = await Promise.all([
  import('@sebastianwessel/quickjs'),
  import('@jitl/quickjs-ng-wasmfile-release-sync'),
]);
/** QuickJS 模块只加载一次；每次 runSandboxed 内部都会新建并 dispose 一个运行时。 */
const { runSandboxed } = await loadQuickJs(variant);

let lastFeedAt = Date.now();
let lastTaskAt = Date.now();
let busy = false;

/**
 * 发送一条 IPC 消息；失败时静默（父进程可能已经死了）。
 * @param {object} message
 * @param {(error?: Error|null) => void} [callback]
 */
function send(message, callback) {
  if (!process.connected) {
    callback?.(new Error('IPC channel closed'));
    return;
  }
  try {
    process.send(message, (error) => callback?.(error ?? null));
  } catch (error) {
    callback?.(error);
  }
}

/**
 * 发送一条消息后退出。`process.send` 是异步的，必须先等回调再 exit，
 * 否则消息可能在退出时被丢掉。
 * @param {object} message
 * @param {number} code
 */
function sendAndExit(message, code) {
  let exited = false;
  const exit = () => {
    if (exited) return;
    exited = true;
    process.exit(code);
  };
  send(message, exit);
  // 回调没来（父进程已断开等）也要走，避免僵尸
  setTimeout(exit, 1000).unref?.();
}

/**
 * 把 console 参数转成一行文本（限制长度，避免日志本身撑爆 IPC）。
 * @param {unknown} value
 * @returns {string}
 */
function formatLogArg(value) {
  let text;
  if (typeof value === 'string') text = value;
  else if (value instanceof Error) text = `${value.name}: ${value.message}`;
  else {
    try {
      const json = JSON.stringify(value);
      text = json === undefined ? String(value) : json;
    } catch {
      text = String(value);
    }
  }
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}

/**
 * 判断这次失败是否意味着「运行时可能已被污染」，需要回收整个子进程。
 * 语法错误、类型错误之类的普通失败不在此列。
 * @param {{ ok: boolean, error?: { name?: string, message?: string } }} result
 * @returns {string|null} poison 原因；null 表示可以继续复用本进程
 */
function poisonReasonOf(result) {
  if (result?.ok) return null;
  const name = String(result?.error?.name ?? '');
  const message = String(result?.error?.message ?? '');
  if (name === 'ExecutionTimeout') return `执行超时（${EXECUTION_TIMEOUT_MS}ms）`;
  if (/out of memory|memory limit|interrupted|aborted|assertion failed/i.test(message)) {
    return `${name || 'Error'}: ${message.slice(0, 160)}`;
  }
  return null;
}

/**
 * 执行一段用户代码。
 *
 * 用户代码只会在 QuickJS 里跑；这里的 `vm` 上下文只承载「调用 QuickJS 的胶水」，
 * 但它同样每任务新建，保证 logs/包装函数等状态不跨任务残留。
 *
 * @param {string} code
 * @param {string[]} logs
 * @returns {Promise<{ ok: boolean, data?: unknown, error?: { name: string, message: string } }>}
 */
async function runTask(code, logs) {
  let logChars = 0;
  const pushLog = (...args) => {
    if (logs.length >= 200 || logChars >= 16000) return;
    const line = args.map(formatLogArg).join(' ');
    logChars += line.length;
    logs.push(line);
  };

  const options = {
    allowFetch: false,
    allowFs: false,
    executionTimeout: EXECUTION_TIMEOUT_MS,
    memoryLimit: MEMORY_LIMIT_BYTES,
    maxStackSize: MAX_STACK_SIZE_BYTES,
    // 不把沙箱 console 转发到宿主：既防日志伪造，也把输出作为结果的一部分带回
    console: { log: pushLog, info: pushLog, warn: pushLog, error: pushLog, debug: pushLog },
  };

  // 用 async IIFE 包一层：用户代码可以直接 `return`，也可以使用顶层 await。
  // 注意：因此用户代码里不能再写 `export`（会与包装冲突）。
  const wrapped = `export default (async () => {\n${code}\n})();\n`;

  const context = vm.createContext({
    __runSandboxed: runSandboxed,
    __code: wrapped,
    __options: options,
  }, {
    name: 'aicode-task',
    // 胶水代码不需要 eval / 动态 wasm；关掉，缩小攻击面
    codeGeneration: { strings: false, wasm: false },
  });

  const harness = '(async () => __runSandboxed(async ({ evalCode }) => evalCode(__code, "/src/task.js"), __options))()';
  return await vm.runInContext(harness, context, { filename: 'aicode-harness.js' });
}

/**
 * 处理一次任务。任何异常都必须变成 `result`，不能让 handler 抛出后静默卡死。
 * @param {{ id: string, code: string }} message
 */
async function handleTask(message) {
  const id = String(message?.id ?? '');
  busy = true;
  lastTaskAt = Date.now();
  const started = performance.now();
  /** @type {string[]} */
  const logs = [];

  let result;
  /** 运行时级异常（wasm abort / OOM 抛错等）：整条进程不可信，必须回收 */
  let fatal = false;
  try {
    result = await runTask(String(message?.code ?? ''), logs);
  } catch (error) {
    fatal = true;
    result = {
      ok: false,
      error: { name: error?.name ?? 'Error', message: String(error?.message ?? error) },
    };
  }

  const durationMs = Math.round(performance.now() - started);

  // 资源超限：不返回结果，直接通知父进程并自杀（父进程会 reject 本次任务）
  const fatalText = String(result.error?.message ?? '未知原因');
  const poison = fatal
    ? (/aborted|assertion failed/i.test(fatalText)
      ? '运行时因资源限制中止（quickjs 断言失败）'
      : `沙箱运行时异常中止：${fatalText.slice(0, 120)}`)
    : poisonReasonOf(result);
  if (poison) {
    sendAndExit({ type: IPC.POISON, id, reason: poison, durationMs }, 70);
    return;
  }

  const rss = process.memoryUsage().rss;
  if (rss > MAX_RSS_BYTES) {
    sendAndExit({
      type: IPC.POISON,
      id,
      reason: `RSS ${(rss / 1024 / 1024).toFixed(1)}MB 超过 ${(MAX_RSS_BYTES / 1024 / 1024).toFixed(0)}MB`,
      durationMs,
    }, 70);
    return;
  }

  // 结果体积封顶：超出就截断成字符串（工具最终也是序列化成 JSON 给模型）
  let data = result?.data;
  if (data !== undefined) {
    let json;
    try {
      json = JSON.stringify(data);
    } catch {
      json = String(data);
    }
    if (typeof json === 'string' && json.length > MAX_RESULT_CHARS) {
      data = `${json.slice(0, MAX_RESULT_CHARS)}…[truncated]`;
    }
  }
  const error = result?.error
    ? { name: result.error.name, message: String(result.error.message ?? '').slice(0, 2000) }
    : null;

  send({
    type: IPC.RESULT,
    id,
    ok: result?.ok === true,
    data,
    error,
    logs,
    durationMs,
  }, () => {
    busy = false;
    lastTaskAt = Date.now();
  });
}

process.on('message', (message) => {
  if (!message || typeof message !== 'object') return;
  switch (message.type) {
    case IPC.FEED:
      lastFeedAt = Date.now();
      return;
    case IPC.SHUTDOWN:
      sendAndExit({ type: IPC.BYE, reason: 'shutdown' }, 0);
      return;
    case IPC.TASK:
      if (busy) {
        // 父进程保证「一个进程同时只有一个任务」；真出现并发说明协议被破坏，直接拒绝
        send({
          type: IPC.RESULT,
          id: String(message.id ?? ''),
          ok: false,
          error: { name: 'WorkerBusy', message: '该沙箱进程正在执行其他任务' },
          logs: [],
          durationMs: 0,
        });
        return;
      }
      void handleTask(message);
      return;
    default:
      return;
  }
});

// 父进程断开 = 再也不会有人喂食；立刻退出，避免孤儿进程
process.on('disconnect', () => process.exit(1));

// 断粮看门狗
const feedTimer = setInterval(() => {
  if (Date.now() - lastFeedAt <= FEED_TIMEOUT_MS) return;
  clearInterval(feedTimer);
  clearInterval(idleTimer);
  sendAndExit({ type: IPC.BYE, reason: 'feed timeout' }, 1);
}, Math.max(1000, Math.min(5000, Math.floor(FEED_TIMEOUT_MS / 4))));

// 空闲看门狗：只统计「没有任务」，喂食不重置它
const idleTimer = setInterval(() => {
  if (busy) return;
  if (Date.now() - lastTaskAt <= IDLE_MS) return;
  clearInterval(feedTimer);
  clearInterval(idleTimer);
  sendAndExit({ type: IPC.BYE, reason: 'idle timeout' }, 0);
}, Math.max(1000, Math.min(5000, Math.floor(IDLE_MS / 4))));

send({ type: IPC.READY });
