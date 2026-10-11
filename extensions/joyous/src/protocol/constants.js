/**
 * protocol/constants.js — Joyous 桥接协议常量
 *
 * 本文件是协议的**唯一事实来源**：帧类型、方法名、错误码、角色与上限都在此声明，
 * 通信实现（session / http / uds）与分发层（dispatch）一律引用这里，不得散落魔法字符串。
 *
 * 协议全貌见 ../../PROTOCOL.md（V1）与 ../../PROTOCOL-V2.md（V2，本文档为准）。
 */

/** 协议名称，握手时交换以拒绝「连错端口 / 连错对端」这类误接 */
export const PROTOCOL_NAME = 'neonai-joyous-bridge';

/**
 * 协议主版本。
 * 语义：**主版本必须完全一致**才允许握手成功；不一致时被动端回复错误帧并断开。
 * 后续若需要向后兼容的演进，应新增 `minor` 字段而非放宽本值。
 *
 * V2（本值 = 2）相对 V1 的增量：握手帧新增 `subname`，方法集新增
 * `chat.publish` / `chat.broadcast` / `ai.request` / `identity.bind` / `identity.resolve`。
 * 这些方法要求双方都主动实现并对外声明能力，故提升主版本而**不做**事后协商降级
 * （沿用 V1 §5.3「主版本必须完全一致」的既有哲学）——见 PROTOCOL-V2.md §0。
 */
export const PROTOCOL_VERSION = 2;

/** 帧分隔符：一帧 = 一行 JSON + 一个 LF */
export const FRAME_DELIMITER = '\n';

/**
 * 单帧字节上限（1 MiB）。
 * 用于防止对端始终不发分隔符导致发送/接收缓冲无限增长。
 */
export const MAX_FRAME_BYTES = 1 << 20;

/** 单条命令文本的长度上限，超出直接拒绝（避免把超大 payload 送进命令解析器） */
export const MAX_COMMAND_LENGTH = 8192;

/**
 * 通道选择枚举。`status.transport`（状态查询）与 `bridge.transport`（出站业务调用）共用同一套语义：
 *   - `auto`：能走 UDS 就走 UDS，未就绪或失败则回退 HTTP
 *   - `http`：只用 HTTP
 *   - `uds` ：只用 UDS（失败即失败，不静默回退）
 */
export const TRANSPORTS = Object.freeze(['auto', 'http', 'uds']);

/** 命令执行结果文本回传上限，超出时截断 */
export const MAX_OUTPUT_LENGTH = 16384;

/** 通道终端的角色标识 */
export const CHANNEL_ROLES = Object.freeze({
  /** 本端：Neonaic */
  NEONAI: 'neonai',
  /** 对端：JoyousPlugin */
  JOYOUS: 'joyous',
});

/**
 * 握手次序。刻意做成可配置，因为在「谁先开口」这一点上，
 * 对端实现（Java 侧）与本文档必须达成一致，而这属于部署事实而非协议本质。
 */
export const HANDSHAKE_MODES = Object.freeze({
  /** 被动：连接后等待对端 `hello`，本端回 `welcome`。UDS 模式的默认值。 */
  RESPONDER: 'responder',
  /** 主动：连接后立即发送 `hello`，等待对端 `welcome`。 */
  INITIATOR: 'initiator',
});

/**
 * 本端在握手 `hello` / `welcome` 中申报的能力。
 * 对端可用它做能力探测；未申报的能力一律视为不支持。
 *
 * @apiNote 这只是**能力提示，不是权限授予**：宣称有能力不代表对端就被允许调用，
 *          调用是否放行由各端的授权模型决定（Neonaic 侧见 methods.js 的业务闸）。
 */
export const CAPABILITIES = Object.freeze({
  /** 接受 `command.execute` 请求 */
  COMMAND_EXECUTE: 'command.execute',
  /** 接受 `status.query` 请求 */
  STATUS_QUERY: 'status.query',
  /** 接受 `chat.publish`（MC 聊天外发）请求 */
  CHAT_PUBLISH: 'chat.publish',
  /** 接受 `chat.broadcast`（外部消息内播）请求 */
  CHAT_BROADCAST: 'chat.broadcast',
  /** 接受 `ai.request`（AI 生成）请求 */
  AI_REQUEST: 'ai.request',
  /** 接受 `identity.bind`（身份绑定）请求 */
  IDENTITY_BIND: 'identity.bind',
  /** 接受 `identity.resolve`（身份解析）请求 */
  IDENTITY_RESOLVE: 'identity.resolve',
});

/**
 * Neonaic 侧实现并对外声明的能力（`welcome` 帧申报）。
 * `chat.broadcast` 由 Joyous 提供，Neonaic 是调用方，故**不在**本列表内。
 */
export const NEONAI_CAPABILITIES = Object.freeze([
  CAPABILITIES.COMMAND_EXECUTE,
  CAPABILITIES.STATUS_QUERY,
  CAPABILITIES.CHAT_PUBLISH,
  CAPABILITIES.AI_REQUEST,
  CAPABILITIES.IDENTITY_BIND,
  CAPABILITIES.IDENTITY_RESOLVE,
]);

/**
 * V2 新增的**业务方法**（除 command.execute / status.query 之外）。
 * 业务闸（methods.js）以此列表为准，未列出的方法不会被动注册。
 */
export const BUSINESS_METHODS = Object.freeze([
  CAPABILITIES.CHAT_PUBLISH,
  CAPABILITIES.AI_REQUEST,
  CAPABILITIES.IDENTITY_BIND,
  CAPABILITIES.IDENTITY_RESOLVE,
]);

/** 帧类型 */
export const FRAME_TYPES = Object.freeze({
  /** 握手首帧（主动端发出） */
  HELLO: 'hello',
  /** 握手应答帧（被动端发出） */
  WELCOME: 'welcome',
  /** 请求帧，必须带 id */
  REQUEST: 'request',
  /** 应答帧，必须带 id 且与请求 id 一致 */
  RESPONSE: 'response',
  /** 单向事件帧，不应答 */
  EVENT: 'event',
  /** 心跳请求 */
  PING: 'ping',
  /** 心跳应答 */
  PONG: 'pong',
});

/** 请求方法名 */
export const METHODS = Object.freeze({
  /** 执行一条 Neonaic 命令：payload = { input } 或 { command, args } */
  COMMAND_EXECUTE: 'command.execute',
  /** 查询 Joyous StatusAPI 等价数据：payload = { address? } */
  STATUS_QUERY: 'status.query',
  /** 把 MC 聊天外发到 Neonaic 的频道：payload = { profile, channel, sender, message, ts }（Joyous → Neonaic） */
  CHAT_PUBLISH: 'chat.publish',
  /** 把外部聊天内播到 MC：payload = { profile, channel, user, message, visibility, target?, ts }（Neonaic → Joyous） */
  CHAT_BROADCAST: 'chat.broadcast',
  /** 请求生成一段 AI 回复：payload = { profile?, trigger, actor, prompt, context?, visibility?, maxOutputChars? } */
  AI_REQUEST: 'ai.request',
  /** 绑定 MC 身份与聊天身份：payload = { profile, mc, chatId, code? } */
  IDENTITY_BIND: 'identity.bind',
  /** 按 MC 身份查询绑定：payload = { profile, mc } */
  IDENTITY_RESOLVE: 'identity.resolve',
  /** 心跳（也可直接用 PING 帧） */
  PING: 'ping',
});

/** 单向事件名（`event` 帧的 `method`） */
export const EVENTS = Object.freeze({
  /** 绑定关系变更（Neonaic → Joyous），payload = { profile, mc, chatId, bound } */
  IDENTITY_CHANGED: 'identity.changed',
});

/** 协议错误码：出现在 `response.error.code` 或错误事件中 */
export const ERROR_CODES = Object.freeze({
  /** 收到的帧无法解析或结构不合法 */
  BAD_FRAME: 'bad_frame',
  /** 单帧超过 MAX_FRAME_BYTES */
  FRAME_TOO_LARGE: 'frame_too_large',
  /** 协议名或主版本不匹配 */
  UNSUPPORTED_VERSION: 'unsupported_version',
  /** 握手超时 */
  HANDSHAKE_TIMEOUT: 'handshake_timeout',
  /** 尚未完成握手就发送了业务帧 */
  NOT_HANDSHAKEN: 'not_handshaken',
  /** 请求方法未实现 */
  UNKNOWN_METHOD: 'unknown_method',
  /** 请求参数不合法 */
  INVALID_ARGUMENT: 'invalid_argument',
  /** 命令不存在 */
  UNKNOWN_COMMAND: 'unknown_command',
  /** 权限不足（$joyous 未被授权） */
  PERMISSION_DENIED: 'permission_denied',
  /** 命令自身执行失败 */
  COMMAND_FAILED: 'command_failed',
  /** 身份尚未绑定 / 校验码不匹配 */
  NOT_BOUND: 'not_bound',
  /** 触发频率限制 */
  RATE_LIMITED: 'rate_limited',
  /** 对端未在超时时间内应答 */
  TIMEOUT: 'timeout',
  /** 本端内部错误 */
  INTERNAL_ERROR: 'internal_error',
});

/** 通道生命周期状态 */
export const CHANNEL_STATES = Object.freeze({
  /** 尚未启动 */
  IDLE: 'idle',
  /** 正在建立底层连接 */
  CONNECTING: 'connecting',
  /** 已连接，正在握手 */
  HANDSHAKING: 'handshaking',
  /** 握手完成，可收发业务帧 */
  READY: 'ready',
  /** 已关闭 */
  CLOSED: 'closed',
});

/** 各阶段的默认超时（毫秒） */
export const DEFAULT_TIMEOUTS = Object.freeze({
  /** 建立底层连接 */
  CONNECT: 5000,
  /** 完成握手 */
  HANDSHAKE: 5000,
  /** 单条请求等待应答 */
  REQUEST: 10000,
  /** 命令本身执行的兜底上限 */
  COMMAND: 30000,
  /** 心跳间隔，0 表示关闭心跳 */
  HEARTBEAT: 30000,
});
