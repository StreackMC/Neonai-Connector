import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

import { neonaicPermissionServer } from '#src/command/permissionServer.js';
import { getLogger } from '#src/logger/Logger.js';
import { NeonaicIllegalStateError } from '#src/utils/NeonaicNewableError.js';

import { aicodeBridge } from './aicode_bridge.js';

/** 带 HTTP 状态码的错误，供 handler 统一转成响应。 */
class HttpError extends Error {
  /**
   * @param {number} statusCode
   * @param {string} message
   */
  constructor(statusCode, message) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

/** @type {import('node:http').Server|null} */
let server = null;
/** @type {ReturnType<typeof import('./config.js').hackerConsoleConfig.load>|null} */
let config = null;
/** @type {{ host: string, port: number, url: string }|null} */
let listening = null;
/** 页面只读一次；HTML 是拓展自带资源，不需要热更新 */
let pageCache = '';
/** 所有活动连接，用于关闭时强制断开 keep-alive @type {Set<import('node:net').Socket>} */
const sockets = new Set();
/** 是否由本拓展亲自授出过权限（关闭时只回收自己授出的那份） */
let grantedPermission = false;

/**
 * 执行一段代码：先按原样送进 aicode；被权限拦下且开启了 `autoGrant` 时授一次权再重试。
 *
 * @param {string} code
 * @returns {Promise<Awaited<ReturnType<typeof aicodeBridge.run>>>}
 */
async function execute(code) {
  const cfg = config;
  if (!cfg) throw new NeonaicIllegalStateError('HackerConsole 尚未启动');

  let result = await aicodeBridge.run(code, { executor: cfg.executor });

  if (result.ok || result.code !== 'permission_denied') return result;
  if (!cfg.autoGrant || !cfg.permission) return result;

  const status = neonaicPermissionServer.setPermission(cfg.executor, cfg.permission, true);
  if (status !== 'successfully') return result;

  grantedPermission = true;
  getLogger().ext.warn(
    `[hacker-console] 测试需要，已给 ${cfg.executor} 授予 ${cfg.permission}（拓展关闭时自动回收）`,
  );
  result = await aicodeBridge.run(code, { executor: cfg.executor });
  return result;
}

/**
 * 回收本拓展授出的权限。
 */
function releasePermission() {
  if (!grantedPermission || !config?.permission) return;
  grantedPermission = false;
  neonaicPermissionServer.clearPermission(config.executor, config.permission);
}

/**
 * 读请求体，超过上限就抛 413。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<string>}
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let settled = false;

    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        // 继续把剩余数据读掉，否则响应发不出去（连接会直接断）
        req.resume();
        reject(new HttpError(413, `请求体超过上限 ${limit} 字节`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {object} payload
 */
function sendJson(res, status, payload) {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {string} text
 */
function sendText(res, status, text) {
  if (res.headersSent) return;
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

/**
 * token 校验。未配置 token 时直接放行。
 *
 * @param {URL} url
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
function checkToken(url, req) {
  const expected = config?.token ?? '';
  if (!expected) return true;
  const given = url.searchParams.get('token') ?? req.headers['x-hackerconsole-token'] ?? '';
  return given === expected;
}

/**
 * 页面 HTML（拓展自带，读一次缓存）。
 *
 * @returns {string}
 */
function page() {
  if (!pageCache) pageCache = readFileSync(new URL('./page.html', import.meta.url), 'utf8');
  return pageCache;
}

/**
 * 请求分发。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (!checkToken(url, req)) {
    sendText(res, 401, 'HackerConsole: 无效的 token');
    return;
  }

  const method = req.method ?? 'GET';

  if ((method === 'GET' || method === 'HEAD') && (url.pathname === '/' || url.pathname === '/index.html')) {
    const html = page();
    if (res.headersSent) return;
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
      'cache-control': 'no-store',
    });
    res.end(method === 'HEAD' ? undefined : html);
    return;
  }

  if (method === 'GET' && url.pathname === '/api/status') {
    sendJson(res, 200, {
      ok: true,
      executor: config?.executor ?? null,
      permission: config?.permission ?? '',
      granted: grantedPermission,
      aicode: aicodeBridge.isAvailable(),
      tool: aicodeBridge.TOOL_FQN,
    });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/exec') {
    const raw = await readBody(req, config?.maxBodyBytes ?? 1048576);

    /** @type {any} */
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new HttpError(400, '请求体不是合法 JSON');
    }

    const code = typeof payload?.code === 'string' ? payload.code : '';
    if (!code.trim()) throw new HttpError(400, '代码为空');

    const started = Date.now();
    const result = await execute(code);
    const { stdout, stderr } = aicodeBridge.format(result);

    sendJson(res, 200, {
      ok: result.ok,
      code: result.code ?? null,
      message: result.message ?? null,
      stdout,
      stderr,
      durationMs: result.durationMs,
      wallMs: Date.now() - started,
    });
    return;
  }

  sendJson(res, 404, { ok: false, code: 'not_found', message: `没有这个路径：${url.pathname}` });
}

/**
 * 启动 HTTP 服务。
 *
 * @param {ReturnType<typeof import('./config.js').hackerConsoleConfig.load>} cfg
 * @returns {Promise<{ host: string, port: number, url: string }>}
 */
function start(cfg) {
  if (server) throw new NeonaicIllegalStateError('HackerConsole 服务器已在运行');
  config = cfg;

  const created = createServer((req, res) => {
    handle(req, res).catch((error) => {
      const status = error instanceof HttpError ? error.statusCode : 500;
      if (status === 500) getLogger().ext.error(`[hacker-console] 请求处理异常：${error?.stack ?? error}`);
      if (res.headersSent) return;
      sendJson(res, status, {
        ok: false,
        code: status === 500 ? 'internal_error' : 'bad_request',
        message: String(error?.message ?? error),
        stdout: '',
        stderr: String(error?.message ?? error),
        durationMs: 0,
        wallMs: 0,
      });
    });
  });

  created.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  // 客户端半途断开（curl -m 之类）不该把日志刷满，直接掐掉
  created.on('clientError', (_error, socket) => { socket.destroy(); });

  server = created;

  return new Promise((resolve, reject) => {
    /** @param {Error} error */
    const onListenError = (error) => {
      server = null;
      config = null;
      reject(error);
    };
    created.once('error', onListenError);
    created.listen(cfg.port, cfg.host, () => {
      created.off('error', onListenError);
      created.on('error', (error) => getLogger().ext.error(`[hacker-console] 服务器错误：${error?.message ?? error}`));
      const address = created.address();
      const port = typeof address === 'object' && address ? address.port : cfg.port;
      const host = cfg.host === '0.0.0.0' || cfg.host === '::' ? '127.0.0.1' : cfg.host;
      listening = { host: cfg.host, port, url: `http://${host}:${port}/` };
      resolve({ ...listening });
    });
  });
}

/**
 * 停止 HTTP 服务。幂等：没在跑时直接返回。
 */
async function stop() {
  const current = server;
  server = null;
  listening = null;

  if (current) {
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; resolve(); };
      current.close(() => finish());
      // keep-alive 连接不会自己断，close() 的回调要等它们全部结束
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      // 兜底：极端情况下 close 回调不触发，也不能把关闭流程卡死
      setTimeout(finish, 1000).unref?.();
    });
  }

  releasePermission();
  config = null;
  pageCache = '';
}

/** 服务是否在运行 */
function isRunning() { return server !== null; }

/** 当前监听信息（副本） */
function getListening() { return listening ? { ...listening } : null; }

export const hackerConsoleServer = Object.freeze({
  HttpError,
  start,
  stop,
  isRunning,
  getListening,
  releasePermission,
});
