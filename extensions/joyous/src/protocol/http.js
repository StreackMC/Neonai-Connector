/**
 * protocol/http.js — HTTP 通道
 *
 * HTTP 模式下 Neonaic **同时是客户端与服务端**：
 *
 *   出（Neonaic → JoyousPlugin）：`NeonaicJoyousHttpClient`
 *     以 HTTP 客户端身份 GET JoyousPlugin 的 StatusAPI（`/japi/status`），
 *     把服务器状态取回来供命令与 AI 工具使用。
 *
 *   入（JoyousPlugin → Neonaic）：`NeonaicJoyousHttpServer`
 *     以 HTTP 服务端身份接收 JoyousPlugin 的「执行命令」请求，
 *     交给注入的 handler（默认 {@link joyousDispatcher.execute}）处理后回传结果。
 *
 * 关键设计：本模块**不认识命令系统**。它只知道「一个 handler 接收请求对象、返回
 * `{ output }` 或抛带 `code` 的错误」这条契约，具体怎么执行命令是 dispatch 的事。
 * 这就是「通信层与命令系统分离」的落点。
 */

import { createServer } from 'node:http';
import { NeonaicNewable } from '../../../../src/utils/NeonaicNewableClass.js';
import {
  NeonaicIllegalArgumentError,
  NeonaicIllegalStateError,
  NeonaicProtocolError,
} from '../../../../src/utils/NeonaicNewableError.js';
import { neonaicNetwork } from '../../../../src/utils/io.js';
import {
  DEFAULT_TIMEOUTS,
  ERROR_CODES,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
} from './constants.js';

/** 单次请求体上限（256 KiB），避免被撑爆内存 */
export const MAX_BODY_BYTES = 256 * 1024;

/** 默认可接受的令牌请求头 */
const TOKEN_HEADERS = Object.freeze(['x-neonai-token', 'x-joyous-token']);

/** 空日志器 */
const NULL_LOG = Object.freeze({ debug() { }, info() { }, warn() { }, error() { } });

// =====================================================================
// 出方向：StatusAPI 客户端
// =====================================================================

/**
 * StatusAPI 查询结果。
 * @typedef {{ ok: true, data: object } | { ok: false, reason: 'offline'|'invalid'|string }} StatusResult
 */

/**
 * JoyousPlugin StatusAPI 的 HTTP 客户端。
 * @apiNote 刻意**不抛错**：网络失败在本场景下是常态（服没开），
 *          以判别式返回值表达比到处 try/catch 更好用。
 */
export class NeonaicJoyousHttpClient extends NeonaicNewable {
  static type = 'joyous.http.client';

  /** @type {number} */
  #timeoutMs;
  /** @type {(target: string, timeout: number) => Promise<Response>} */
  #fetchImpl;
  /** @type {ReturnType<typeof Object.freeze>} */
  #log;

  /**
   * @param {object} [options]
   * @param {number} [options.timeoutMs=5000] 单次请求超时
   * @param {Function} [options.fetchImpl] 自定义 fetch（测试用），默认走内核 neonaicNetwork.fetch
   * @param {object} [options.log] 日志器
   */
  constructor(options = {}) {
    super();
    const { timeoutMs = DEFAULT_TIMEOUTS.CONNECT, fetchImpl, log } = options;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new NeonaicIllegalArgumentError(`HTTP 客户端超时配置不合法：${timeoutMs}`);
    }
    this.#timeoutMs = timeoutMs;
    this.#fetchImpl = typeof fetchImpl === 'function'
      ? fetchImpl
      : (target, timeout) => neonaicNetwork.fetch(target, timeout);
    this.#log = log ?? NULL_LOG;
  }

  /** @returns {number} */
  get timeoutMs() { return this.#timeoutMs; }

  /**
   * 拉取并解析 StatusAPI 数据。
   * @param {string} [address] 数据来源地址
   * @returns {Promise<StatusResult>}
   */
  async fetchStatus(address) {
    if (typeof address !== 'string' || !address.trim()) {
      throw new NeonaicIllegalArgumentError('查询状态时必须提供地址');
    }
    try {
      const res = await this.#fetchImpl(address, this.#timeoutMs);
      if (!res.ok) {
        this.#log.warn?.(`[joyous/http] 状态接口返回非 2xx：${res.status}`);
        return { ok: false, reason: 'offline' };
      }

      const text = await res.text();
      if (!text.trim()) return { ok: false, reason: 'offline' };

      try {
        const data = JSON.parse(text);
        // 数组也是合法 JSON，但不是合法的状态体，必须与「结构不符」同等对待
        if (data === null || typeof data !== 'object' || Array.isArray(data)) {
          return { ok: false, reason: 'invalid' };
        }
        return { ok: true, data };
      } catch {
        return { ok: false, reason: 'invalid' };
      }
    } catch (err) {
      // 网络错误 / 超时 / DNS 失败等：把消息交给上层渲染
      this.#log.warn?.(`[joyous/http] 查询服务器状态失败：${err?.message ?? err}`);
      return { ok: false, reason: err?.message ?? String(err) };
    }
  }
}

// =====================================================================
// 入方向：命令请求服务端
// =====================================================================

/**
 * 命令处理器契约：接收请求对象，返回 `{ output, ... }` 或抛带 `code` 的错误。
 * @callback CommandHandler
 * @param {object} request 已解析的请求体
 * @returns {Promise<{ output?: string } & object>}
 */

/**
 * 接收 JoyousPlugin 命令请求的 HTTP 服务端。
 */
export class NeonaicJoyousHttpServer extends NeonaicNewable {
  static type = 'joyous.http.server';

  /** @type {import('node:http').Server|null} */
  #server = null;
  /** @type {object} */
  #config;
  /** @type {CommandHandler} */
  #handler;
  /** @type {ReturnType<typeof Object.freeze>} */
  #log;

  /**
   * @param {object} options
   * @param {CommandHandler} options.handler 命令处理器（通信层与命令系统的接缝）
   * @param {string} [options.host='127.0.0.1'] 监听地址
   * @param {number} [options.port=8081] 监听端口，0 表示由系统分配
   * @param {string} [options.path='/neonai/command'] 命令端点路径
   * @param {string} [options.healthPath='/neonai/health'] 健康检查路径
   * @param {string} [options.token=''] 共享令牌；为空时仅允许非回环地址以外的场景拒绝启动
   * @param {string} [options.selfName='neonai'] 健康检查里申报的名称
   * @param {string} [options.selfVersion='0.0.0'] 健康检查里申报的版本
   * @param {number} [options.maxBodyBytes=MAX_BODY_BYTES] 请求体上限
   * @param {object} [options.log] 日志器
   */
  constructor(options = {}) {
    super();
    const {
      handler, host = '127.0.0.1', port = 8081,
      path = '/neonai/command', healthPath = '/neonai/health',
      token = '', selfName = 'neonai', selfVersion = '0.0.0',
      maxBodyBytes = MAX_BODY_BYTES, log,
    } = options;

    if (typeof handler !== 'function') {
      throw new NeonaicIllegalArgumentError('HTTP 服务端必须提供命令处理器');
    }
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new NeonaicIllegalArgumentError(`HTTP 服务端端口不合法：${port}`);
    }
    for (const [label, value] of [['path', path], ['healthPath', healthPath]]) {
      if (typeof value !== 'string' || !value.startsWith('/')) {
        throw new NeonaicIllegalArgumentError(`HTTP 服务端的 ${label} 必须以 / 开头：${value}`);
      }
    }

    this.#handler = handler;
    this.#log = log ?? NULL_LOG;
    this.#config = {
      host, port, path, healthPath,
      token: String(token ?? ''),
      selfName: String(selfName),
      selfVersion: String(selfVersion),
      maxBodyBytes,
    };

    // 安全兜底：对外监听却没有令牌 == 把命令执行权开放给整个网段
    if (!this.#config.token && !isLoopbackHost(host)) {
      throw new NeonaicIllegalArgumentError(
        `监听地址 ${host} 不是回环地址，但未配置访问令牌；拒绝以「任何人都能执行命令」的姿态启动`,
      );
    }
    if (!this.#config.token) {
      this.#log.warn?.(
        `[joyous/http] 未配置访问令牌：${host}:${port} 上任何本机进程都能请求执行命令。` +
        '生产环境请在拓展配置中设置 http.server.token 。',
      );
    }
  }

  /** 是否正在监听 @returns {boolean} */
  get running() { return this.#server !== null; }

  /** 实际监听地址 `{ host, port }`；未启动时为 null @returns {{host: string, port: number}|null} */
  get address() {
    const addr = this.#server?.address();
    if (!addr || typeof addr === 'string') return null;
    return { host: addr.address, port: addr.port };
  }

  /** 命令端点路径 @returns {string} */
  get commandPath() { return this.#config.path; }

  /**
   * 开始监听。
   * @returns {Promise<{host: string, port: number}>} 实际监听地址
   * @throws {NeonaicIllegalStateError} 已在运行
   */
  start() {
    if (this.#server) throw new NeonaicIllegalStateError('HTTP 服务端已在运行');

    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.#route(req, res).catch((e) => {
          this.#log.error?.(`[joyous/http] 处理请求时出现未捕获异常：${e?.message ?? e}`);
          if (!res.headersSent) sendJson(res, 500, { ok: false, code: ERROR_CODES.INTERNAL_ERROR, message: '服务端内部错误' });
          else res.destroy();
        });
      });

      server.on('error', (e) => {
        this.#server = null;
        reject(e);
      });
      server.on('clientError', (e, socket) => {
        this.#log.warn?.(`[joyous/http] 客户端连接异常：${e?.message ?? e}`);
        socket.destroy();
      });

      server.listen(this.#config.port, this.#config.host, () => {
        this.#server = server;
        const addr = this.address;
        this.#log.info?.(
          `[joyous/http] 命令端点已监听 http://${addr.host}:${addr.port}${this.#config.path}` +
          `${this.#config.token ? '（已启用令牌校验）' : ''}`,
        );
        resolve(addr);
      });
    });
  }

  /**
   * 停止监听（含强制断开 keep-alive 连接）。
   * @returns {Promise<void>}
   */
  stop() {
    const server = this.#server;
    if (!server) return Promise.resolve();
    this.#server = null;

    return new Promise((resolve) => {
      // 先断开空闲连接，否则 close() 会一直等到 keep-alive 超时
      server.closeIdleConnections?.();
      server.close(() => {
        server.closeAllConnections?.();
        this.#log.info?.('[joyous/http] 命令端点已停止监听');
        resolve();
      });
      // 兜底：1s 后无论是否还有连接都强行收尾
      const timer = setTimeout(() => {
        server.closeAllConnections?.();
        resolve();
      }, 1000);
      timer.unref?.();
    });
  }

  // ---- 路由 ----

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async #route(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    if (path === this.#config.healthPath) {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, code: ERROR_CODES.INVALID_ARGUMENT, message: '健康检查仅支持 GET' });
      return sendJson(res, 200, {
        ok: true,
        protocol: PROTOCOL_NAME,
        v: PROTOCOL_VERSION,
        role: 'neonai',
        name: this.#config.selfName,
        version: this.#config.selfVersion,
        ts: Date.now(),
      });
    }

    if (path !== this.#config.path) {
      return sendJson(res, 404, { ok: false, code: 'not_found', message: `未知端点：${path}` });
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return sendJson(res, 405, { ok: false, code: ERROR_CODES.INVALID_ARGUMENT, message: '命令端点仅支持 POST' });
    }

    if (!this.#authorized(req)) {
      this.#log.warn?.(`[joyous/http] 拒绝了一次未通过令牌校验的命令请求（来源 ${req.socket.remoteAddress}）`);
      return sendJson(res, 401, { ok: false, code: 'unauthorized', message: '令牌校验未通过' });
    }

    let raw;
    try {
      raw = await readBody(req, this.#config.maxBodyBytes);
    } catch (e) {
      const tooLarge = e instanceof NeonaicProtocolError && e.code === ERROR_CODES.FRAME_TOO_LARGE;
      return sendJson(res, tooLarge ? 413 : 400, {
        ok: false,
        code: tooLarge ? ERROR_CODES.FRAME_TOO_LARGE : ERROR_CODES.BAD_FRAME,
        message: e?.message ?? String(e),
      });
    }

    let request;
    try {
      request = JSON.parse(raw);
      if (request === null || typeof request !== 'object' || Array.isArray(request)) {
        return sendJson(res, 400, { ok: false, code: ERROR_CODES.BAD_FRAME, message: '请求体必须是 JSON 对象' });
      }
    } catch (e) {
      return sendJson(res, 400, { ok: false, code: ERROR_CODES.BAD_FRAME, message: `请求体不是合法 JSON：${e?.message ?? e}` });
    }

    // 到这里才进入业务：错误码由 handler 决定，HTTP 状态码只作辅助
    try {
      const result = await this.#handler(request);
      return sendJson(res, 200, { ok: true, id: request.id ?? null, ...result });
    } catch (e) {
      const code = (typeof e?.code === 'string' && e.code) ? e.code : ERROR_CODES.INTERNAL_ERROR;
      this.#log.debug?.(`[joyous/http] 命令请求被拒绝（${code}）：${e?.message ?? e}`);
      return sendJson(res, httpStatusFor(code), {
        ok: false,
        id: request.id ?? null,
        code,
        message: e?.message ?? String(e),
      });
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @returns {boolean}
   */
  #authorized(req) {
    const expected = this.#config.token;
    if (!expected) return true;

    const candidates = TOKEN_HEADERS.map((h) => req.headers[h]).filter(Boolean);
    const auth = req.headers.authorization;
    if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) {
      candidates.push(auth.replace(/^Bearer\s+/i, ''));
    }
    return candidates.some((value) => timingSafeEqualish(String(value), expected));
  }
}

// ---- 工具 ----

/**
 * 长度无关的常量时间比较，避免令牌校验被计时侧信道探测。
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqualish(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 是否回环地址（用于判断「无令牌监听」是否可以接受）。
 * @param {string} host
 * @returns {boolean}
 */
function isLoopbackHost(host) {
  const h = String(host).toLowerCase();
  return h === '127.0.0.1' || h === '::1' || h === 'localhost' || h.startsWith('127.');
}

/**
 * 读取请求体，带大小上限。
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<string>}
 * @throws {NeonaicProtocolError}
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;

    const abortWith = (err) => {
      if (done) return;
      done = true;
      reject(err);
    };

    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        const err = new NeonaicProtocolError(`请求体超过上限（> ${limit} 字节）`);
        err.code = ERROR_CODES.FRAME_TOO_LARGE;
        abortWith(err);
        // 只排空、不 destroy：直接 destroy 会让 413 响应没机会发出去，
        // 客户端只会看到连接被重置，反而看不出「请求体太大」这个真实原因。
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (e) => abortWith(e));
  });
}

/**
 * 写出 JSON 响应。
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {object} body
 */
function sendJson(res, status, body) {
  let text;
  try {
    text = JSON.stringify(body);
  } catch {
    text = JSON.stringify({ ok: false, code: ERROR_CODES.INTERNAL_ERROR, message: '响应无法序列化' });
    status = 500;
  }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Neonai-Protocol': `${PROTOCOL_NAME}/${PROTOCOL_VERSION}`,
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

/**
 * 协议错误码 → HTTP 状态码。仅作辅助：客户端应以响应体里的 `code` 为准。
 * @param {string} code
 * @returns {number}
 */
function httpStatusFor(code) {
  switch (code) {
    case ERROR_CODES.INVALID_ARGUMENT:
    case ERROR_CODES.BAD_FRAME:
      return 400;
    case ERROR_CODES.PERMISSION_DENIED:
      return 403;
    case ERROR_CODES.UNKNOWN_COMMAND:
      return 404;
    case ERROR_CODES.UNKNOWN_METHOD:
      return 501;
    case ERROR_CODES.TIMEOUT:
      return 504;
    case ERROR_CODES.COMMAND_FAILED:
    case ERROR_CODES.INTERNAL_ERROR:
    default:
      return 500;
  }
}
