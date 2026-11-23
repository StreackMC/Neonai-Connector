/**
 * ai/caller.js — 执行者（调用者）相关：封禁检查、身份解析、上下文归一化
 *
 * 这里的每个函数都只关心「这轮对话是谁在说话」，与模型调用本身无关。
 */

import { neonaicCommandInterface } from '#src/command/commandInterface.js';
import { NeonaicCommandContext } from '#src/command/commandServer.js';
import { neonaicPermissionServer } from '#src/command/permissionServer.js';
import { getLogger } from '#src/logger/Logger.js';
import { neonaicUserDirectory } from '#src/message/userDirectory.js';
import { parseString } from '#src/utils/chore.js';

/** 封禁用户使用 AI 的权限名 */
const AI_BAN_PERMISSION = 'neonaic.toolcall.ai';

// ---- 外部 API ----

/**
 * 检查调用者是否被禁止使用 AI。
 * @param {string|string[]|null|undefined} caller 调用者标识（执行者链）
 * @returns {{banned: boolean, until?: Date}}
 */
function isAIBanned(caller) {
  if (!Array.isArray(caller)) caller = caller ? [parseString(caller)] : [neonaicCommandInterface.COMMAND_ENUMS.FROM_UNKNOW];

  // 对每一层校验
  for (let index = 0; index < caller.length; index++) {
    const user = caller[index];
    const result = neonaicPermissionServer.getSinglePermissionStatus(user, AI_BAN_PERMISSION);
    // 如果权限没有显式拒绝则跳过
    if (result.status !== 'false') continue;
    // 被拒绝后判断是不是临时拒绝
    if (result.permanent) {
      return { banned: true };
    } else {
      return {
        banned: true,
        until: result.until
      };
    }
  }
  // 每一层都没有拒绝
  return { banned: false };
}

/**
 * 把 `speaker` 选项解析成一段可读描述。
 *
 * @param {string|object|null|undefined} speaker
 *   - `undefined` → 用 `caller` 查用户名录（默认行为）
 *   - `string`    → 直接采用（平台已自行解析好，最灵活）
 *   - `object`    → 结构化 `{ name, pronoun, note }`；场景部分仍由 `caller` 查名录补齐
 *   - `null`      → 明确不投递身份（如提示词优化这类非对话轮次）
 * @param {string|string[]|undefined} caller 执行者链，用于查名录
 * @returns {string} 可读描述；空串表示无可读身份信息
 */
function resolveSpeaker(speaker, caller) {
  if (speaker === null || speaker === false) return '';
  if (typeof speaker === 'string') return speaker.trim();
  if (speaker && typeof speaker === 'object' && !Array.isArray(speaker)) {
    const entry = neonaicUserDirectory.normalizeEntry(speaker);
    if (!entry) return '';
    // caller[0] 就是说话者本人，不要再当作场景渲染一遍
    return neonaicUserDirectory.composeSentence(entry, Array.isArray(caller) ? caller.slice(1) : []);
  }
  return neonaicUserDirectory.describe(caller);
}

/** `caller` 弃用提示只记一次：它可能被每轮对话触发，重复刷屏没有意义 */
let _callerDeprecationWarned = false;

/** 提示 `askAI` 的 `caller` 选项已弃用（每个进程只提示一次） */
function warnCallerDeprecatedOnce() {
  if (_callerDeprecationWarned) return;
  _callerDeprecationWarned = true;
  getLogger().tool.warn(
    '[ai] askAI 的 options.caller 已弃用，请改用 options.context'
    + '（NeonaicCommandContext 或其普通对象形式）；兼容垫片会把 privateExecutor 视为 false。',
  );
}

/**
 * 把 {@link askAI} 的 `context` / 兼容用的 `caller` 归一化为命令上下文。
 *
 * - 普通对象会被 `new NeonaicCommandContext(...)` 包一层（平台侧通常只提供 `{ executor, privateExecutor }`）；
 * - 一律返回**副本**，工具改动不会污染调用方；
 * - 强制 `internalCall = false`：`checkPermissionFromContext` 对 internalCall 直接放行，AI 层不能继承；
 * - 清空 `this`：工具是按全局语义注册的，平台对象不应经此泄漏，也避免指代不明。
 *
 * @param {NeonaicCommandContext|{executor?: string|string[], privateExecutor?: boolean}} [input]
 * @returns {NeonaicCommandContext}
 */
function toCommandContext(input) {
  let ctx;
  if (input instanceof NeonaicCommandContext) {
    ctx = input.clone();
  } else {
    const source = input ?? {};
    // 显式补 []：构造函数会把缺省的 executor 记成 $unknown，而「没传 caller」应当是空链
    ctx = new NeonaicCommandContext({ ...source, executor: source.executor ?? [] });
  }
  ctx.internalCall = false;
  ctx.this = undefined;
  return ctx;
}

export const neonaicAICaller = {
  AI_BAN_PERMISSION,
  isAIBanned,
  resolveSpeaker,
  warnCallerDeprecatedOnce,
  toCommandContext,
};
