/**
 * src/config.js — 拓展配置读取与端点解析
 *
 * 配置来源：`extensions/joyous/config.json`（JSON5，允许注释与尾逗号），
 * 通过内核的 {@link neonaicConfManager.getConfig} 读取，因此 `/neonaic:reload` 会让
 * 下一次 `load()` 拿到新值（已启动的通道不会热切换，重启拓展即可生效）。
 *
 * 本模块只做「读值 + 校验 + 归一化」，不创建任何连接，也不写文件。
 *
 * 段落：
 *   `status`     状态查询的目标与传输
 *   `httpServer` 本端 HTTP 服务端（命令端点 + V2 通用调用端点）与出站端点地址
 *   `uds`        UDS 链路参数
 *   `dispatch`   命令执行的兜底超时
 *   `bridge`     V2 业务层：出站传输、profile↔频道映射、业务方法白名单、限流等
 */

import { neonaicConfManager } from '../../../src/system/confManager.js';
import {
  BUSINESS_METHODS,
  HANDSHAKE_MODES,
  DEFAULT_TIMEOUTS,
  TRANSPORTS,
} from './protocol/constants.js';
import {
  DEFAULT_PIPE_NAME,
  DEFAULT_UDS_PATH,
} from './protocol/uds.js';

/** 配置文件路径（相对项目根） */
const CONFIG_PATH = 'extensions/joyous/config.json';

/** 状态查询的传输选择（与 `bridge.transport` 同源） */
const STATUS_TRANSPORTS = TRANSPORTS;

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
    invokePath: '/neonai/invoke',
    healthPath: '/neonai/health',
    token: '',
    // Joyous 侧 HTTP 服务端上的通用端点（用于 Neonaic 主动调用 Joyous，如 chat.broadcast）。
    // 留空表示不通过 HTTP 出站——UDS 模式或纯「接收」场景无需配置。
    joyousInvokeUrl: '',
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
  bridge: Object.freeze({
    // 出站业务调用（chat.broadcast / 事件）的传输选择，语义同 status.transport
    transport: 'auto',
    // 握手 `subname`。留空则回退到 main.json 的 `subname`
    subname: '',
    // Joyous 侧 profile 键 → { platform, channels }；空对象 ⇒ 不投递、也不接受任何 chat.publish
    profiles: Object.freeze({}),
    // 允许 $joyous 调用的业务方法（静态白名单；空数组 ⇒ 全关）
    allowedMethods: BUSINESS_METHODS,
    broadcast: Object.freeze({
      // 是否把外部群聊内播到 MC。channels 为空时本就无所匹配，故这里默认开
      enabled: true,
    }),
    identity: Object.freeze({
      // 绑定校验码。留空 ⇒ 不校验（直接绑定）
      code: '',
    }),
    ai: Object.freeze({
      // ai.request 未指定 profile 时用哪些 AI Profile
      AIlist: Object.freeze(['*']),
      // AI 生成的兜底超时；超时回 `timeout`
      timeoutMs: DEFAULT_TIMEOUTS.COMMAND,
    }),
    rateLimit: Object.freeze({
      // 每个业务方法每分钟允许的次数；0 ⇒ 不限流
      perMinute: 120,
    }),
  }),
});

/**
 * 读取并归一化拓展配置。
 * @returns {{ status: object, httpServer: object, uds: object, dispatch: object,
 *   bridge: object, issues: string[] }}
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
    invokePath: pickPath(conf.getString('httpServer.invokePath', DEFAULTS.httpServer.invokePath), 'httpServer.invokePath', issues),
    healthPath: pickPath(conf.getString('httpServer.healthPath', DEFAULTS.httpServer.healthPath), 'httpServer.healthPath', issues),
    token: String(conf.getString('httpServer.token', DEFAULTS.httpServer.token) ?? ''),
    joyousInvokeUrl: String(conf.getString('httpServer.joyousInvokeUrl', DEFAULTS.httpServer.joyousInvokeUrl) ?? '').trim(),
  };
  if (httpServer.path === httpServer.invokePath) {
    issues.push(
      `httpServer.path 与 httpServer.invokePath 不能相同（都是 ${httpServer.path}），`
      + `invokePath 已回退为缺省值 ${DEFAULTS.httpServer.invokePath}`,
    );
    httpServer.invokePath = DEFAULTS.httpServer.invokePath;
  }

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

  const bridge = {
    transport: pickEnum(conf.getString('bridge.transport', DEFAULTS.bridge.transport), TRANSPORTS, 'bridge.transport', issues),
    subname: String(conf.getString('bridge.subname', DEFAULTS.bridge.subname) ?? ''),
    profiles: readProfiles(conf, issues),
    allowedMethods: readMethods(conf, issues),
    broadcast: {
      enabled: conf.getBoolean('bridge.broadcast.enabled', DEFAULTS.bridge.broadcast.enabled),
    },
    identity: {
      code: String(conf.getString('bridge.identity.code', DEFAULTS.bridge.identity.code) ?? '').trim(),
    },
    ai: {
      AIlist: pickTextList(
        // 必须把默认值交给 getList：否则「字段缺省」也会得到 []，
        // 于是每次全新配置启动都会误报一条「AIlist 为空」的 issue。
        // 传了默认值后，只有用户**显式写了空列表**才会告警。
        conf.getList('bridge.ai.AIlist', [...DEFAULTS.bridge.ai.AIlist]),
        DEFAULTS.bridge.ai.AIlist,
        'bridge.ai.AIlist',
        issues,
      ),
      timeoutMs: pickPositiveInt(conf.getInt('bridge.ai.timeoutMs', DEFAULTS.bridge.ai.timeoutMs), DEFAULTS.bridge.ai.timeoutMs, 'bridge.ai.timeoutMs', issues),
    },
    rateLimit: {
      perMinute: pickNonNegativeInt(conf.getInt('bridge.rateLimit.perMinute', DEFAULTS.bridge.rateLimit.perMinute), DEFAULTS.bridge.rateLimit.perMinute, 'bridge.rateLimit.perMinute', issues),
    },
  };

  return { status, httpServer, uds, dispatch, bridge, issues };
}

// ---- 归一化小工具（不变量在读取处一次说清，避免散落到使用处）----

/**
 * 读取 `bridge.profiles`：Joyous 侧 profile 键 → 投递目标。
 *
 * @apiNote 刻意允许两侧的 profile **命名不同**：Joyous 的 `group-chat-sync.profile` 键
 *          与 Neonaic 的平台 Profile 名是两套命名空间，用 `platform` 字段显式对应，
 *          避免一方改名就悄悄同步失败。
 * @param {object} conf NeonaicConfig
 * @param {string[]} issues
 * @returns {Record<string, { platform: string, channels: string[] }>}
 */
function readProfiles(conf, issues) {
  const raw = conf.getSection('bridge.profiles', null);
  if (!raw) return {};

  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      issues.push(`bridge.profiles.${key} 不是对象，已忽略`);
      continue;
    }
    const channels = (Array.isArray(value.channels)
      ? value.channels
      : (value.channels == null ? [] : [value.channels]))
      .map((c) => String(c ?? '').trim())
      .filter(Boolean);
    if (!channels.length) {
      // fail-closed：宁可拒绝也不能「不写白名单就等于全放行」
      issues.push(`bridge.profiles.${key} 未配置 channels：该 profile 的 chat.publish 会被一律拒绝`);
    }
    const platform = String(value.platform ?? '').trim();
    out[key] = { platform: platform || key, channels };
  }
  return out;
}

/**
 * 读取 `bridge.allowedMethods`。
 * @param {object} conf
 * @param {string[]} issues
 * @returns {string[]}
 */
function readMethods(conf, issues) {
  const raw = conf.getList('bridge.allowedMethods', [...DEFAULTS.bridge.allowedMethods]);
  const out = [];
  for (const value of Array.isArray(raw) ? raw : []) {
    const method = String(value ?? '').trim();
    if (method && !out.includes(method)) out.push(method);
  }
  if (!out.length) {
    issues.push('bridge.allowedMethods 为空：$joyous 将无法调用任何业务方法');
  }
  return out;
}

/**
 * @param {Array} value
 * @param {readonly string[]} fallback
 * @param {string} label
 * @param {string[]} issues
 * @returns {string[]}
 */
function pickTextList(value, fallback, label, issues) {
  const out = (Array.isArray(value) ? value : [])
    .map((v) => String(v ?? '').trim())
    .filter(Boolean);
  if (out.length) return out;
  issues.push(`${label} 为空，已回退为 ${JSON.stringify([...fallback])}`);
  return [...fallback];
}

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
