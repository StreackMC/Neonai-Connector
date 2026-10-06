/**
 * protocol/codec.js — 「JSON + LF」帧编解码器
 *
 * 分帧约定：一帧 = 一行 JSON + 一个 LF（`\n`）。
 *
 * 为什么 LF 是安全的（而不是需要转义的分隔符）：
 *   `JSON.stringify` 永远不会在输出中产生裸的换行——字符串里的换行会被写成 `\n`
 *   这两个字符（反斜杠 + n），而不是真实换行。因此 LF 只可能出现在帧尾。
 *
 * 本实现刻意做成了**增量式**的：TCP/UDS 是字节流，一次 `data` 事件既可能只给半个帧
 * （半包），也可能一次给出好几个帧（粘包）。`push()` 维护残余缓冲并只在凑齐 LF 时出帧。
 *
 * 宽容度：行首尾空白与 CRLF（`\r\n`）都会被容忍，避免 Java 侧误用 `println` 就整条链路报废。
 */

import {
  NeonaicIllegalArgumentError,
  NeonaicProtocolError,
} from '../../../../src/utils/NeonaicNewableError.js';
import {
  ERROR_CODES,
  FRAME_DELIMITER,
  MAX_FRAME_BYTES,
} from './constants.js';

/**
 * 无法解析的帧（一行里不是合法 JSON 对象）。
 * @typedef {object} BadFrame
 * @property {string} raw 原始行文本（已 trim，可能被截断用于展示）
 * @property {string} error 失败原因
 */

/**
 * @typedef {object} PushResult
 * @property {object[]} frames 成功解析出的消息帧，按到达顺序
 * @property {BadFrame[]} bad 解析失败的帧；因分隔符切分与内容无关，流不会因此失步
 */

/** 展示坏帧时的最大保留长度 */
const BAD_FRAME_PREVIEW = 200;

export class NeonaicLineFrameCodec {
  /** 尚未凑成完整帧的残余文本（不含分隔符） @type {string} */
  #rest = '';

  /** 单帧字节上限 @type {number} */
  #maxBytes;

  /**
   * @param {number} [maxBytes=MAX_FRAME_BYTES] 单帧字节上限，超出视为协议错误
   */
  constructor(maxBytes = MAX_FRAME_BYTES) {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
      throw new NeonaicIllegalArgumentError(`帧编解码器的单帧上限不合法：${maxBytes}`);
    }
    this.#maxBytes = maxBytes;
  }

  /** 单帧字节上限 @returns {number} */
  get maxBytes() { return this.#maxBytes; }

  /** 是否还压着半包未出 @returns {boolean} */
  get pending() { return this.#rest.length > 0; }

  /** 当前残余缓冲的字节数 @returns {number} */
  get pendingBytes() { return Buffer.byteLength(this.#rest, 'utf8'); }

  /**
   * 把一条消息编码为可写出的整帧。
   * @param {object} message 消息对象
   * @returns {string} 一行 JSON + LF
   * @throws {NeonaicProtocolError} 消息无法序列化（如循环引用）
   */
  static encode(message) {
    let text;
    try {
      text = JSON.stringify(message);
    } catch (e) {
      const err = new NeonaicProtocolError(`消息无法序列化为 JSON：${e?.message ?? e}`, e);
      err.code = ERROR_CODES.BAD_FRAME;
      throw err;
    }
    if (typeof text !== 'string') {
      // JSON.stringify 对 undefined / function 返回 undefined
      const err = new NeonaicProtocolError('消息无法序列化为 JSON：不含可序列化内容');
      err.code = ERROR_CODES.BAD_FRAME;
      throw err;
    }
    return text + FRAME_DELIMITER;
  }

  /**
   * 送入一段文本，切出其中已完整的帧。
   * @param {string} chunk 已按 UTF-8 解码的文本片段
   * @returns {PushResult}
   * @throws {NeonaicProtocolError} 残余缓冲超过单帧上限（此时缓冲已被丢弃）
   */
  push(chunk) {
    if (typeof chunk !== 'string' || chunk.length === 0) return { frames: [], bad: [] };
    this.#rest += chunk;

    const frames = [];
    const bad = [];

    let cut = this.#rest.indexOf(FRAME_DELIMITER);
    while (cut !== -1) {
      const raw = this.#rest.slice(0, cut);
      this.#rest = this.#rest.slice(cut + 1);

      // 容忍 CRLF 与首尾空白
      const line = raw.trim();
      if (line) {
        let parsed = null;
        try {
          parsed = JSON.parse(line);
        } catch (e) {
          bad.push({ raw: preview(line), error: e?.message ?? String(e) });
        }
        if (parsed !== null) {
          if (typeof parsed !== 'object' || Array.isArray(parsed)) {
            bad.push({ raw: preview(line), error: '帧不是 JSON 对象' });
          } else {
            frames.push(parsed);
          }
        }
      }

      cut = this.#rest.indexOf(FRAME_DELIMITER);
    }

    // 对端始终不发分隔符时的兜底：宁可断开也不让缓冲无限膨胀
    const pending = this.pendingBytes;
    if (pending > this.#maxBytes) {
      this.reset();
      const err = new NeonaicProtocolError(
        `单帧长度超过上限（${pending} > ${this.#maxBytes} 字节），已丢弃接收缓冲`,
      );
      err.code = ERROR_CODES.FRAME_TOO_LARGE;
      throw err;
    }

    return { frames, bad };
  }

  /** 丢弃残余半包（重连 / 复位时调用） */
  reset() { this.#rest = ''; }
}

/**
 * 截断过长的原始行，避免把整段垃圾日志打出去。
 * @param {string} line
 * @returns {string}
 */
function preview(line) {
  return line.length > BAD_FRAME_PREVIEW ? `${line.slice(0, BAD_FRAME_PREVIEW)}…` : line;
}
