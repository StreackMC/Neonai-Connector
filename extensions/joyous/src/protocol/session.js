/**
 * protocol/session.js — 传输无关的桥接会话
 *
 * 职责边界（这是本模块存在的全部理由）：
 *   本模块**只管协议语义**——握手状态机、请求/响应按 id 关联、事件派发、心跳探活；
 *   它**完全不知道**底层是 UDS、TCP 还是别的什么。
 *
 * 与传输层的接口只有两个回调：
 *   - `write(text)`   把一帧文本写出去（半帧由传输层自己拼，本层只给整帧）
 *   - `teardown(why)` 要求关闭底层连接（本层不做重连，重连是传输层的事）
 *
 * 这样切分的收益：UDS 与未来任何「面向流的传输」都能直接复用同一套协议实现，
 * 跨平台行为一致性由「同一份代码」保证，而不是靠两个平台各自对齐。
 */

import {
  NeonaicIllegalArgumentError,
  NeonaicIllegalStateError,
  NeonaicProtocolError,
} from '../../../../src/utils/NeonaicNewableError.js';
import { JoyousNewable } from '../utils.js';
import { JoyousLineFrameCodec } from './codec.js';
import {
  CHANNEL_ROLES,
  CHANNEL_STATES,
  DEFAULT_TIMEOUTS,
  ERROR_CODES,
  FRAME_TYPES,
  HANDSHAKE_MODES,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
} from './constants.js';

/**
 * 桥接会话的可观测事件。
 * @typedef {'state'|'ready'|'closed'|'error'|'frame'|'event'} BridgeEvent
 */

/**
 * 对端信息（握手后填充）。
 * @typedef {object} PeerInfo
 * @property {string} role 对端角色
 * @property {string} name 对端名称
 * @property {string} version 对端版本
 * @property {string} protocol 对端声明的协议名
 * @property {number} v 对端声明的协议主版本
 * @property {string[]} capabilities 对端申报的能力
 * @property {string} session 对端会话标识
 * @property {number} timestamp 对端握手时间戳
 */

/** 默认空日志器：让本模块可以在没有内核的环境中独立跑测试 */
const NULL_LOG = Object.freeze({
  debug() { }, info() { }, warn() { }, error() { },
});

export class JoyousBridgeSession extends JoyousNewable {
  static type = '<BRIDGE>';

  /** @type {(text: string) => void} */
  #write;
  /** @type {(why: string) => void} */
  #teardown;
  /** @type {ReturnType<typeof Object.freeze>} */
  #log;
  /** @type {JoyousLineFrameCodec} */
  #codec;
  /** @type {string} 握手次序 */
  #mode;
  /** @type {object} 本端自述信息 */
  #self;
  /** @type {Map<string, (payload: object) => any>} 方法名 → 业务处理器 */
  #methods = new Map();
  /** @type {Map<string, Set<Function>>} 事件 → 监听器 */
  #listeners = new Map();
  /** @type {Map<string, { resolve: Function, reject: Function, timer: any, method: string }>} */
  #pending = new Map();
  /** @type {Map<string, any>} 各阶段超时配置 */
  #timeouts;
  /** @type {string} */
  #state = CHANNEL_STATES.IDLE;
  /** @type {PeerInfo|null} */
  #peer = null;
  /** @type {string} 本次会话标识，仅用于日志关联 */
  #sessionId;
  /** @type {any} */
  #handshakeTimer = null;
  /** @type {any} */
  #heartbeatTimer = null;
  /** @type {number} */
  #seq = 0;

  /**
   * @param {object} options
   * @param {(text: string) => void} options.write 写出一整帧文本
   * @param {(why: string) => void} [options.teardown] 要求关闭底层连接
   * @param {string} [options.mode=HANDSHAKE_MODES.RESPONDER] 握手次序
   * @param {object} options.self 本端自述信息 `{ name, version, capabilities? }`
   * @param {object} [options.timeouts] 覆盖 {@link DEFAULT_TIMEOUTS}
   * @param {object} [options.log] 日志器（需具备 debug/info/warn/error）
   * @param {number} [options.maxFrameBytes] 单帧字节上限
   */
  constructor(options = {}) {
    super();
    const {
      write, teardown, mode = HANDSHAKE_MODES.RESPONDER,
      self, timeouts, log, maxFrameBytes,
    } = options;

    if (typeof write !== 'function') {
      throw new NeonaicIllegalArgumentError('桥接会话必须提供 write 回调');
    }
    if (!self || typeof self !== 'object') {
      throw new NeonaicIllegalArgumentError('桥接会话必须提供 self 自述信息');
    }
    if (mode !== HANDSHAKE_MODES.RESPONDER && mode !== HANDSHAKE_MODES.INITIATOR) {
      throw new NeonaicIllegalArgumentError(`未知的握手次序：${mode}`);
    }

    this.#write = write;
    this.#teardown = typeof teardown === 'function' ? teardown : () => { };
    this.#mode = mode;
    this.#self = {
      name: String(self.name ?? 'neonai'),
      version: String(self.version ?? '0.0.0'),
      capabilities: Array.isArray(self.capabilities) ? [...self.capabilities] : [],
    };
    this.#timeouts = { ...DEFAULT_TIMEOUTS, ...(timeouts ?? {}) };
    this.#log = log ?? NULL_LOG;
    this.#codec = new JoyousLineFrameCodec(maxFrameBytes);
    this.#sessionId = `na-${this.INSTANCE_ID.toString(36)}`;
  }

  // ---- 只读视图 ----

  /** 当前状态 @returns {string} */
  get state() { return this.#state; }

  /** 是否已完成握手、可收发业务帧 @returns {boolean} */
  get ready() { return this.#state === CHANNEL_STATES.READY; }

  /** 对端信息，握手前为 null @returns {PeerInfo|null} */
  get peer() { return this.#peer; }

  /** 本端会话标识 @returns {string} */
  get sessionId() { return this.#sessionId; }

  /** 尚未应答的请求数 @returns {number} */
  get inflight() { return this.#pending.size; }

  // ---- 业务方法注册 ----

  /**
   * 注册一个可被对端调用的方法。
   * @param {string} method 方法名，建议取自 {@link METHODS}
   * @param {(payload: object, frame: object) => any} handler 处理器，返回值作为 `response.payload`
   * @returns {this}
   * @throws {NeonaicIllegalStateError} 会话已启动后不允许再注册
   */
  registerMethod(method, handler) {
    if (!method || typeof handler !== 'function') {
      throw new NeonaicIllegalArgumentError('注册方法时需要合法的方法名与处理器');
    }
    if (this.#state !== CHANNEL_STATES.IDLE) {
      throw new NeonaicIllegalStateError('会话已启动，不能再注册方法');
    }
    this.#methods.set(method, handler);
    return this;
  }

  // ---- 事件 ----

  /**
   * 订阅事件。
   * @param {BridgeEvent} event
   * @param {Function} handler
   * @returns {() => void} 取消订阅
   */
  on(event, handler) {
    if (typeof handler !== 'function') throw new NeonaicIllegalArgumentError('事件处理器必须是函数');
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }

  /** 取消订阅 @param {BridgeEvent} event @param {Function} handler */
  off(event, handler) {
    this.#listeners.get(event)?.delete(handler);
  }

  // ---- 生命周期（由传输层驱动）----

  /**
   * 底层连接已建立，开始握手。
   * @apiNote 由传输层在 socket 的 `connect` 之后调用。
   */
  beginHandshake() {
    if (this.#state !== CHANNEL_STATES.IDLE) return;
    this.#setState(CHANNEL_STATES.CONNECTING);
    this.#setState(CHANNEL_STATES.HANDSHAKING);

    const limit = Number(this.#timeouts.HANDSHAKE);
    if (limit > 0) {
      this.#handshakeTimer = setTimeout(() => this.#failHandshake(
        ERROR_CODES.HANDSHAKE_TIMEOUT,
        `${limit}ms 内未完成握手`,
      ), limit);
      this.#handshakeTimer.unref?.();
    }

    if (this.#mode === HANDSHAKE_MODES.INITIATOR) {
      this.#send(selfFrame(FRAME_TYPES.HELLO, this.#self, this.#sessionId));
    } else {
      this.#log.debug?.(`[joyous/bridge] 以被动端姿态等待对端 hello（会话 ${this.#sessionId}）`);
    }
  }

  /**
   * 底层收到一段文本。
   * @param {string} chunk
   */
  acceptChunk(chunk) {
    if (this.#state === CHANNEL_STATES.CLOSED) return;

    let result;
    try {
      result = this.#codec.push(chunk);
    } catch (e) {
      // 半包超限：缓冲已被丢弃，链路状态不可信，直接断开
      this.#emit('error', e);
      this.#teardown(`分帧失败：${e?.message ?? e}`);
      return;
    }

    for (const item of result.bad) {
      const err = new NeonaicProtocolError(`收到无法解析的帧：${item.error}`);
      err.code = ERROR_CODES.BAD_FRAME;
      this.#log.warn?.(`[joyous/bridge] ${err.message}｜原文：${item.raw}`);
      this.#emit('error', err);
    }

    for (const frame of result.frames) {
      this.#emit('frame', frame);
      try {
        this.#dispatchFrame(frame);
      } catch (e) {
        // 单帧处理失败不应带崩整条连接
        this.#log.error?.(`[joyous/bridge] 处理帧 ${frame?.type} 时出错：${e?.message ?? e}`);
        this.#emit('error', e);
      }
    }
  }

  /**
   * 底层连接已断开。
   * @param {string} [reason]
   * @param {Error|null} [error]
   */
  transportClosed(reason = '底层连接已关闭', error = null) {
    if (this.#state === CHANNEL_STATES.CLOSED) return;
    const wasReady = this.#state === CHANNEL_STATES.READY;
    this.#cleanupTimers();
    this.#rejectAll(new NeonaicProtocolError(`通道关闭：${reason}`, error));
    this.#setState(CHANNEL_STATES.CLOSED);
    this.#emit('closed', { reason, error, wasReady });
  }

  /**
   * 主动关闭会话。
   * @param {string} [reason]
   */
  close(reason = '本端主动关闭') {
    if (this.#state === CHANNEL_STATES.CLOSED) return;
    // 先标记已关闭，避免 teardown 回调再次回到 transportClosed
    this.transportClosed(reason, null);
    this.#teardown(reason);
  }

  // ---- 发送 ----

  /**
   * 发送一次请求并等待应答。
   * @param {string} method 方法名
   * @param {object} [payload]
   * @param {number} [timeoutMs] 缺省用 `timeouts.REQUEST`
   * @returns {Promise<object>} 应答帧的 `payload`
   * @throws {NeonaicIllegalStateError} 尚未握手完成
   * @throws {NeonaicProtocolError} 超时 / 对端返回错误 / 通道关闭
   */
  request(method, payload = {}, timeoutMs) {
    if (!this.ready) {
      throw new NeonaicIllegalStateError(`通道尚未就绪（当前状态：${this.#state}），无法发送请求 ${method}`);
    }
    const id = this.#nextId();
    const frame = {
      v: PROTOCOL_VERSION,
      type: FRAME_TYPES.REQUEST,
      id,
      ts: Date.now(),
      method,
      payload,
    };

    const limit = Number(timeoutMs ?? this.#timeouts.REQUEST);
    return new Promise((resolve, reject) => {
      const timer = limit > 0 ? setTimeout(() => {
        this.#pending.delete(id);
        const err = new NeonaicProtocolError(`请求 ${method}（id=${id}）在 ${limit}ms 内未收到应答`);
        err.code = ERROR_CODES.TIMEOUT;
        reject(err);
      }, limit) : null;
      timer?.unref?.();

      this.#pending.set(id, { resolve, reject, timer, method });
      if (!this.#send(frame)) {
        this.#settle(id, (slot) => slot.reject(
          new NeonaicProtocolError(`请求 ${method}（id=${id}）未能送出：通道已关闭或编码失败`),
        ));
      }
    });
  }

  /**
   * 发送单向事件帧（不等待应答）。
   * @param {string} name 事件名
   * @param {object} [payload]
   * @returns {boolean} 是否已送出
   */
  notify(name, payload = {}) {
    if (!this.ready) return false;
    return this.#send({
      v: PROTOCOL_VERSION,
      type: FRAME_TYPES.EVENT,
      id: this.#nextId(),
      ts: Date.now(),
      method: name,
      payload,
    });
  }

  // ---- 内部：帧分发 ----

  /** @param {object} frame */
  #dispatchFrame(frame) {
    const type = frame?.type;

    switch (type) {
      case FRAME_TYPES.HELLO:
        this.#onHandshakeFrame(FRAME_TYPES.HELLO, frame);
        return;
      case FRAME_TYPES.WELCOME:
        this.#onHandshakeFrame(FRAME_TYPES.WELCOME, frame);
        return;
      case FRAME_TYPES.PING:
        this.#replyPong(frame);
        return;
      case FRAME_TYPES.PONG:
        this.#settle(frame.id, (slot) => slot.resolve(frame.payload ?? {}));
        return;
      default:
        break;
    }

    if (this.#state !== CHANNEL_STATES.READY) {
      // 尚未握手就发业务帧：属对端实现缺陷，回错误帧但不撕破脸（可能只是时序竞争）
      const err = new NeonaicProtocolError(`未完成握手就收到 ${type} 帧`);
      err.code = ERROR_CODES.NOT_HANDSHAKEN;
      this.#log.warn?.(`[joyous/bridge] ${err.message}`);
      this.#emit('error', err);
      if (frame?.id) this.#sendError(frame.id, ERROR_CODES.NOT_HANDSHAKEN, err.message);
      return;
    }

    switch (type) {
      case FRAME_TYPES.REQUEST:
        void this.#onRequest(frame).catch((e) => {
          this.#log.error?.(`[joyous/bridge] 处理请求帧时出现未捕获异常：${e?.message ?? e}`);
          this.#emit('error', e);
        });
        return;
      case FRAME_TYPES.RESPONSE:
        this.#onResponse(frame);
        return;
      case FRAME_TYPES.EVENT:
        this.#emit('event', frame);
        return;
      default: {
        const err = new NeonaicProtocolError(`未知帧类型：${String(type)}`);
        err.code = ERROR_CODES.BAD_FRAME;
        this.#log.warn?.(`[joyous/bridge] ${err.message}`);
        this.#emit('error', err);
        if (frame?.id) this.#sendError(frame.id, ERROR_CODES.BAD_FRAME, err.message);
      }
    }
  }

  /**
   * 处理握手帧。
   * @param {string} type
   * @param {object} frame
   */
  #onHandshakeFrame(type, frame) {
    // 传输层可能在 beginHandshake() 之前就把数据送上来了（对端在 accept 后立刻握手，
    // 而本端还没跑到 connect 回调）。此时补一次握手启动，否则首帧会被静默丢弃、
    // 双方互等直到握手超时。
    if (this.#state === CHANNEL_STATES.IDLE) {
      this.#log.debug?.('[joyous/bridge] 握手帧早于 beginHandshake 到达，已补启动握手');
      this.beginHandshake();
    }

    if (this.#state === CHANNEL_STATES.READY) {
      this.#log.warn?.(`[joyous/bridge] 已握手完成，忽略重复的 ${type} 帧`);
      return;
    }
    if (this.#state !== CHANNEL_STATES.HANDSHAKING) return;

    // 协议名 / 主版本必须一致
    const mismatch = checkPeerIdentity(frame);
    if (mismatch) {
      this.#failHandshake(ERROR_CODES.UNSUPPORTED_VERSION, mismatch);
      return;
    }

    this.#peer = {
      role: String(frame.role ?? CHANNEL_ROLES.JOYOUS),
      name: String(frame.name ?? 'unknown'),
      version: String(frame.version ?? 'unknown'),
      protocol: String(frame.protocol),
      v: Number(frame.v),
      capabilities: Array.isArray(frame.capabilities) ? [...frame.capabilities] : [],
      session: String(frame.session ?? ''),
      timestamp: Number(frame.ts ?? Date.now()),
    };

    // 被动端收到 hello → 回 welcome；主动端收到 welcome → 直接完成。
    // 主动端若收到的是 hello（对端也在主动），则回 welcome 并完成，避免双方僵住。
    if (type === FRAME_TYPES.HELLO) {
      this.#send(selfFrame(FRAME_TYPES.WELCOME, this.#self, this.#sessionId));
    }

    this.#finishHandshake();
  }

  /** 完成握手，进入 READY */
  #finishHandshake() {
    this.#cleanupHandshakeTimer();
    this.#setState(CHANNEL_STATES.READY);
    this.#log.info?.(
      `[joyous/bridge] 握手成功：对端 ${this.#peer.role}/${this.#peer.name} v${this.#peer.version}` +
      `（协议 ${this.#peer.protocol} v${this.#peer.v}，能力 ${this.#peer.capabilities.join(',') || '无'}，会话 ${this.#sessionId}）`,
    );
    this.#startHeartbeat();
    this.#emit('ready', this.#peer);
  }

  /**
   * 握手失败：回错误帧并断开。
   * @param {string} code
   * @param {string} message
   */
  #failHandshake(code, message) {
    const err = new NeonaicProtocolError(`握手失败（${code}）：${message}`);
    err.code = code;
    this.#log.error?.(`[joyous/bridge] ${err.message}`);
    this.#emit('error', err);
    try {
      this.#send({ v: PROTOCOL_VERSION, type: FRAME_TYPES.RESPONSE, id: null, ts: Date.now(), error: { code, message } });
    } catch { /* 发送失败也应继续关闭 */ }
    this.transportClosed(`握手失败（${code}）`, err);
    this.#teardown(`握手失败（${code}）`);
  }

  /** @param {object} frame */
  async #onRequest(frame) {
    const id = frame?.id;
    const method = frame?.method;

    if (!id || typeof id !== 'string') {
      this.#log.warn?.('[joyous/bridge] 收到缺 id 的请求帧，已丢弃');
      return;
    }
    if (!method || typeof method !== 'string') {
      this.#sendError(id, ERROR_CODES.INVALID_ARGUMENT, '请求缺少 method');
      return;
    }

    const handler = this.#methods.get(method);
    if (!handler) {
      this.#sendError(id, ERROR_CODES.UNKNOWN_METHOD, `未实现的方法：${method}`);
      return;
    }

    try {
      const payload = await handler(frame.payload ?? {}, frame);
      this.#send({
        v: PROTOCOL_VERSION,
        type: FRAME_TYPES.RESPONSE,
        id,
        ts: Date.now(),
        method,
        ok: true,
        payload: payload ?? {},
      });
    } catch (e) {
      const code = e?.code && typeof e.code === 'string' ? e.code : ERROR_CODES.INTERNAL_ERROR;
      this.#sendError(id, code, e?.message ?? String(e), e?.name);
    }
  }

  /** @param {object} frame */
  #onResponse(frame) {
    const id = frame?.id;
    if (!id || !this.#pending.has(id)) {
      this.#log.warn?.(`[joyous/bridge] 收到无对应请求的应答帧（id=${String(id)}），已丢弃`);
      return;
    }
    if (frame.ok === false || frame.error) {
      const code = frame?.error?.code ?? ERROR_CODES.INTERNAL_ERROR;
      const message = frame?.error?.message ?? '对端返回了未说明原因的失败';
      const err = new NeonaicProtocolError(`对端拒绝请求：${message}`);
      err.code = code;
      this.#settle(id, (slot) => slot.reject(err));
      return;
    }
    this.#settle(id, (slot) => slot.resolve(frame.payload ?? {}));
  }

  /** @param {object} frame */
  #replyPong(frame) {
    this.#send({
      v: PROTOCOL_VERSION,
      type: FRAME_TYPES.PONG,
      id: frame?.id ?? null,
      ts: Date.now(),
    });
  }

  // ---- 内部：发送与队列 ----

  /**
   * 送出（或尝试送出）一帧。**本方法不会抛错**：编码与写出失败都只记录并返回 false，
   * 这样调用方（含 async 的请求处理器）不会因为一次写失败产生未处理的 Promise 拒绝。
   * @param {object} frame
   * @returns {boolean} 是否已送出
   */
  #send(frame) {
    if (this.#state === CHANNEL_STATES.CLOSED) return false;

    let text;
    try {
      text = JoyousLineFrameCodec.encode(frame);
    } catch (e) {
      this.#log.error?.(`[joyous/bridge] 待发送的帧无法编码：${e?.message ?? e}`);
      this.#emit('error', e);
      return false;
    }

    try {
      this.#write(text);
    } catch (e) {
      this.#log.error?.(`[joyous/bridge] 写出帧失败：${e?.message ?? e}`);
      this.#emit('error', e);
      return false;
    }
    return true;
  }

  /**
   * @param {string} id
   * @param {string} code
   * @param {string} message
   * @param {string} [name]
   */
  #sendError(id, code, message, name) {
    this.#send({
      v: PROTOCOL_VERSION,
      type: FRAME_TYPES.RESPONSE,
      id,
      ts: Date.now(),
      ok: false,
      error: { code, message, ...(name ? { name } : {}) },
    });
  }

  /**
   * 结清一个 pending 槽位。
   * @param {string} id
   * @param {(slot: { resolve: Function, reject: Function, timer: any, method: string }) => void} action
   */
  #settle(id, action) {
    const slot = this.#pending.get(id);
    if (!slot) return;
    this.#pending.delete(id);
    if (slot.timer) clearTimeout(slot.timer);
    action(slot);
  }

  /** @param {Error} err */
  #rejectAll(err) {
    for (const [id, slot] of [...this.#pending]) {
      this.#pending.delete(id);
      if (slot.timer) clearTimeout(slot.timer);
      slot.reject(err);
    }
  }

  /** @returns {string} */
  #nextId() { return `${this.#sessionId}#${++this.#seq}`; }

  // ---- 内部：心跳与状态 ----

  #startHeartbeat() {
    const interval = Number(this.#timeouts.HEARTBEAT);
    if (!Number.isFinite(interval) || interval <= 0) return;

    this.#heartbeatTimer = setInterval(() => {
      if (!this.ready) return;

      // 心跳必须用 PING 帧（对端以 PONG + 同 id 应答）而不是 `request`，
      // 否则方法的语义就与「帧类型」这套约定脱节了。
      const id = this.#nextId();
      const limit = Number(this.#timeouts.REQUEST);
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        // UDS 的「半开连接」不会自己报错，只能靠探活发现，故超时即判定链路已死
        this.#log.warn?.('[joyous/bridge] 心跳未获应答，判定链路已失效');
        this.#teardown('心跳超时');
      }, limit > 0 ? limit : DEFAULT_TIMEOUTS.REQUEST);
      timer.unref?.();

      this.#pending.set(id, { resolve: () => { }, reject: () => { }, timer, method: FRAME_TYPES.PING });
      if (!this.#send({ v: PROTOCOL_VERSION, type: FRAME_TYPES.PING, id, ts: Date.now() })) {
        clearTimeout(timer);
        this.#pending.delete(id);
      }
    }, interval);
    this.#heartbeatTimer.unref?.();
  }

  #cleanupHandshakeTimer() {
    if (this.#handshakeTimer) { clearTimeout(this.#handshakeTimer); this.#handshakeTimer = null; }
  }

  #cleanupTimers() {
    this.#cleanupHandshakeTimer();
    if (this.#heartbeatTimer) { clearInterval(this.#heartbeatTimer); this.#heartbeatTimer = null; }
  }

  /**
   * @param {string} next
   */
  #setState(next) {
    if (this.#state === next) return;
    const previous = this.#state;
    this.#state = next;
    this.#emit('state', next, previous);
  }

  /**
   * @param {BridgeEvent} event
   * @param {...*} args
   */
  #emit(event, ...args) {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(...args);
      } catch (e) {
        this.#log.error?.(`[joyous/bridge] 事件 ${event} 的监听器抛出异常：${e?.message ?? e}`);
      }
    }
  }
}

/**
 * 构造本端的握手帧。
 * @param {string} type {@link FRAME_TYPES.HELLO} 或 {@link FRAME_TYPES.WELCOME}
 * @param {{ name: string, version: string, capabilities: string[] }} self
 * @param {string} sessionId
 * @returns {object}
 */
function selfFrame(type, self, sessionId) {
  return {
    v: PROTOCOL_VERSION,
    protocol: PROTOCOL_NAME,
    type,
    id: null,
    ts: Date.now(),
    role: CHANNEL_ROLES.NEONAI,
    name: self.name,
    version: self.version,
    capabilities: [...self.capabilities],
    session: sessionId,
  };
}

/**
 * 校验对端握手帧的身份声明。
 * @param {object} frame
 * @returns {string|null} 不匹配的原因；匹配返回 null
 */
function checkPeerIdentity(frame) {
  if (frame.protocol !== PROTOCOL_NAME) {
    return `协议名不匹配（对端为 ${String(frame.protocol)}，本端要求 ${PROTOCOL_NAME}）`;
  }
  if (Number(frame.v) !== PROTOCOL_VERSION) {
    return `协议主版本不匹配（对端为 ${String(frame.v)}，本端为 ${PROTOCOL_VERSION}）`;
  }
  if (frame.role !== CHANNEL_ROLES.JOYOUS) {
    return `对端角色不是 ${CHANNEL_ROLES.JOYOUS}（对端自称 ${String(frame.role)}）`;
  }
  return null;
}
