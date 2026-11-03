import vm from 'node:vm';
import fs from 'node:fs';
import { Worker } from 'node:worker_threads';

import { IPC } from './ipc.js';
import { aicodeFraming } from './framing.js';
import { aicodeSanitize } from './sanitize.js';

/**
 * 沙箱子进程。
 *
 * 职责边界：
 *   - 只通过 IPC 收任务、回结果；不读配置、不碰父进程状态。
 *   - **每个任务**都新建一个 `vm` 上下文（NodeVM 隔离）并调用一次 `runSandboxed`
 *     （它内部 `module.newContext()`，即全新的 QuickJS 运行时），任务结束即 dispose。
 *     因此上一段代码的全局变量、原型污染、未释放的句柄都不会进入下一段代码。
 *   - QuickJS 侧关闭 fs/fetch，并设置执行超时、内存上限、栈上限。
 *   - 一旦发现资源超限（OOM/超时/中断）、RSS 超限或协议异常，先通知父进程 `poison`，再自杀：
 *     宁可换一个新进程，也不让可能已被污染的作用域继续服务下一段代码。
 *   - 父进程必须持续喂食；超过 feedTimeoutMs 没喂食就自杀（父进程消失时不留孤儿）。
 *   - 连续 idleMs 没有任务就自行退出（这是**上限**；正常情况下父进程会按待机阶梯更早回收）。
 */

/**
 * 与父进程的通道：**不是** Node 的 IPC 通道，而是父进程 spawn 时开的两根管道。
 *
 * 子进程读 fd 3、写 fd 4，帧格式见 `framing.js`。之所以不用 `process.send`：
 * 那条通道的解析在 Node 内部，子进程写一条非法 JSON 会让宿主的
 * `channel.onread` 抛未捕获异常，直接把内核打死（详见 framing.js 的说明）。
 */
const READ_FD = 3;
const WRITE_FD = 4;

try {
  fs.fstatSync(READ_FD);
  fs.fstatSync(WRITE_FD);
} catch {
  console.error('[FATAL] 缺少与 Neonai Connector 内核通信的管道（fd 3/4）');
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
/** 自身待机上限：父进程按阶梯会更早回收，这里只是「父进程不在/阶梯失效」时的兜底 */
const IDLE_MAX_MS = Number(POOL.idleMaxMs) || Number(POOL.idleMs) || 300000;
const EXECUTION_TIMEOUT_MS = Number(LIMITS.executionTimeoutMs) || 10000;
const MEMORY_LIMIT_BYTES = Number(LIMITS.memoryLimitBytes) || 64 * 1024 * 1024;
const MAX_STACK_SIZE_BYTES = Number(LIMITS.maxStackSizeBytes) || 256 * 1024;
const MAX_RSS_BYTES = Number(LIMITS.maxRssBytes) || 256 * 1024 * 1024;

/**
 * 结果帧前缀。guest 只能回一个**字符串**，所以我们在 guest 内部就把值 `JSON.stringify` 掉，
 * 由这个前缀 + 状态行告诉宿主该怎么解释它。
 *
 * 为什么不让 guest 直接把对象交回来：库的 `handleToNative` 会用 guest 提供的键名
 * 反向构造宿主对象，并且实测在序列化任何非原始值时都会漏句柄，
 * 导致 runtime 释放时 `JS_FreeRuntime` 断言 abort 掉整个进程（见 sanitize.js 的说明）。
 * 只回字符串等于把这条路径彻底关掉。
 */
const FRAME_PREFIX = 'aicode:';

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
 * 发送一帧；失败时静默（父进程可能已经死了）。
 *
 * 用同步写：消息都很小（结果帧最多 512K），管道对面父进程一直在读；
 * 部分写要自己循环，`fs.writeSync` 不保证一次写完。
 *
 * @param {object} message
 * @param {(error?: Error|null) => void} [callback]
 */
function send(message, callback) {
  try {
    const frame = aicodeFraming.encodeFrame(message);
    let offset = 0;
    while (offset < frame.length) {
      offset += fs.writeSync(WRITE_FD, frame, offset, frame.length - offset);
    }
    callback?.(null);
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
 * 生成交给 QuickJS 的模块源码。
 *
 * 用户代码插在内部 async IIFE 里（因此可以直接 `return`、可以用顶层 await），
 * 外层负责把返回值编码成**一个字符串**，永远不把对象交回宿主。
 *
 * @param {string} code 用户代码
 * @returns {string}
 */
function buildHarnessSource(code) {
  const limit = aicodeSanitize.MAX_RESULT_CHARS;
  return [
    'export default (async () => {',
    `  const __limit = ${limit};`,
    '  const __emit = (status, text) => "aicode:" + status + "\\n" + text;',
    '  const __encode = (status, value) => {',
    '    let json;',
    '    try { json = JSON.stringify(value); }',
    '    catch (error) {',
    '      return __emit("uns", JSON.stringify({ message: String((error && error.message) || error) }));',
    '    }',
    '    if (json === undefined) return __emit("void", "");',
    '    if (json.length > __limit) {',
    '      return __emit("big", JSON.stringify({ truncated: true, size: json.length, preview: json.slice(0, __limit) }));',
    '    }',
    '    return __emit(status, json);',
    '  };',
    '  try {',
    '    const __value = await (async () => {',
    code,
    '    })();',
    '    return __encode("ok", __value);',
    '  } catch (error) {',
    '    return __encode("err", {',
    '      name: String((error && error.name) || "Error"),',
    '      message: String((error && error.message) || error),',
    '      stack: typeof (error && error.stack) === "string" ? error.stack.slice(0, 2000) : undefined,',
    '    });',
    '  }',
    '})();',
  ].join('\n');
}

/**
 * 解析 guest 回传的结果帧。
 *
 * 帧是 `aicode:<status>\n<payload>`：状态行固定、payload 是 `JSON.stringify` 的产物，
 * 所以用户代码无法伪造状态（它的返回值本身会被再 stringify 一次，转义掉换行）。
 * 任何不符合格式的东西都视为协议异常（`throw`），由调用方回收子进程。
 *
 * @param {unknown} raw
 * @returns {{ ok: boolean, data?: unknown, error?: { name: string, message: string } }}
 */
function decodeResultFrame(raw) {
  if (typeof raw !== 'string' || !raw.startsWith(FRAME_PREFIX)) {
    throw new Error(`沙箱返回了非预期格式的结果（${typeof raw}）`);
  }
  const rest = raw.slice(FRAME_PREFIX.length);
  const newline = rest.indexOf('\n');
  const status = newline < 0 ? rest : rest.slice(0, newline);
  const payload = newline < 0 ? '' : rest.slice(newline + 1);
  const parsePayload = (name) => {
    try {
      return JSON.parse(payload);
    } catch (error) {
      throw new Error(`沙箱结果帧解析失败（${name}）：${error?.message ?? error}`);
    }
  };

  switch (status) {
    case 'void':
      return { ok: true, data: null };
    case 'ok':
      return { ok: true, data: aicodeSanitize.sanitizeResult(parsePayload('ok')) };
    case 'big':
      return { ok: true, data: aicodeSanitize.sanitizeResult(parsePayload('big')) };
    case 'uns': {
      const detail = parsePayload('uns');
      return {
        ok: false,
        error: {
          name: 'UnserializableResult',
          message: `返回值无法序列化为 JSON：${String(detail?.message ?? '未知原因')}`,
        },
      };
    }
    case 'err': {
      const detail = parsePayload('err');
      return {
        ok: false,
        error: {
          name: String(detail?.name ?? 'Error').slice(0, 64),
          message: String(detail?.message ?? '').slice(0, 2000),
        },
      };
    }
    default:
      throw new Error(`沙箱结果帧状态未知：${status.slice(0, 32)}`);
  }
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
    // 不给 guest 任何宿主环境变量：库默认会填 `{ NODE_DEBUG: 'true' }`，显式清空更稳
    env: {},
    // 不把沙箱 console 转发到宿主：既防日志伪造，也把输出作为结果的一部分带回
    console: { log: pushLog, info: pushLog, warn: pushLog, error: pushLog, debug: pushLog },
  };

  const context = vm.createContext({
    __runSandboxed: runSandboxed,
    __code: buildHarnessSource(code),
    __options: options,
  }, {
    name: 'aicode-task',
    // 胶水代码不需要 eval / 动态 wasm；关掉，缩小攻击面
    codeGeneration: { strings: false, wasm: false },
  });

  const harness = '(async () => __runSandboxed(async ({ evalCode }) => evalCode(__code, "/src/task.js"), __options))()';
  // `runSandboxed` 回的是它自己的信封 `{ ok, data | error }`，其中 `data` 才是我们那帧字符串。
  // 信封由库在宿主侧构造，不经过 `handleToNative`，所以这里拿到它是安全的。
  const envelope = await vm.runInContext(harness, context, { filename: 'aicode-harness.js' });
  if (!envelope || envelope.ok !== true) {
    const error = envelope?.error;
    return {
      ok: false,
      error: {
        name: String(error?.name ?? 'Error').slice(0, 64),
        message: String(error?.message ?? error ?? '沙箱执行失败').slice(0, 2000),
      },
    };
  }
  return decodeResultFrame(envelope.data);
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
  /** 运行时级异常（wasm abort / 帧格式不符等）：整条进程不可信，必须回收 */
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

  // 资源超限 / 协议异常：不返回结果，直接通知父进程并自杀（父进程会 reject 本次任务）
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

  // 体积封顶兜底（帧在 guest 内已封过一次，这里防的是「帧被绕过」的情形）
  const data = result?.ok ? aicodeSanitize.shrinkResult(result.data) : undefined;
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

/**
 * 处理父进程下发的一条消息（解码器已校验过它是个对象）。
 * @param {object} message
 */
function onMessage(message) {
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
}

const channel = aicodeFraming.createFrameDecoder(onMessage, (reason) => {
  // 父进程不可能给我们发坏帧；收到就说明通道被第三方动了，留下只会更糟
  console.error(`[aicode] 收到非法帧：${reason}`);
  process.exit(1);
});

const reader = fs.createReadStream(null, { fd: READ_FD, autoClose: false });
reader.on('data', (chunk) => channel.push(chunk));
reader.on('error', () => process.exit(1));
// 父进程关闭写端 = 再也不会有人喂食；立刻退出，避免孤儿进程
reader.on('end', () => process.exit(1));

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
  if (Date.now() - lastTaskAt <= IDLE_MAX_MS) return;
  clearInterval(feedTimer);
  clearInterval(idleTimer);
  sendAndExit({ type: IPC.BYE, reason: 'idle timeout' }, 0);
}, Math.max(1000, Math.min(5000, Math.floor(IDLE_MAX_MS / 4))));

send({ type: IPC.READY });
