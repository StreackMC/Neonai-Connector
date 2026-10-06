/**
 * src/config.js — 拓展配置读取与端点解析
 *
 * 配置来源：`extensions/joyous/config.json`（JSON5，允许注释与尾逗号），
 * 通过内核的 {@link neonaicConfManager.getConfig} 读取，因此 `/neonaic:reload` 会让
 * 下一次 `load()` 拿到新值（已启动的通道不会热切换，重启拓展即可生效）。
 *
 * 本模块只做「读值 + 校验 + 归一化」，不创建任何连接，也不写文件。
 */

import { neonaicConfManager } from '../../../src/system/confManager.js';
import {
  HANDSHAKE_MODES,
  DEFAULT_TIMEOUTS,
} from './protocol/constants.js';
import {
  DEFAULT_PIPE_NAME,
  DEFAULT_UDS_PATH,
} from './protocol/uds.js';

/** 配置文件路径（相对项目根） */
const CONFIG_PATH = 'extensions/joyous/config.json';

/** 状态查询的传输选择 */
const STATUS_TRANSPORTS = Object.freeze(['auto', 'http', 'uds']);

/** 缺省值：配置文件缺失或字段缺省时使用 */
const DEFAULTS = Object.freeze({
  status: Object.freeze({
    transport: 'auto',
    address: 'http://localhost:8080/japi/status',
    serverName: '栈流Streack',
    timeoutMs: 5000,
    maxPlayerListed: 3,
  }),
  httpServer: Object.freeze({
    enabled: false,
    host: '127.0.0.1',
    port: 8081,
    path: '/neonai/command',
    healthPath: '/neonai/health',
    token: '',
  }),
  uds: Object.freeze({
    enabled: false,
    path: DEFAULT_UDS_PATH,
    pipe: DEFAULT_PIPE_NAME,
    handshake: HANDSHAKE_MODES.RESPONDER,
    connectTimeoutMs: DEFAULT_TIMEOUTS.CONNECT,
    handshakeTimeoutMs: DEFAULT_TIMEOUTS.HANDSHAKE,
    requestTimeoutMs: DEFAULT_TIMEOUTS.REQUEST,
    heartbeatMs: DEFAULT_TIMEOUTS.HEARTBEAT,
    reconnect: Object.freeze({
      enabled: true,
      initialDelayMs: 1000,
      maxDelayMs: 30000,
      factor: 2,
      jitterRatio: 0.2,
    }),
  }),
  dispatch: Object.freeze({
    commandTimeoutMs: DEFAULT_TIMEOUTS.COMMAND,
  }),
});

/**
 * 读取并归一化拓展配置。
 * @returns {{ status: object, httpServer: object, uds: object, dispatch: object, issues: string[] }}
 *   `issues` 为「可容忍的问题」清单（缺省、取值不合法而被回退等），供调用方记日志；
 *   存在 issues 不代表加载失败，通道仍会用回退后的值启动。
 */
function load() {
  const conf = neonaicConfManager.getConfig(CONFIG_PATH);
  /** @type {string[]} */
  const issues = [];

  const status = {
    transport: pickEnum(conf.getString('status.transport', DEFAULTS.status.transport), STATUS_TRANSPORTS, 'status.transport', issues),
    address: pickText(conf.getString('status.address', DEFAULTS.status.address), 'status.address', issues),
    serverName: pickText(conf.getString('status.serverName', DEFAULTS.status.serverName), 'status.serverName', issues),
    timeoutMs: pickPositiveInt(conf.getInt('status.timeoutMs', DEFAULTS.status.timeoutMs), DEFAULTS.status.timeoutMs, 'status.timeoutMs', issues),
    maxPlayerListed: Math.max(1, pickPositiveInt(conf.getInt('status.maxPlayerListed', DEFAULTS.status.maxPlayerListed), DEFAULTS.status.maxPlayerListed, 'status.maxPlayerListed', issues)),
  };

  const httpServer = {
    enabled: conf.getBoolean('httpServer.enabled', DEFAULTS.httpServer.enabled),
    host: pickText(conf.getString('httpServer.host', DEFAULTS.httpServer.host), 'httpServer.host', issues),
    port: pickPort(conf.getInt('httpServer.port', DEFAULTS.httpServer.port), 'httpServer.port', issues),
    path: pickPath(conf.getString('httpServer.path', DEFAULTS.httpServer.path), 'httpServer.path', issues),
    healthPath: pickPath(conf.getString('httpServer.healthPath', DEFAULTS.httpServer.healthPath), 'httpServer.healthPath', issues),
    token: String(conf.getString('httpServer.token', DEFAULTS.httpServer.token) ?? ''),
  };

  const uds = {
    enabled: conf.getBoolean('uds.enabled', DEFAULTS.uds.enabled),
    path: pickText(conf.getString('uds.path', DEFAULTS.uds.path), 'uds.path', issues),
    pipe: String(conf.getString('uds.pipe', DEFAULTS.uds.pipe) ?? ''),
    handshake: pickEnum(
      conf.getString('uds.handshake', DEFAULTS.uds.handshake),
      Object.values(HANDSHAKE_MODES),
      'uds.handshake',
      issues,
    ),
    connectTimeoutMs: pickPositiveInt(conf.getInt('uds.connectTimeoutMs', DEFAULTS.uds.connectTimeoutMs), DEFAULTS.uds.connectTimeoutMs, 'uds.connectTimeoutMs', issues),
    handshakeTimeoutMs: pickPositiveInt(conf.getInt('uds.handshakeTimeoutMs', DEFAULTS.uds.handshakeTimeoutMs), DEFAULTS.uds.handshakeTimeoutMs, 'uds.handshakeTimeoutMs', issues),
    requestTimeoutMs: pickPositiveInt(conf.getInt('uds.requestTimeoutMs', DEFAULTS.uds.requestTimeoutMs), DEFAULTS.uds.requestTimeoutMs, 'uds.requestTimeoutMs', issues),
    heartbeatMs: pickNonNegativeInt(conf.getInt('uds.heartbeatMs', DEFAULTS.uds.heartbeatMs), DEFAULTS.uds.heartbeatMs, 'uds.heartbeatMs', issues),
    reconnect: {
      enabled: conf.getBoolean('uds.reconnect.enabled', DEFAULTS.uds.reconnect.enabled),
      initialDelayMs: pickPositiveInt(conf.getInt('uds.reconnect.initialDelayMs', DEFAULTS.uds.reconnect.initialDelayMs), DEFAULTS.uds.reconnect.initialDelayMs, 'uds.reconnect.initialDelayMs', issues),
      maxDelayMs: pickPositiveInt(conf.getInt('uds.reconnect.maxDelayMs', DEFAULTS.uds.reconnect.maxDelayMs), DEFAULTS.uds.reconnect.maxDelayMs, 'uds.reconnect.maxDelayMs', issues),
      factor: pickAtLeast(conf.getDouble('uds.reconnect.factor', DEFAULTS.uds.reconnect.factor), 1, DEFAULTS.uds.reconnect.factor, 'uds.reconnect.factor', issues),
      jitterRatio: pickRatio(conf.getDouble('uds.reconnect.jitterRatio', DEFAULTS.uds.reconnect.jitterRatio), DEFAULTS.uds.reconnect.jitterRatio, 'uds.reconnect.jitterRatio', issues),
    },
  };

  const dispatch = {
    commandTimeoutMs: pickPositiveInt(conf.getInt('dispatch.commandTimeoutMs', DEFAULTS.dispatch.commandTimeoutMs), DEFAULTS.dispatch.commandTimeoutMs, 'dispatch.commandTimeoutMs', issues),
  };

  return { status, httpServer, uds, dispatch, issues };
}

// ---- 归一化小工具（不变量在读取处一次说清，避免散落到使用处）----

/**
 * @param {string} value
 * @param {string[]} allowed
 * @param {string} label
 * @param {string[]} issues
 * @returns {string}
 */
function pickEnum(value, allowed, label, issues) {
  const v = String(value ?? '');
  if (allowed.includes(v)) return v;
  issues.push(`${label} 取值 “${v}” 不合法，已回退为 “${allowed[0]}”（可选：${allowed.join(' / ')}）`);
  return allowed[0];
}

/**
 * @param {string} value
 * @param {string} label
 * @param {string[]} issues
 * @returns {string}
 */
function pickText(value, label, issues) {
  const v = String(value ?? '').trim();
  if (v) return v;
  issues.push(`${label} 为空，已回退为该字段的缺省值`);
  return String(value ?? '');
}

/**
 * @param {number} value
 * @param {number} fallback
 * @param {string} label
 * @param {string[]} issues
 * @returns {number}
 */
function pickPositiveInt(value, fallback, label, issues) {
  if (Number.isInteger(value) && value > 0) return value;
  issues.push(`${label} 不是正整数（${value}），已回退为 ${fallback}`);
  return fallback;
}

/**
 * @param {number} value
 * @param {number} fallback
 * @param {string} label
 * @param {string[]} issues
 * @returns {number}
 */
function pickNonNegativeInt(value, fallback, label, issues) {
  if (Number.isInteger(value) && value >= 0) return value;
  issues.push(`${label} 不是非负整数（${value}），已回退为 ${fallback}`);
  return fallback;
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} fallback
 * @param {string} label
 * @param {string[]} issues
 * @returns {number}
 */
function pickAtLeast(value, min, fallback, label, issues) {
  if (Number.isFinite(value) && value >= min) return value;
  issues.push(`${label} 不应小于 ${min}（${value}），已回退为 ${fallback}`);
  return fallback;
}

/**
 * @param {number} value
 * @param {number} fallback
 * @param {string} label
 * @param {string[]} issues
 * @returns {number}
 */
function pickRatio(value, fallback, label, issues) {
  if (Number.isFinite(value) && value >= 0 && value <= 0.5) return value;
  issues.push(`${label} 应在 0 ~ 0.5 之间（${value}），已回退为 ${fallback}`);
  return fallback;
}

/**
 * @param {number} value
 * @param {string} label
 * @param {string[]} issues
 * @returns {number}
 */
function pickPort(value, label, issues) {
  if (Number.isInteger(value) && value >= 0 && value <= 65535) return value;
  issues.push(`${label} 不是合法端口（${value}），已回退为 ${DEFAULTS.httpServer.port}`);
  return DEFAULTS.httpServer.port;
}

/**
 * @param {string} value
 * @param {string} label
 * @param {string[]} issues
 * @returns {string}
 */
function pickPath(value, label, issues) {
  const v = String(value ?? '').trim();
  if (v.startsWith('/') && v.length > 1) return v;
  issues.push(`${label} 必须以 / 开头（${v}），已回退为缺省值`);
  return label === 'httpServer.healthPath' ? DEFAULTS.httpServer.healthPath : DEFAULTS.httpServer.path;
}

export const joyousConfig = Object.freeze({
  CONFIG_PATH,
  DEFAULTS,
  STATUS_TRANSPORTS,
  load,
});
