import { randomUUID } from 'node:crypto';

import { NeonaicCommandContext } from '#src/command/commandServer.js';
import { neonaicAI } from '#src/message/ai.js';

/**
 * 走 aicode 的**公开接口**（注册在 AI 工具表里的 `aicode:evaljs`），而不是直接 import 它的
 * `sandboxmgr`。这样：
 *   - aicode 的权限校验、并发分组、结果剥离全都在链路上，安全测试才测的是真实的攻击面；
 *   - aicode 被禁用/未加载时这里只是「工具找不到」，不会因为跨拓展 import 直接炸掉本拓展。
 */
const TOOL_NAMESPACE = 'aicode';
const TOOL_NAME = 'evaljs';
const TOOL_FQN = `${TOOL_NAMESPACE}:${TOOL_NAME}`;

/**
 * 取 aicode 的 evaljs 工具定义。
 *
 * @returns {import('#src/message/ai.js').NeonaicTAIToolDef|null}
 */
function findEvalTool() {
  const hits = neonaicAI.findTool(TOOL_FQN);
  for (const def of Array.isArray(hits) ? hits : []) {
    if (def && typeof def.execute === 'function') return def;
  }
  return null;
}

/** aicode 是否就绪（拓展已加载且工具已注册）。 */
function isAvailable() { return findEvalTool() !== null; }

/**
 * 把一段代码送进 aicode 沙箱执行。
 *
 * @param {string} code 用户代码（按 async 函数体执行，用 `return` 返回结果）
 * @param {{ executor?: string }} [options]
 * @returns {Promise<{
 *   ok: boolean, data?: unknown, error?: { name: string, message: string }|null,
 *   logs: string[], durationMs: number, code?: string, message?: string,
 * }>}
 */
async function run(code, options = {}) {
  const executor = String(options.executor ?? '$console').trim() || '$console';

  const tool = findEvalTool();
  if (!tool) {
    return fail('aicode_unavailable', `找不到 AI 工具 ${TOOL_FQN}：aicode 拓展未加载或未启用`);
  }

  // 刻意把 internalCall 留成 false：aicode 用的是 checkPermission(executor, …) 而不是
  // checkPermissionFromContext，这里改成 true 也绕不过去，但别给后来人留错误的暗示。
  const context = new NeonaicCommandContext({ executor: [executor], internalCall: false });

  let raw;
  try {
    raw = await tool.execute(
      { code },
      { neonaic: context, userInput: '', toolCallId: randomUUID(), messages: [] },
    );
  } catch (error) {
    return fail('call_failed', `调用 aicode 工具时抛出异常：${error?.message ?? error}`);
  }

  if (typeof raw !== 'string') {
    return fail('bad_result', `aicode 返回了非字符串结果（${typeof raw}）`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return fail('bad_result', 'aicode 返回的结果不是对象');
    return {
      ok: parsed.ok === true,
      data: parsed.data,
      error: parsed.error && typeof parsed.error === 'object' ? parsed.error : null,
      logs: Array.isArray(parsed.logs) ? parsed.logs.filter((line) => typeof line === 'string') : [],
      durationMs: Number(parsed.durationMs) || 0,
      ...(parsed.code ? { code: String(parsed.code) } : {}),
      ...(parsed.message ? { message: String(parsed.message) } : {}),
    };
  } catch {
    return fail('bad_result', 'aicode 返回的结果无法解析为 JSON');
  }
}

/**
 * 造一个失败结果。
 *
 * @param {string} code
 * @param {string} message
 * @returns {{ ok: false, code: string, message: string, logs: string[], durationMs: number }}
 */
function fail(code, message) {
  return { ok: false, code, message, logs: [], durationMs: 0 };
}

/**
 * 把结果摊平成前端要的两块文本：`logs` + 返回值进 stdout，错误进 stderr。
 *
 * @param {{ ok: boolean, data?: unknown, error?: { name?: string, message?: string }|null,
 *           logs?: string[], code?: string, message?: string }} result
 * @returns {{ stdout: string, stderr: string }}
 */
function format(result) {
  /** @type {string[]} */
  const stdout = [];
  for (const line of result.logs ?? []) stdout.push(line);
  if (result.ok && result.data !== undefined) {
    stdout.push(`← ${stringifyData(result.data)}`);
  }

  /** @type {string[]} */
  const stderr = [];
  if (!result.ok) {
    const message = result.message ?? '';
    stderr.push(`[${result.code ?? 'error'}] ${message}`.trim());
    const name = result.error?.name;
    const detail = result.error?.message;
    // sandboxmgr 会把 error.message 同时写进 message，别重复打印两遍
    if (name && detail && detail !== message) stderr.push(`${name}: ${detail}`);
  }

  return { stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

/**
 * 返回值的可读化：优先 JSON，失败则退回字符串。
 *
 * @param {unknown} data
 * @returns {string}
 */
function stringifyData(data) {
  if (typeof data === 'string') return data;
  try {
    const text = JSON.stringify(data, null, 2);
    return text === undefined ? String(data) : text;
  } catch {
    return String(data);
  }
}

export const aicodeBridge = Object.freeze({
  TOOL_FQN,
  isAvailable,
  run,
  format,
});
