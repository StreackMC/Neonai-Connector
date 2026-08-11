/**
 * commandServer.js — 命令注册与执行引擎（纯逻辑，无 UI 依赖）
 *
 * 提供：
 *   registerCommand(name, handler, opts) — 注册命令（含权限）
 *   executeCommand(cmdName, ctx, ...args) — 执行 + auto-catch
 *   executeCommandSilent(cmdName, ctx, ...args) — 执行 + throw
 *   parseArgs(input) / inferNext(input) / getCommands() — 工具
 *
 * 权限：
 *   opts.permissions: "perm" (须拥有) | "!perm" (须缺失) | ["perm", "!other"]
 *   所有条件须同时满足。CLI 发起时 internalCall=true，跳过权限检查。
 *
 * 上下文（传入 handler 的 this）：
 *   { executor, internalCall, timestamp, this: originalThis }
 */

import { checkSinglePermission } from './permissionServer.js';
import { getLogger } from '../system/logger/logger.js';

// ---- 颜色 ----
const RED   = '\x1b[31m';
const CYAN  = '\x1b[36m';
const DIM   = '\x1b[2m';
const BOLD  = '\x1b[1m';
const R     = '\x1b[0m';

/**
 * 命令条目。
 * @typedef {object} CommandMeta
 * @property {string} namespace 命名空间（'' 表示全局）
 * @property {string} name 原名
 * @property {string[]} aliases 别名列表
 * @property {Function} handler
 * @property {string[]} permissions
 * @property {string} [description]
 * @property {string} [usage]
 */

/** 所有命令（去重，按注册顺序） */
const allCommands = [];
/** 全局原名 -> 命令（可被新命令别名覆盖） */
const globalNames = new Map();
/** 全局别名 -> 命令 */
const globalAliases = new Map();
/** 命名空间限定名（ns:name / ns:alias）-> 命令（穿透覆盖，永不丢失） */
const fqns = new Map();

// ---- 参数解析 ----

/** 按 POSIX 标准解析参数 @returns {[string, string[]]} 首个参数为命令名，第二个为参数列表 */
export function parseArgs(input) {
  const args = [];
  let current = '', inSingle = false, inDouble = false, escape = false;

  for (const ch of input) {
    if (escape) {
      if (inDouble && ch !== '"' && ch !== '\\') current += '\\';
      current += ch; escape = false; continue;
    }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === ' ' && !inSingle && !inDouble) {
      if (current.length > 0) { args.push(current); current = ''; }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) args.push(current);

  if (args.length >= 2) {
    return [args.shift(), args];
  } else if (args.length == 1) {
    return [args[0], []];
  } else {
    // 数组是空的
    return ["", []];
  }
}

// ---- 注册 ----

/**
 * @param {string} name
 * @param {(...args) => any} handler 参数以 ...args 展开传入，this 为命令上下文。**箭头函数无法接收上下文，需要使用<code>function() {}</code>**
 * @param {object} [opts]
 * @param {(string|string[])[]|string|string[]} [opts.permissions]
 *   权限规则。字符串或字符串列表视作 AND；内层数组视作 OR 组（至少满足其一）。
 *   "perm" 须拥有，"!perm" 须缺失。
 *   例: [a, [b, c], d, [e, "!f"]] → a ∧ d ∧ (b ∨ c) ∧ (e ∨ ¬f)
 * @param {string} [opts.description]
 * @param {string} [opts.usage]
 * @this {CommandContext}
 */
/**
 * 注册命令。
 *
 * 命名空间与别名：
 *   - opts.namespace: 命令所属命名空间（默认 '' 全局）。命名空间限定的命令仍注册全局名，
 *     同时可通过 "ns:name" / "ns:alias" 精确访问（穿透覆盖）。
 *   - opts.alias: 别名（string | string[]）。无命名空间输入时，别名可代替原名使用。
 *
 * 冲突规则（先到先得 + 唯一覆盖例外）：
 *   - 新命令「别名」与已有「原名」冲突 → 覆盖：该别名占据那个全局原名槽，
 *     原命令仅可经命名空间限定访问（若无命名空间则被完全覆盖）。
 *   - 其余冲突（原名冲突、别名冲突、命名空间限定名冲突等）→ 不注册，返回冲突命令列表。
 *
 * @param {string} name 命令原名
 * @param {(...args) => any} handler 参数以 ...args 展开传入，this 为命令上下文
 * @param {object} [opts] 命令附加信息
 * @param {string|string[]} [opts.alias] 别名设置
 * @param {(string|string[])[]|string|string[]} [opts.permissions] 需求权限：第一层数组间为 AND 关系，第二层数组间为 OR 关系；有 ! 前缀表示需要缺失该权限。
 * @param {string} [opts.description] 命令描述
 * @param {string} [opts.usage] 命令用法
 * @returns {null|CommandMeta[]} 成功返回 null；冲突返回冲突命令列表
 * @throws 命名空间、命名或处理器无效
 */
export function registerCommand(namespace, name, /** @this {CommandContext} */handler, opts = {}) {
  if (!namespace) throw new Error("命令具有无效的命名空间：" + namespace);
  if (!name) throw new Error("命令具有无效的命名：" + name);
  if (!(typeof handler === 'function')) throw new Error("命令具有无效的处理器：" + handler);
  const aliases = opts.alias ? (Array.isArray(opts.alias) ? opts.alias : [opts.alias]) : [];
  const perms = opts.permissions
    ? (Array.isArray(opts.permissions) ? opts.permissions : [opts.permissions])
    : [];

  const cmd = {
    namespace, name, aliases: [...aliases],
    handler, permissions: perms,
    description: opts.description, usage: opts.usage,
  };

  // ---- 冲突检测（先到先得；别名撞原名属覆盖例外）----
  const conflicts = [];
  const seen = new Set();
  const addConflict = (c) => { if (!seen.has(c)) { seen.add(c); conflicts.push(c); } };

  // 原名冲突
  if (globalNames.has(name)) addConflict(globalNames.get(name));
  if (globalAliases.has(name)) addConflict(globalAliases.get(name));

  // 别名冲突（别名撞原名 → 覆盖例外不冲突；别名撞别名 → 冲突）
  for (const a of aliases) {
    if (a === name) continue; // 别名与原名相同：同槽，无冲突
    if (globalAliases.has(a)) addConflict(globalAliases.get(a));
  }

  // 命名空间限定名冲突（仅非全局命令）
  if (namespace) {
    if (fqns.has(`${namespace}:${name}`)) addConflict(fqns.get(`${namespace}:${name}`));
    for (const a of aliases) {
      if (fqns.has(`${namespace}:${a}`)) addConflict(fqns.get(`${namespace}:${a}`));
    }
  }

  if (conflicts.length) return conflicts;

  // ---- 注册 ----
  // 覆盖例外：新命令别名占据已有全局原名槽
  for (const a of aliases) {
    if (a === name) continue;
    if (globalNames.has(a)) globalNames.set(a, cmd); // 覆盖：别名替代该原名
  }

  globalNames.set(name, cmd);
  for (const a of aliases) {
    if (a !== name) globalAliases.set(a, cmd);
  }
  if (namespace) {
    fqns.set(`${namespace}:${name}`, cmd);
    for (const a of aliases) fqns.set(`${namespace}:${a}`, cmd);
  }
  allCommands.push(cmd);
  return null;
}

// ---- 权限校验 ----

/**
 * @param {string} cmdName
 * @param {string[] | (string|string[])[]} requiredPerms
 * @param {string|string[]|undefined} executor
 * @returns {string|null} 校验失败原因，成功返回 null
 */
export function checkCommandPerms(cmdName, requiredPerms, executor) {
  if (!requiredPerms.length) return null;

  for (const item of requiredPerms) {
    if (Array.isArray(item)) {
      // OR 组：至少满足一项
      let anyPass = false;
      for (const perm of item) {
        if (checkSinglePermission(executor, perm)) { anyPass = true; break; }
      }
      if (!anyPass) return `缺少权限: 须满足 [${item.join(', ')}] 其中之一`;
    } else {
      // AND 项：必须满足
      if (!checkSinglePermission(executor, item)) {
        const label = item.startsWith('!') ? `${item}（须缺失）` : item;
        return `缺少权限: ${label}`;
      }
    }
  }
  return null;
}

// ---- 错误格式化 ----

function buildError(cmdName, reason, usage) {
  return usage
    ? `${BOLD}${cmdName}${R}${RED}: ${reason}${R}\n${DIM}用法: ${CYAN}${usage}${R}`
    : `${BOLD}${cmdName}${R}${RED}: ${reason}${R}`;
}

// ---- 执行 ----

/**
 * @typedef {Object} CommandContext
 * @property {string[]|string} executor 执行者
 * @property {boolean} [privateExecutor=false] 命令执行是否处于私密场景（如私聊），非私密场景如群聊中其他成员可见
 * @property {boolean} [internalCall=false] 命令调用是否来自内部：来自内部的命令会绕过权限检查
 * @property {Date} timestamp 命令开始执行时的时间
 * @property {Object|undefined} this 命令执行时上下文，可以透传类对象。
 */

/**
 * 执行命令（自动 catch，错误打印到终端）。
 * @param {string} cmdName 命令名
 * @param {CommandContext} [ctx] 上下文，无法设置 timestamp 属性
 * @param {...*} args 命令参数（调用方负责解析）
 * @returns {*|Promise<*>}
 */
export function executeCommand(cmdName, ctx, ...args) {
  try {
    return executeCommandSilent(cmdName, ctx, ...args);
  } catch (err) {
    getLogger().cmd.error(err.message);
  }
}

/**
 * 解析命令引用（支持别名与命名空间）。
 * @param {string} ref 命令引用，如 'name' / 'alias' / 'ns:name' / 'ns:alias'
 * @returns {CommandMeta|null}
 */
export function resolveCommand(ref) {
  if (typeof ref !== 'string' || !ref) return null;
  const idx = ref.indexOf(':');
  if (idx === -1) {
    // 全局：原名优先，再别名
    return globalNames.get(ref) ?? globalAliases.get(ref) ?? null;
  }
  const ns = ref.slice(0, idx);
  const key = ref.slice(idx + 1);
  if (!key) return null;
  // 命名空间限定：fqn 精确查找（原名优先，再别名）
  return fqns.get(`${ns}:${key}`) ?? null;
}

/**
 * 执行命令（不 catch，throw 错误）。
 * @param {string} cmdName 命令名
 * @param {CommandContext} [ctx] 上下文，无法设置 timestamp 属性
 * @param {...*} args 命令参数
 * @returns {*|Promise<*>}
 * @throws {Error}
 */
export function executeCommandSilent(cmdName, ctx = {}, ...args) {
  if (typeof cmdName !== 'string' || !cmdName) return;

  const meta = resolveCommand(cmdName);

  if (!meta) {
    throw new Error(buildError(cmdName, '未知命令'));
  }

  const executor = ctx.executor;
  const internalCall = !!ctx.internalCall;
  const originalThis = ctx.this;
  const privateExecutor = !!ctx.privateExecutor;

  // 权限检查：CLI / 内部调用跳过
  if (!internalCall && executor) {
    const permErr = checkCommandPerms(cmdName, meta.permissions, executor);
    if (permErr) {
      throw new Error(buildError(cmdName, permErr));
    }
  }

  // 构建执行上下文
  const context = {
    executor: executor ?? undefined,
    internalCall, privateExecutor,
    timestamp: new Date(),
    this: originalThis,
  };

  try {
    return meta.handler.call(context, ...args);
  } catch (err) {
    throw new Error(buildError(cmdName, `执行失败: ${err.message}`));
  }
}

// ---- TAB 建议 ----

/** 所有可解析的名字（全局原名 + 全局别名 + 命名空间限定名） */
function allNames() {
  const names = new Set(globalNames.keys());
  for (const a of globalAliases.keys()) names.add(a);
  for (const f of fqns.keys()) names.add(f);
  return names;
}

export function inferNext(input) {
  const trimmed = input.trimStart();
  if (!trimmed || trimmed.includes(' ')) return { hits: [], prefix: trimmed };
  const hits = [...allNames()].filter(n => n.startsWith(trimmed));
  return { hits, prefix: trimmed };
}

// ---- 工具 ----

/** 获取所有已注册命令（按注册顺序） */
export function getCommands() { return allCommands; }

/** 获取是否存在可解析的目标命令（含别名与命名空间） */
export function hasCommand(cmd) { return resolveCommand(cmd) != null; }

// ---- 内置命令 ----

registerCommand('neonaic', 'help', function () {
  /** @type {CommandContext} */
  const ctx = this;
  const names = allCommands.filter((meta) => {
    // 过滤掉无权限命令
    if (!meta?.permissions?.length || ctx.internalCall) return true;
    return checkCommandPerms(meta.name, meta.permissions, ctx.executor) === null;
  }).map((meta) => {
    const label = meta.namespace ? `${meta.namespace}:${meta.name}` : meta.name;
    const aliasTxt = meta.aliases.length ? ` [别名: ${meta.aliases.join(', ')}]` : '';
    return meta?.description ? `${label}${aliasTxt}: ${meta.description}` : `${label}${aliasTxt}`;
  }).sort();
  return names.join('\n') || '暂无注册命令';
}, { description: '显示可用命令列表' });
