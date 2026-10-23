import { neonaicCommandServer } from '../../../src/command/commandServer.js';
import { neonaicPermissionServer } from '../../../src/command/permissionServer.js';
import { neonaicEventBus } from '../../../src/event/neonaicEventBus.js';
import { NeonaicMessageEvent } from '../../../src/event/neonaicEventInterface.js';
import { getLogger } from '../../../src/logger/Logger.js';
import { NeonaicTextMsgFrag } from '../../../src/message/messageFragment.js';
import { neonaicConfManager } from '../../../src/system/confManager.js';
import { neonaicChore } from '../../../src/utils/chore.js';
import { NeonaicNewable } from '../../../src/utils/NeonaicNewableClass.js';

const OPERATIONS = Object.freeze({
  COMMAND: 'COMMAND',
  AI_REPLY: 'AI_REPLY',
  AI_HYPERREPLY: 'AI_HYPERREPLY'
});

const RATE = Object.freeze({
  COMMAND: [/* 每 */60/* 秒最多使用 */, 20/* 次命令 */],
  AI_REPLY: [/* 每 */300/* 秒最多使用 */, 10/* 次智能回复 */],
  AI_HYPERREPLY: [/* 每 */600/* 秒最多使用 */, 5/* 次多模态智能回复 */],
  /* 智能回复 和 多模态智能回复 独立计算 */
});

const CLEANING_BUCKET_INTERVAL = 1/* 小时就清理一次桶 */ * 3600 * 1e3;

/**
 * @this {import('../../../src/extension/extLoader.js').NeonaicExtItem}
 * @param {{ manifest: Object, pwd: String, ext_item_id: String, ext_item_timestamp: Number }} [ctx] 拓展上下文
 */
export function onEnable(ctx) {
  neonaicEventBus.addEventListener(NeonaicMessageEvent.EVENT_TYPE, handleMsg, { capture: true, once: false, passive: false });
}

/**
 * @this {import('../../../src/extension/extLoader.js').NeonaicExtItem}
 */
export function onDisable() {
  neonaicEventBus.removeEventListener(NeonaicMessageEvent.EVENT_TYPE, handleMsg, { capture: true, once: false, passive: false });
}

/** 速率限制桶 @type {Map<string, number[]>} */
const buckets = new Map();

// 桶的清理为双层：
// 1. setInterval 对快照进行处理，同时处理多少条就退让，避免遍历耗时
// 2. handle 中对条目进行惰性处理

// 设置间隔清理桶
export const BUCKET_CLEANING_TASK_INTERVAL = setInterval(async function cleanBucket() {
  // 单任务
  if (cleanBucket.working) return;
  cleanBucket.working = true;
  try {
    // 初始化
    const current = Date.now();
    const snapshot = [...buckets.entries()];
    let i = 0;

    // 开始清理
    let lastYield = performance.now();
    for (const [key, bucket] of snapshot) {
      i++;
      const cleanedBucket = bucket.filter(old => (current - old) <= RATE[key.split(':').pop()][0] * 1e3);
      if /* CAS保证原子性 */(buckets.get(key) === bucket) {
        if (cleanedBucket.length === 0) {
          buckets.delete(key);
        } else {
          buckets.set(key, cleanedBucket);
        }
      };
      if (performance.now() - lastYield >= 10/* ms 退让一次 */) {
        await new Promise((resolve) => setImmediate(resolve));
        lastYield = performance.now();
      }
    }

    // 结束
    getLogger().ext.info(`完成对 ${i} 条速率限制记录的清理，耗时 `, Date.now() - current, ` 毫秒。`);
  } catch (error) {
    getLogger().ext.warn(`无法完成速率限制记录的清理：`, error);
  } finally {
    cleanBucket.working = false;
  }

}, CLEANING_BUCKET_INTERVAL).unref();

function bucketKey(user, oper) {
  return `${user}::${oper}`;
}

/** 检查并新增条目 */
function isLimited(user, oper, timestamp) {
  if (timestamp instanceof Date) timestamp = timestamp.getTime();

  // 获取桶
  const key = bucketKey(user, oper);
  let bucket = buckets.get(key);
  if (!Array.isArray(bucket)) {
    // 桶不存在，新建一个
    bucket = [];
    buckets.set(key, bucket);
  }

  // 性能优化：先判是否需要清理
  if (bucket.length === 0 || (timestamp - bucket[0]) <= (RATE[oper][0] * 1e3)) {
    if (bucket.length >= RATE[oper][1]) return true; // 超限
    bucket.push(timestamp);
    return false;
  }

  // 惰性清理桶
  bucket = bucket.filter((old) => ((timestamp - old) <= (RATE[oper][0] * 1e3)));
  buckets.set(key, bucket);

  // 判断请求是否超出
  if (bucket.length >= RATE[oper][1]) {
    // 请求超出限制
    return true;
  } else {
    // 未限制，记录
    bucket.push(timestamp);
    // 原始引用使得 Map value 自动更新
    return false;
  }
}

/** @param {NeonaicMessageEvent} event */
function handleMsg(event) {
  const usr = event.detail.user.at(0);
  const msg = event.detail.message;
  const markdown = msg.toMarkdown();

  // 先判断命令
  // TODO: 严重 BUG，如果 resolveReply 没有启用命令解析，这里并不能感知，就会导致意外泄漏
  const prefixes = neonaicConfManager.getConfig(neonaicConfManager.CONFIG_PATHS.main).getList('prefix');
  const parsed = neonaicCommandServer.resolveCommandArgs(markdown, prefixes, true);
  const [cmdName, cmdArgs] = parsed || ["", []];
  const cmd = neonaicCommandServer.resolveCommand(cmdName);
  if (cmd) {
    if (isLimited(usr, OPERATIONS.COMMAND, event.TIMESTAMP)) {
      event.refuse(`你执行命令的速度太快了，“${neonaicConfManager.getBotName()}”反应不过来了。请稍后再试。`);
      return;
    } else {
      return;
    }
  }

  // 然后处理智能回复
  if (msg.fragments.some(f => !(['text', 'br', 'emoji', 'link', 'table'].includes(f.TYPE)))) {
    // 有非文本消息片段，为多模态调用
    if (isLimited(usr, OPERATIONS.AI_HYPERREPLY, event.TIMESTAMP)) {
      event.refuse(`“${neonaicConfManager.getBotName()}”对这么多的媒体消息感到头晕。请稍后再试。`);
      return;
    } else {
      return;
    }
  } else {
    // 纯文本消息
    if (isLimited(usr, OPERATIONS.AI_REPLY, event.TIMESTAMP)) {
      event.refuse(`“${neonaicConfManager.getBotName()}”看消息看不过来了。请稍后再试。`);
      return;
    } else {
      return;
    }
  }
}