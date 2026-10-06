/**
 * protocol/constants.js — Joyous 桥接协议常量
 *
 * 本文件是协议的**唯一事实来源**：帧类型、方法名、错误码、角色与上限都在此声明，
 * 通信实现（session / http / uds）与分发层（dispatch）一律引用这里，不得散落魔法字符串。
 *
 * 协议全貌见 ../../PROTOCOL.md 。
 */

/** 协议名称，握手时交换以拒绝「连错端口 / 连错对端」这类误接 */
export const PROTOCOL_NAME = 'neonai-joyous-bridge';

/**
 * 协议主版本。
 * 语义：**主版本必须完全一致**才允许握手成功；不一致时被动端回复错误帧并断开。
 * 后续若需要向后兼容的演进，应新增 `minor` 字段而非放宽本值。
 */
export const PROTOCOL_VERSION = 1;

/** 帧分隔符：一帧 = 一行 JSON + 一个 LF */
export const FRAME_DELIMITER = '\n';

/**
 * 单帧字节上限（1 MiB）。
 * 用于防止对端始终不发分隔符导致发送/接收缓冲无限增长。
 */
export const MAX_FRAME_BYTES = 1 << 20;

/** 单条命令文本的长度上限，超出直接拒绝（避免把超大 payload 送进命令解析器） */
export const MAX_COMMAND_LENGTH = 8192;

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
 */
export const CAPABILITIES = Object.freeze({
  /** 接受 `command.execute` 请求 */
  COMMAND_EXECUTE: 'command.execute',
  /** 接受 `status.query` 请求 */
  STATUS_QUERY: 'status.query',
});

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
  /** 心跳（也可直接用 PING 帧） */
  PING: 'ping',
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
