/**
 * protocol/dispatch.js — 命令分发层（通信层与命令系统之间的唯一接缝）
 *
 * 定位：这是**唯一**允许同时了解「通信协议」与「内核命令系统」的模块。
 * http.js 与 uds.js 都只调用 `joyousDispatcher.execute()`，互相不知道对方的命令请求
 * 长什么样；反过来说，命令系统也完全不知道请求是从 HTTP 还是 UDS 来的。
 *
 * ── 权限模型（白名单的实现方式）──
 * 把 JoyousPlugin 视作一个**不受信任的外部身份** `$joyous`（与 `$console` 同级的虚拟执行者），
 * 白名单由三层叠加而成，全部复用内核既有的权限系统，没有新增任何权限机制：
 *
 *   1. 总闸  `joyous.bridge.execute`
 *      必须显式授予 `$joyous`，否则一律拒绝。默认不授予 ⇒ **开箱即全关**。
 *   2. 命令自身声明的 `permissions`
 *      由命令系统原生语义校验（AND / OR / `!` 否定），与 CLI / 平台侧完全同源。
 *   3. 空权限命令的补漏  `joyous.command.<ns>:<name>`
 *      命令系统里「未声明 permissions」等价于「任何人可执行」，这对内部命令是合理的，
 *      对不受信任的外部身份则是漏洞。因此这里额外要求 `$joyous` 显式持有该命令的专有授权。
 *
 * 授权示例（管理员在 CLI 执行）：
 *   /neonaic:permission set $joyous joyous.bridge.execute true
 *   /neonaic:permission set $joyous joyous.command.joyous:mc true
 */

import { neonaicCommandServer } from '../../../../src/command/commandServer.js';
import { neonaicPermissionServer } from '../../../../src/command/permissionServer.js';
import {
  NeonaicCommandError,
  NeonaicIllegalArgumentError,
  NeonaicIllegalStateError,
} from '../../../../src/utils/NeonaicNewableError.js';
import {
  DEFAULT_TIMEOUTS,
  ERROR_CODES,
  MAX_COMMAND_LENGTH,
  MAX_OUTPUT_LENGTH,
} from './constants.js';

/**
 * JoyousPlugin 的合成执行者标识。
 *
 * 为什么定义在拓展内、而不是内核的 `COMMAND_ENUMS`：
 *   这个身份**只对 joyous 有意义**，属于「可拆卸拓展」的一部分。写进内核会让本体凭空多出一个
 *   只在某拓展存在时才成立的死常量 —— 那正是「拓展与本体解耦」要排除的耦合。
 *   内核只声明自身需要的合成身份（`$console` / `$unknown`）；`$` 前缀是合成身份的保留命名空间，
 *   拓展可以在其中定义自己的名字，而权限系统按**执行者字符串**存授权，因此不需要任何枚举登记。
 *
 * ⚠️ 这个名字是**权限键的一部分**（`config/saves/permissions.json` 中的 `$joyous`）：
 *    改名会让既有授权全部失效，必须同步迁移。
 */
export const BRIDGE_EXECUTOR = '$joyous';

/** 总闸权限名：未授予时整个桥接不可执行任何命令 */
export const BRIDGE_GATE_PERMISSION = 'joyous.bridge.execute';

/**
 * 命令请求的两种等价写法。
 * @typedef {object} CommandRequest
 * @property {string} [input] 整行命令文本，如 `"neonaic:help moon"`，由命令系统按 POSIX 规则切分
 * @property {string} [command] 命令引用（`name` / `alias` / `ns:name` / `ns:alias`）
 * @property {string[]} [args] 与 `command` 搭配的参数列表
 */

/**
 * 分发结果。成功时 `ok` 为 true；失败一律以抛错表达，错误对象带 `code`（见 {@link ERROR_CODES}）。
 * @typedef {object} DispatchResult
 * @property {string} ref 实际解析到的命令引用
 * @property {string} namespace 命令命名空间
 * @property {string} name 命令原名
 * @property {string} output 命令返回的文本
 * @property {boolean} truncated output 是否因超过上限被截断
 */

/**
 * 执行一次来自 JoyousPlugin 的命令请求。
 * @param {CommandRequest|string} request 请求体，或直接给整行命令文本
 * @param {object} [options]
 * @param {number} [options.timeoutMs] 命令执行兜底超时，缺省 {@link DEFAULT_TIMEOUTS}.COMMAND
 * @returns {Promise<DispatchResult>}
 * @throws {NeonaicCommandError} 带 `code`：`invalid_argument` / `permission_denied` /
 *         `unknown_command` / `command_failed` / `timeout` / `internal_error`
 */
export async function execute(request, options = {}) {
  let normalized;
  try {
    normalized = normalizeRequest(request);
  } catch (e) {
    // 归一化阶段的异常也必须带上协议错误码，否则会被上层归为 internal_error
    throw fail(ERROR_CODES.INVALID_ARGUMENT, e?.message ?? String(e), e);
  }
  const { ref, args, rawText } = normalized;

  if (!ref) {
    throw fail(ERROR_CODES.INVALID_ARGUMENT, '未提供要执行的命令');
  }
  if (rawText.length > MAX_COMMAND_LENGTH) {
    throw fail(
      ERROR_CODES.INVALID_ARGUMENT,
      `命令文本超过上限（${rawText.length} > ${MAX_COMMAND_LENGTH} 字符）`,
    );
  }

  // 第 1 层：总闸
  if (!neonaicPermissionServer.checkSinglePermission(BRIDGE_EXECUTOR, BRIDGE_GATE_PERMISSION)) {
    throw fail(
      ERROR_CODES.PERMISSION_DENIED,
      `身份 ${BRIDGE_EXECUTOR} 未获授权：缺少 ${BRIDGE_GATE_PERMISSION}`,
    );
  }

  // 第 2 / 3 层：按命令校验
  const meta = neonaicCommandServer.resolveCommand(ref);
  if (!meta) {
    throw fail(ERROR_CODES.UNKNOWN_COMMAND, `未知命令：${ref}`);
  }
  const denial = authorize(meta);
  if (denial) {
    throw fail(ERROR_CODES.PERMISSION_DENIED, denial);
  }

  const execRef = meta.namespace ? `${meta.namespace}:${meta.name}` : meta.name;
  let value;
  try {
    value = await withTimeout(
      neonaicCommandServer.executeCommandSilent(execRef, {
        executor: BRIDGE_EXECUTOR,
        // 刻意保持 false：这正是「外部身份」的语义，权限检查必须照常生效
        internalCall: false,
        privateExecutor: false,
      }, ...args),
      Number(options.timeoutMs ?? DEFAULT_TIMEOUTS.COMMAND),
      `命令 ${execRef}`,
    );
  } catch (e) {
    throw classify(e, execRef);
  }

  const { text, truncated } = clampOutput(renderOutput(value));
  return { ref: execRef, namespace: meta.namespace, name: meta.name, output: text, truncated };
}

/**
 * 只做校验不执行，用于诊断（如桥接状态命令）。
 * @param {CommandRequest|string} request
 * @returns {{ allowed: boolean, reason: string, ref: string }}
 */
export function dryRun(request) {
  let normalized;
  try {
    normalized = normalizeRequest(request);
  } catch (e) {
    return { allowed: false, reason: e?.message ?? String(e), ref: '' };
  }
  const { ref } = normalized;
  if (!ref) return { allowed: false, reason: '未提供要执行的命令', ref: '' };

  if (!neonaicPermissionServer.checkSinglePermission(BRIDGE_EXECUTOR, BRIDGE_GATE_PERMISSION)) {
    return { allowed: false, reason: `缺少总闸权限 ${BRIDGE_GATE_PERMISSION}`, ref };
  }
  const meta = neonaicCommandServer.resolveCommand(ref);
  if (!meta) return { allowed: false, reason: '未知命令', ref };
  const denial = authorize(meta);
  return { allowed: !denial, reason: denial ?? '已授权', ref: meta.namespace ? `${meta.namespace}:${meta.name}` : meta.name };
}

/**
 * 计算命令的专有授权键（第 3 层）。
 * @param {{ namespace?: string, name: string }} meta
 * @returns {string}
 */
export function commandPermissionKey(meta) {
  const ref = meta.namespace ? `${meta.namespace}:${meta.name}` : meta.name;
  return `joyous.command.${ref}`;
}

// ---- 内部 ----

/**
 * 归一化请求，产出「命令引用 + 参数」。
 * @param {CommandRequest|string} request
 * @returns {{ ref: string, args: string[], rawText: string }}
 * @throws {NeonaicIllegalArgumentError} 请求体结构不合法
 */
function normalizeRequest(request) {
  if (typeof request === 'string') {
    return fromInput(request);
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new NeonaicIllegalArgumentError('命令请求必须是字符串或对象');
  }

  if (typeof request.input === 'string' && request.input.trim()) {
    return fromInput(request.input);
  }

  if (typeof request.command === 'string' && request.command.trim()) {
    const ref = request.command.trim();
    if (request.args !== undefined && !Array.isArray(request.args)) {
      throw new NeonaicIllegalArgumentError('命令请求的 args 必须是数组');
    }
    const args = (request.args ?? []).map((v) => String(v));
    return { ref, args, rawText: [ref, ...args].join(' ') };
  }

  return { ref: '', args: [], rawText: '' };
}

/**
 * @param {string} input
 * @returns {{ ref: string, args: string[], rawText: string }}
 */
function fromInput(input) {
  const rawText = String(input).trim();
  const [ref, args] = neonaicCommandServer.parseArgs(rawText);
  return { ref, args, rawText };
}

/**
 * 校验 `$joyous` 是否有权执行该命令。
 * @param {{ namespace: string, name: string, permissions: Array<string|string[]> }} meta
 * @returns {string|null} 拒绝原因；通过返回 null
 */
function authorize(meta) {
  if (meta.permissions?.length) {
    // 命令系统原生语义
    return neonaicCommandServer.checkCommandPerms(meta.name, meta.permissions, BRIDGE_EXECUTOR);
  }
  // 空权限命令 → 要求专有授权
  const key = commandPermissionKey(meta);
  if (!neonaicPermissionServer.checkSinglePermission(BRIDGE_EXECUTOR, key)) {
    const ref = meta.namespace ? `${meta.namespace}:${meta.name}` : meta.name;
    return `命令“${ref}”未声明权限（等价于任何人可执行），外部身份需显式持有 ${key}`;
  }
  return null;
}

/**
 * 把内核抛出的异常映射为携带协议错误码的异常。
 * @param {Error} error
 * @param {string} ref
 * @returns {NeonaicCommandError}
 */
function classify(error, ref) {
  if (error?.code && typeof error.code === 'string') return error; // 已是协议错误
  if (error instanceof NeonaicIllegalArgumentError) {
    return fail(ERROR_CODES.UNKNOWN_COMMAND, `未知命令：${ref}`, error);
  }
  if (error instanceof NeonaicIllegalStateError) {
    return fail(ERROR_CODES.PERMISSION_DENIED, error.message, error);
  }
  if (error instanceof NeonaicCommandError) {
    return fail(ERROR_CODES.COMMAND_FAILED, error.message, error);
  }
  if (error instanceof Error) {
    // 命令处理器若是 async，抛出的异常会以「Promise 拒绝」的形式逸出
    // executeCommandSilent 的同步 try/catch（内核当前只拦同步异常），
    // 这里把它归为「命令执行失败」——对外部身份而言这就是命令失败了。
    return fail(ERROR_CODES.COMMAND_FAILED, `命令 ${ref} 执行失败：${error.message}`, error);
  }
  return fail(ERROR_CODES.INTERNAL_ERROR, `命令 ${ref} 执行失败：${String(error)}`);
}

/**
 * @param {string} code
 * @param {string} message
 * @param {Error|null} [cause]
 * @returns {NeonaicCommandError}
 */
function fail(code, message, cause = null) {
  const err = new NeonaicCommandError(message, cause);
  err.code = code;
  return err;
}

/**
 * 给可能不返回 Promise 的命令补上超时保护。
 * @template T
 * @param {T|Promise<T>} value
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
function withTimeout(value, ms, label) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve(value);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(fail(ERROR_CODES.TIMEOUT, `${label} 超过 ${ms}ms 仍未返回`));
    }, ms);
    timer.unref?.();
    Promise.resolve(value).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * 把命令返回值渲染为文本。
 * @param {*} value
 * @returns {string}
 */
function renderOutput(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * 截断超长输出。
 * @param {string} text
 * @returns {{ text: string, truncated: boolean }}
 */
function clampOutput(text) {
  if (text.length <= MAX_OUTPUT_LENGTH) return { text, truncated: false };
  const dropped = text.length - MAX_OUTPUT_LENGTH;
  return { text: `${text.slice(0, MAX_OUTPUT_LENGTH)}\n…（输出过长，已截断 ${dropped} 字符）`, truncated: true };
}

export const joyousDispatcher = Object.freeze({
  BRIDGE_EXECUTOR,
  BRIDGE_GATE_PERMISSION,
  commandPermissionKey,
  execute,
  dryRun,
});
