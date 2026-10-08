/**
 * protocol/uds.js — 跨平台 UDS（Unix Domain Socket / 命名管道）通道
 *
 * UDS 模式下 Neonaic 是**被动端**：JoyousPlugin 建立通信路径（POSIX 上是监听套接字文件，
 * Windows 上是命名管道），Neonaic 主动去连接它，握手完成后双方以「JSON + `\n`」交换数据，
 * 从而拿到与 HTTP 模式等价的能力（命令执行入、状态查询出）。
 *
 * ── 跨平台一致性怎么保证 ──
 * 不去写两份分支逻辑，而是把差异**压缩到「端点字符串的解析」这一处**：
 *   POSIX ：`/tmp/neonai-joyous.sock`          → Node 视作文件系统套接字
 *   Windows：`\\.\pipe\neonai-joyous`          → Node/libuv 视作命名管道
 * 除此之外的上层代码（握手、分帧、请求响应、重连、心跳）完全共用同一实现 ——
 * 见 {@link JoyousBridgeSession}。平台差异只剩一个纯函数 {@link resolveUdsEndpoint}，
 * 因此可以离线单测两个平台的行为，不需要真的在 Windows 上跑。
 *
 * ── 为什么必须自己做重连与心跳 ──
 * UDS 的「半开连接」不会自己报错：对端进程被杀掉后，本端的 socket 对象仍然是「已连接」的，
 * 读写却永远不返回。因此只能靠心跳探活（在 session 里）+ 指数退避重连（在本文件里）。
 *
 * 协议全貌见 ../../PROTOCOL.md 。
 */

import { basename } from 'node:path';
import { connect } from 'node:net';
import {
  NeonaicIllegalArgumentError,
  NeonaicIllegalStateError,
} from '../../../../src/utils/NeonaicNewableError.js';
import { JoyousBridgeSession } from './session.js';
import {
  CHANNEL_STATES,
  DEFAULT_TIMEOUTS,
  HANDSHAKE_MODES,
} from './constants.js';
import { JoyousNewable } from '../utils.js';

/** POSIX 下的默认套接字路径 */
export const DEFAULT_UDS_PATH = '/tmp/neonai-joyous.sock';

/** Windows 下的默认命名管道名（不含 `\\.\pipe\` 前缀） */
export const DEFAULT_PIPE_NAME = 'neonai-joyous';

/** Windows 命名管道前缀 */
const WINDOWS_PIPE_PREFIX = '\\\\.\\pipe\\';

/** 空日志器 */
const NULL_LOG = Object.freeze({ debug() { }, info() { }, warn() { }, error() { } });

/**
 * 把协议文档里的「逻辑端点」解析成当前平台 `net.connect` 实际可用的字符串。
 *
 * 语义：
 * - Windows：优先用显式配置的 `pipe`；未配置则从 `path` 的文件名推导管道名
 *   （`/var/run/neonai-joyous.sock` → `neonai-joyous`）。已带 `\\.\pipe\` 前缀的原样返回。
 * - POSIX：忽略 `pipe`，直接使用 `path`。
 *
 * @param {string} [path=DEFAULT_UDS_PATH] POSIX 套接字路径（也是 Windows 推导管道名的来源）
 * @param {string} [pipe=''] Windows 管道名或完整管道路径
 * @param {string} [platform=process.platform] 平台，显式传入以便离线单测
 * @returns {string} 可直接交给 `net.connect({ path })` 的端点
 * @throws {NeonaicIllegalArgumentError} 端点为空
 */
export function resolveUdsEndpoint(path = DEFAULT_UDS_PATH, pipe = '', platform = process.platform) {
  const rawPath = String(path ?? '').trim();
  const rawPipe = String(pipe ?? '').trim();

  if (platform !== 'win32') {
    if (!rawPath) throw new NeonaicIllegalArgumentError('UDS 套接字路径不能为空');
    return rawPath;
  }

  if (rawPipe) {
    return rawPipe.startsWith(WINDOWS_PIPE_PREFIX) ? rawPipe : `${WINDOWS_PIPE_PREFIX}${rawPipe}`;
  }
  if (!rawPath) throw new NeonaicIllegalArgumentError('UDS 套接字路径不能为空');

  if (rawPath.startsWith(WINDOWS_PIPE_PREFIX)) return rawPath;

  // 从 POSIX 风格路径推导管道名：取最后一段并去掉 .sock 后缀
  const segment = String(basename(rawPath.replace(/\\/g, '/'))).replace(/\.sock$/i, '');
  return `${WINDOWS_PIPE_PREFIX}${segment || DEFAULT_PIPE_NAME}`;
}

/**
 * 把连接失败翻译成可执行的排查提示。
 * @param {Error} error
 * @param {string} endpoint
 * @param {string} platform
 * @returns {string}
 */
export function describeConnectError(error, endpoint, platform = process.platform) {
  const code = error?.code ?? '';
  if (platform === 'win32') {
    if (code === 'ENOENT') {
      return `命名管道 ${endpoint} 不存在：JoyousPlugin 未启动，或管道名与插件配置不一致`;
    }
    if (code === 'EACCES') {
      return `无权连接命名管道 ${endpoint}：请确认 Neonaic 与 JoyousPlugin 运行在同一账户下`;
    }
    return `连接命名管道 ${endpoint} 失败：${error?.message ?? error}`;
  }

  if (code === 'ENOENT') {
    return `套接字文件 ${endpoint} 不存在：JoyousPlugin 未启动，或路径与插件配置不一致`;
  }
  if (code === 'ECONNREFUSED') {
    return `套接字文件 ${endpoint} 存在但无人监听：多为 JoyousPlugin 上次异常退出留下的陈留套接字。` +
      '本端是连接方、并非该文件的所有者，不会自行删除它；请重启 JoyousPlugin 或由插件侧清理。';
  }
  if (code === 'EACCES') {
    return `无权连接套接字 ${endpoint}：请检查文件权限与运行账户`;
  }
  return `连接套接字 ${endpoint} 失败：${error?.message ?? error}`;
}

/**
 * UDS 链路的可观测事件。
 * @typedef {'state'|'ready'|'closed'|'error'|'retry'|'event'} UdsLinkEvent
 */

/**
 * 维护「与 JoyousPlugin 的 UDS 长连接」：拨号 → 握手 → 收发 → 掉线 → 退避重连。
 */
export class JoyousUdsLink extends JoyousNewable {
  static type = 'joyous.uds';

  /** @type {string} 解析后的实际端点 */
  #endpoint;
  /** @type {string} 平台（构造时固定，避免运行时被改） */
  #platform;
  /** @type {object} */
  #options;
  /** @type {ReturnType<typeof Object.freeze>} */
  #log;
  /** @type {Map<string, Function>} */
  #methods = new Map();
  /** @type {import('node:net').Socket|null} */
  #socket = null;
  /** @type {JoyousBridgeSession|null} */
  #session = null;
  /** @type {Map<string, Set<Function>>} */
  #listeners = new Map();
  /** @type {boolean} */
  #running = false;
  /** @type {any} */
  #retryTimer = null;
  /** @type {number} 连续失败次数，握手成功即清零 */
  #attempt = 0;
  /** @type {string} 最近一次连接错误（供日志与状态查询） */
  #lastError = '';
  /** @type {string} 链路状态 */
  #state = CHANNEL_STATES.IDLE;
  /** @type {number} 下次重连的时刻（0 表示无计划） */
  #nextRetryAt = 0;

  /**
   * @param {object} options
   * @param {string} [options.path] POSIX 套接字路径（Windows 下用于推导管道名）
   * @param {string} [options.pipe] Windows 管道名或完整管道路径
   * @param {string} [options.mode=HANDSHAKE_MODES.RESPONDER] 握手次序
   * @param {object} options.self 本端自述信息 `{ name, version, capabilities? }`
   * @param {object} [options.methods] 方法名 → 处理器，供对端调用
   * @param {object} [options.timeouts] 覆盖 {@link DEFAULT_TIMEOUTS}
   * @param {object} [options.reconnect] `{ enabled, initialDelayMs, maxDelayMs, factor, jitterRatio }`
   * @param {object} [options.log] 日志器
   * @param {string} [options.platform=process.platform] 平台，便于离线单测
   */
  constructor(options = {}) {
    super();
    const {
      path = DEFAULT_UDS_PATH, pipe = '', mode = HANDSHAKE_MODES.RESPONDER,
      self, methods, timeouts, reconnect, log, platform = process.platform,
    } = options;

    if (!self || typeof self !== 'object') {
      throw new NeonaicIllegalArgumentError('UDS 链路必须提供 self 自述信息');
    }
    if (mode !== HANDSHAKE_MODES.RESPONDER && mode !== HANDSHAKE_MODES.INITIATOR) {
      throw new NeonaicIllegalArgumentError(`未知的握手次序：${mode}`);
    }

    this.#platform = platform;
    this.#endpoint = resolveUdsEndpoint(path, pipe, platform);
    this.#log = log ?? NULL_LOG;
    this.#options = {
      mode,
      timeouts: { ...DEFAULT_TIMEOUTS, ...(timeouts ?? {}) },
      self,
      reconnect: {
        enabled: true, initialDelayMs: 1000, maxDelayMs: 30000, factor: 2, jitterRatio: 0.2,
        ...(reconnect ?? {}),
      },
    };

    if (methods && typeof methods === 'object') {
      for (const [name, handler] of Object.entries(methods)) {
        if (typeof handler === 'function') this.#methods.set(name, handler);
      }
    }
  }

  // ---- 只读视图 ----

  /** 解析后的实际端点（POSIX 路径或 Windows 管道全名） @returns {string} */
  get endpoint() { return this.#endpoint; }

  /** 链路状态 @returns {string} */
  get state() { return this.#state; }

  /** 是否已握手完成、可收发业务帧 @returns {boolean} */
  get ready() { return this.#state === CHANNEL_STATES.READY; }

  /** 当前会话（未连接时为 null） @returns {JoyousBridgeSession|null} */
  get session() { return this.#session; }

  /** 对端信息 @returns {object|null} */
  get peer() { return this.#session?.peer ?? null; }

  /** 连续连接失败次数 @returns {number} */
  get attempts() { return this.#attempt; }

  /** 最近一次连接错误描述 @returns {string} */
  get lastError() { return this.#lastError; }

  /**
   * 供状态命令展示的一句话快照。
   * @returns {object}
   */
  get status() {
    return {
      endpoint: this.#endpoint,
      platform: this.#platform,
      state: this.#state,
      ready: this.ready,
      peer: this.peer,
      attempts: this.#attempt,
      lastError: this.#lastError,
      nextRetryAt: this.#nextRetryAt || null,
    };
  }

  // ---- 事件 ----

  /**
   * @param {UdsLinkEvent} event
   * @param {Function} handler
   * @returns {() => void} 取消订阅
   */
  on(event, handler) {
    if (typeof handler !== 'function') throw new NeonaicIllegalArgumentError('事件处理器必须是函数');
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }

  /** @param {UdsLinkEvent} event @param {Function} handler */
  off(event, handler) { this.#listeners.get(event)?.delete(handler); }

  // ---- 生命周期 ----

  /**
   * 开始连接（并在掉线后自动重连）。
   * @returns {this}
   */
  start() {
    if (this.#running) return this;
    this.#running = true;
    this.#log.info?.(`[joyous/uds] 将以被动端身份连接 ${this.#endpoint}（平台 ${this.#platform}）`);
    this.#dial();
    return this;
  }

  /**
   * 停止连接与重连，并关闭当前会话。
   * @returns {void}
   */
  stop() {
    this.#running = false;
    this.#clearRetryTimer();
    const session = this.#session;
    this.#session = null;

    if (session && session.state !== CHANNEL_STATES.CLOSED) {
      session.close('本端已停止 UDS 桥接');
    }
    if (this.#socket && !this.#socket.destroyed) {
      this.#socket.destroy();
    }
    this.#socket = null;
    this.#setState(CHANNEL_STATES.CLOSED);
  }

  /**
   * 主动向对端发起一次请求（例如经 UDS 查询状态，以达成与 HTTP 模式等价的目的）。
   * @param {string} method
   * @param {object} [payload]
   * @param {number} [timeoutMs]
   * @returns {Promise<object>}
   * @throws {NeonaicIllegalStateError} 链路未就绪
   */
  request(method, payload = {}, timeoutMs) {
    const session = this.#session;
    if (!session || !session.ready) {
      throw new NeonaicIllegalStateError(
        `UDS 链路尚未就绪（状态：${this.#state}${this.#lastError ? `，最近错误：${this.#lastError}` : ''}）`,
      );
    }
    return session.request(method, payload, timeoutMs);
  }

  /**
   * 以 on 语义订阅一次性的「已就绪」等待，超时抛错。
   * @param {number} [timeoutMs]
   * @returns {Promise<object>} 对端信息
   */
  waitUntilReady(timeoutMs = DEFAULT_TIMEOUTS.HANDSHAKE) {
    if (this.ready) return Promise.resolve(this.peer);
    return new Promise((resolve, reject) => {
      const off = this.on('ready', (peer) => {
        clearTimeout(timer);
        off();
        resolve(peer);
      });
      const timer = setTimeout(() => {
        off();
        reject(new NeonaicIllegalStateError(`等待 UDS 链路就绪超时（${timeoutMs}ms）`));
      }, timeoutMs);
      timer.unref?.();
    });
  }

  // ---- 内部：连接与重连 ----

  #dial() {
    if (!this.#running) return;
    this.#clearRetryTimer();
    this.#lastError = '';
    this.#setState(CHANNEL_STATES.CONNECTING);

    /** @type {import('node:net').Socket} */
    let socket;
    try {
      socket = connect({ path: this.#endpoint });
    } catch (e) {
      this.#onConnectFailure(e);
      return;
    }
    this.#socket = socket;
    // 直接按 UTF-8 解码，StringDecoder 会正确处理跨 chunk 的多字节字符
    socket.setEncoding('utf8');

    const session = new JoyousBridgeSession({
      write: (text) => {
        if (!socket.destroyed) socket.write(text);
      },
      teardown: (why) => {
        this.#log.debug?.(`[joyous/uds] 会话要求断开：${why}`);
        socket.destroy();
      },
      mode: this.#options.mode,
      self: this.#options.self,
      timeouts: this.#options.timeouts,
      log: this.#log,
    });
    for (const [name, handler] of this.#methods) session.registerMethod(name, handler);
    this.#session = session;
    this.#bindSession(session);

    socket.on('connect', () => {
      this.#setState(CHANNEL_STATES.HANDSHAKING);
      session.beginHandshake();
    });
    socket.on('data', (chunk) => session.acceptChunk(chunk));
    socket.on('error', (err) => {
      this.#lastError = describeConnectError(err, this.#endpoint, this.#platform);
    });
    socket.on('close', () => {
      if (this.#session !== session) return; // 已被更新的连接取代
      this.#session = null;
      this.#socket = null;
      session.transportClosed(this.#lastError || '底层连接已关闭');
      this.#setState(CHANNEL_STATES.CLOSED);
      this.#scheduleReconnect();
    });
  }

  /**
   * 把会话事件冒泡到链路事件，并处理退避计数。
   * @param {JoyousBridgeSession} session
   */
  #bindSession(session) {
    session.on('ready', (peer) => {
      // 只有握手成功才清零退避，否则「连上就被踢」会变成高频重连风暴
      this.#attempt = 0;
      this.#lastError = '';
      this.#nextRetryAt = 0;
      this.#setState(CHANNEL_STATES.READY);
      this.#emit('ready', peer);
    });
    session.on('state', (state, previous) => {
      this.#log.debug?.(`[joyous/uds] 会话状态 ${previous} → ${state}`);
    });
    session.on('error', (err) => this.#emit('error', err));
    session.on('event', (frame) => this.#emit('event', frame));
  }

  /** @param {Error} error */
  #onConnectFailure(error) {
    this.#lastError = describeConnectError(error, this.#endpoint, this.#platform);
    this.#emit('error', error);
    this.#setState(CHANNEL_STATES.CLOSED);
    this.#scheduleReconnect();
  }

  #scheduleReconnect() {
    if (!this.#running || !this.#options.reconnect.enabled) {
      if (this.#running) this.#log.warn?.('[joyous/uds] 已禁用自动重连，UDS 桥接将保持断开');
      return;
    }
    this.#attempt += 1;

    const { initialDelayMs, maxDelayMs, factor, jitterRatio } = this.#options.reconnect;
    const base = Math.min(maxDelayMs, initialDelayMs * Math.pow(factor, this.#attempt - 1));
    const jitter = base * jitterRatio * (Math.random() * 2 - 1); // ±jitterRatio
    const delay = Math.max(0, Math.round(base + jitter));

    this.#nextRetryAt = Date.now() + delay;
    this.#log.warn?.(
      `[joyous/uds] ${this.#lastError || '连接已断开'}；第 ${this.#attempt} 次重连将在 ${delay}ms 后发起`,
    );
    this.#emit('retry', { attempt: this.#attempt, delay, at: this.#nextRetryAt, reason: this.#lastError });

    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#dial();
    }, delay);
    this.#retryTimer.unref?.();
  }

  #clearRetryTimer() {
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    this.#nextRetryAt = 0;
  }

  /** @param {string} next */
  #setState(next) {
    if (this.#state === next) return;
    const previous = this.#state;
    this.#state = next;
    this.#emit('state', next, previous);
  }

  /**
   * @param {UdsLinkEvent} event
   * @param {...*} args
   */
  #emit(event, ...args) {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(...args);
      } catch (e) {
        this.#log.error?.(`[joyous/uds] 事件 ${event} 的监听器抛出异常：${e?.message ?? e}`);
      }
    }
  }
}
