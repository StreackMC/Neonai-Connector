import { Buffer } from 'node:buffer';

/**
 * 父子进程之间的帧编解码。
 *
 * 为什么不用 Node 自带的 `child.send` / `process.send`：
 *   那条通道的解析在 `node:internal/child_process/serialization` 里，
 *   子进程往 fd 3 写一段**非法 JSON** 会让 `JSON.parse` 抛在 `channel.onread` 里，
 *   而这里没有 try/catch —— 于是整个宿主进程（也就是 Neonai 内核）直接崩溃。
 *   实测（Node 22.22.2）：
 *     `{bad-frame}\n` → SyntaxError: Expected property name ... at parseChannelMessages
 *   也就意味着「沙箱子进程被攻陷」可以升级成「内核被一条帧打死」。
 *
 * 所以这里改用自己控制的两个管道（子进程读 fd 3、写 fd 4），并自带一层的校验：
 *   - 以 `\n` 分帧（`JSON.stringify` 不会输出裸换行，分隔符是安全的）；
 *   - 半包留缓冲、粘包按分隔符切；
 *   - 单帧超过 {@link MAX_FRAME_BYTES} 立刻判定违规（不给无上限的缓冲）；
 *   - 非 JSON / 非对象一律违规。
 * 违规由调用方决定怎么处理 —— 在 `sandboxmgr.js` 里就是「强杀该子进程」。
 */

const FRAME_DELIMITER = 0x0a;
/** 单帧字节上限。我们的结果帧最多 512K 字符，1MB 足够宽容。 */
const MAX_FRAME_BYTES = 1024 * 1024;

/**
 * 把一条消息编码成一帧。
 * @param {object} message
 * @returns {Buffer}
 */
function encodeFrame(message) {
  const text = JSON.stringify(message);
  if (typeof text !== 'string') throw new TypeError('IPC 消息无法序列化为 JSON');
  return Buffer.from(`${text}\n`, 'utf8');
}

/**
 * 增量帧解码器。
 *
 * @param {(message: object) => void} onMessage 收到一条合法帧
 * @param {(reason: string) => void} onViolation 帧不合法（之后解码器失效）
 * @returns {{ push: (chunk: Buffer) => void, isBroken: () => boolean }}
 */
function createFrameDecoder(onMessage, onViolation) {
  /** @type {Buffer} */
  let buffer = Buffer.alloc(0);
  let broken = false;

  const fail = (reason) => {
    if (broken) return;
    broken = true;
    buffer = Buffer.alloc(0);
    onViolation(reason);
  };

  const push = (chunk) => {
    if (broken) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    buffer = buffer.length === 0 ? data : Buffer.concat([buffer, data]);

    for (;;) {
      const index = buffer.indexOf(FRAME_DELIMITER);
      if (index < 0) {
        if (buffer.length > MAX_FRAME_BYTES) {
          fail(`单帧超过 ${MAX_FRAME_BYTES} 字节（未收到分隔符）`);
        }
        return;
      }
      const line = buffer.subarray(0, index);
      buffer = buffer.subarray(index + 1);
      if (line.length > MAX_FRAME_BYTES) {
        fail(`单帧超过 ${MAX_FRAME_BYTES} 字节`);
        return;
      }
      if (line.length === 0) continue;

      let parsed;
      try {
        parsed = JSON.parse(line.toString('utf8'));
      } catch (error) {
        fail(`帧不是合法 JSON：${error?.message ?? error}`);
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        fail(`帧不是对象（${Array.isArray(parsed) ? 'array' : typeof parsed}）`);
        return;
      }
      onMessage(parsed);
    }
  };

  return Object.freeze({ push, isBroken: () => broken });
}

export const aicodeFraming = Object.freeze({
  FRAME_DELIMITER,
  MAX_FRAME_BYTES,
  encodeFrame,
  createFrameDecoder,
});
