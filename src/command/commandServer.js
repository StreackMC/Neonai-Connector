/**
 * commandServer.js — 命令注册与执行引擎（纯逻辑，无 UI 依赖）
 *
 * 提供：
 *   registerCommand(name, handler, opts) — 注册命令（含权限）
 *   executeCommand(cmdName, ctx, ...args) — 执行 + auto-catch
 *   executeCommandSilent(cmdName, ctx, ...args) — 执行 + throw
 *   resolveCommandArgs(input, prefixes) / inferNext(input) / getCommands() — 工具
 *
 * 权限：
 *   opts.permissions: 权限表达式，叶子可带 "!" 前缀（须缺失）——
 *     "perm" | "!perm" | ["perm", "!other"] | [["a", "b"]] | [[["a", "b"], "c"]]
 *     数组分组语义按嵌套深度交替：第 0 层 AND、第 1 层 OR、第 2 层 AND……
 *   opts.permissionDefault: 叶子权限**未显式设置**时的判定值（默认 false = 视为不具备）。
 *   CLI 发起时 internalCall=true，跳过权限检查。
 *
 * 上下文（传入 handler 的 this）：
 *   { executor, internalCall, timestamp, this: originalThis }
 */

import { neonaicPermissionServer } from './permissionServer.js';
import { getLogger } from '../logger/Logger.js';
import { neonaicChore, parseString } from '../utils/chore.js';
import { neonaicCommandInterface } from './commandInterface.js';
import { NeonaicNewable } from "../utils/NeonaicNewableClass.js";
import { NeonaicCommandError, NeonaicIllegalArgumentError, NeonaicIllegalStateError } from "../utils/NeonaicNewableError.js";
import { neonaicConfManager } from '../system/confManager.js';

// ---- 颜色 ----
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const R = '\x1b[0m';

/**
 * 已注册命令的元信息
 * @typedef {Object} NeonaicTCommandMeta
 * @property {string} namespace 命令所属命名空间，用于限定访问（`ns:name` / `ns:alias`）
 * @property {string} name 命令原名，命名空间内唯一
 * @property {string[]} aliases 命令别名列表（不含原名）；别名可与其它命令的原名同槽并覆盖之
 * @property {function(...*): *|Promise<*>} handler 命令处理器，参数以 `...args` 展开传入，`this` 为 {@link NeonaicCommandContext}
 * @property {import('./commandInterface.js').PermissionSpec} permissions 权限要求（表达式语义见 {@link import('./commandInterface.js').PermissionSpec}）
 * @property {boolean} permissionDefault 权限叶子未显式设置时的判定值（默认 false）
 * @property {string|undefined} description 命令描述，供 `help` 等展示
 * @property {string|undefined} usage 用法示例，权限或参数错误时提示
 */

/**
 * 所有命令（去重，按注册顺序）
 * @type {Readonly<NeonaicTCommandMeta>[]}
 */
const allCommands = [];
/** 全局原名 -> 命令（可被新命令别名覆盖） */
const globalNames = new Map();
/** 全局别名 -> 命令 */
const globalAliases = new Map();
/** 命名空间限定名（ns:name / ns:alias）-> 命令（穿透覆盖，永不丢失） */
const fqns = new Map();

// ---- 参数解析 ----

/**
 * 解析命令输入：可选地 trim、识别并剥离命令前缀，最后按 POSIX 标准分词。
 *
 * 三者都是可选项，按调用场景组合：
 *   - CLI / 内部调用：`resolveCommandArgs(line)` —— 不 trim、不剥前缀
 *   - 平台消息入口：`resolveCommandArgs(msg, prefixes, true)` —— 先 trim 再剥前缀
 *
 * @param {string} input 原始输入（启用 `prefixes` 时应含前缀）
 * @param {string|string[]} [prefixes] 命令前缀（可给多个，取**列表中首个匹配**者，与配置书写顺序一致）；
 *   省略则完全不识别前缀。剥前缀后会 trimStart，以容忍 `"/ cmd"` 这类输入
 * @param {boolean} [trim=false] 是否先对整体做 trim。
 *   注意它只影响「前缀识别」与首 token：分词器本身会跳过连续空白，不产生空参数；
 *   但若输入可能带前导空白，启用 `prefixes` 时必须同时开启，否则前缀匹配不上
 * @returns {[string, string[]]|null} `[命令名, 参数列表]`；
 *   仅当传入 `prefixes` 且没有任何一个前缀匹配时返回 null（表示「这不是一条命令」），
 *   其余情况恒为该二元组（输入为空时是 `['', []]`）
 */
function resolveCommandArgs(input, prefixes, trim = false) {
  let text = String(input ?? '');
  if (trim) text = text.trim();

  if (prefixes) {
    const list = Array.isArray(prefixes) ? prefixes : [prefixes];
    /** 首个匹配的前缀；一个都没匹配上说明这不是一条命令 */
    const hit = list.find((p) => typeof p === 'string' && p.length > 0 && text.startsWith(p));
    if (!hit) return null;
    text = text.slice(hit.length).trimStart();
  }

  const args = [];
  let current = '', inSingle = false, inDouble = false, escape = false;

  for (const ch of text) {
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
 * 注册命令。
 *
 * 冲突规则（先到先得 + 唯一覆盖例外）：
 *   - 新命令「别名」与已有「原名」冲突 → 覆盖：该别名占据那个全局原名槽，
 *     原命令仅可经命名空间限定访问（若无命名空间则被完全覆盖）。
 *   - 其余冲突（原名冲突、别名冲突、命名空间限定名冲突等）→ 不注册，返回冲突命令列表。
 *
 * @param {string} name 命令原名
 * @param {(...args) => any} handler 参数以 ...args 展开传入，this 为命令上下文
 * @param {import('./commandInterface.js').CommandRegisterOptions} opts 命令附加信息
 * @returns {null|NeonaicTCommandMeta[]} 成功返回 null；冲突返回冲突命令列表
 * @throws 命名空间、命名或处理器无效
 */
function registerCommand(namespace, name, /** @this {NeonaicCommandContext} */handler, opts = {}) {
  if (!namespace) throw new NeonaicIllegalArgumentError("命令具有无效的命名空间：" + namespace);
  if (!name) throw new NeonaicIllegalArgumentError("命令具有无效的命名：" + name);
  if (!(typeof handler === 'function')) throw new NeonaicIllegalArgumentError("命令具有无效的处理器：" + handler);
  const aliases = opts.alias ? (Array.isArray(opts.alias) ? opts.alias : [opts.alias]) : [];
  const perms = opts.permissions
    ? (Array.isArray(opts.permissions) ? opts.permissions : [opts.permissions])
    : [];
  const permissionDefault = !!opts.permissionDefault;

  const cmd = {
    namespace, name, aliases: [...aliases],
    handler, permissions: perms, permissionDefault,
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
  allCommands.push(Object.freeze(cmd));
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
 * 解析命令引用（支持别名与命名空间）。
 * @param {string} ref 命令引用，如 'name' / 'alias' / 'ns:name' / 'ns:alias'
 * @returns {NeonaicTCommandMeta|null}
 */
function resolveCommand(ref) {
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
 * 执行命令（自动 catch，错误打印到终端）。
 * @param {string} cmdName 命令名
 * @param {NeonaicCommandContext} [ctx] 上下文，无法设置 timestamp 属性
 * @param {...*} args 命令参数（调用方负责解析）
 * @returns {*|Promise<*>}
 */
function executeCommand(cmdName, ctx, ...args) {
  try {
    return executeCommandSilent(cmdName, ctx, ...args);
  } catch (err) {
    getLogger().cmd.error(err.message);
  }
}

/**
 * 执行命令（不 catch，throw 错误）。
 * @param {string} cmdName 命令名
 * @param {NeonaicCommandContext} [ctx] 上下文，无法设置 timestamp 属性
 * @param {...*} args 命令参数
 * @returns {*|Promise<*>}
 * @throws {NeonaicIllegalArgumentError} 找不到命令
 * @throws {NeonaicIllegalStateError} 命令权限有误
 * @throws {NeonaicCommandError} 命令执行错误
 */
function executeCommandSilent(cmdName, ctx = {}, ...args) {
  if (typeof cmdName !== 'string' || !cmdName) return;

  const meta = resolveCommand(cmdName);

  if (!meta) {
    throw new NeonaicIllegalArgumentError(buildError(cmdName, '未知命令'));
  }

  // 构建执行上下文
  const context = new NeonaicCommandContext(ctx);

  // 权限检查：CLI / 内部调用跳过
  if (!context.internalCall) {
    const passed = neonaicPermissionServer.checkPermissionFromContext(context, meta.permissions, meta.permissionDefault);
    if (!passed) {
      throw new NeonaicIllegalStateError(buildError(cmdName, '权限不足'));
    }
  }

  try {
    return meta.handler.call(context, ...args);
  } catch (err) {
    throw new NeonaicCommandError(buildError(cmdName, `执行失败: ${err.message}`), err);
  }
}

/** 命令上下文 */
export class NeonaicCommandContext extends NeonaicNewable {
  #privateExecutor = false; #internalCall = false; #this = undefined; #executor = []; #timestamp = new Date();

  /** 命令开始执行时的时间，每切换一次上下文自动变更，返回拷贝 @type {Date} */
  get timestamp() { return new Date(this.#timestamp.getTime()); };

  /** 命令执行是否处于私密场景（如私聊），非私密场景如群聊中其他成员可见 @type {boolean} */
  get privateExecutor() { return this.#privateExecutor; };
  /** 命令执行是否处于私密场景（如私聊），非私密场景如群聊中其他成员可见 @type {boolean} */
  set privateExecutor(value) { this.#privateExecutor = !!value; };

  /** 命令调用是否来自内部：来自内部的命令会绕过权限检查 @type {boolean} */
  get internalCall() { return this.#internalCall; };
  /** 修改命令调用是否来自内部：来自内部的命令会绕过权限检查 @type {boolean} */
  set internalCall(value) { this.#internalCall = !!value; };

  /** 命令执行时上下文，可以透传类对象 @type {Object|undefined} */
  get this() { return this.#this; };
  /** 改变命令执行时上下文，可以透传类对象 @type {Object|undefined} */
  set this(value) { this.#this = value; };

  /** 上下文的历史执行者；返回副本 @type {string[]} */
  get executor() { return this.#executor.slice(0); };
  /** 追加执行者；请不要传入'$'开头的，除非是内部使用；同时请勿完全信任本处内容。'$console'表示控制台，'$unknown'表示未知。Index越小的执行者越近 @param {string|string[]} value 执行者列表 */
  set executor(value) {
    if (Array.isArray(value)) {
      this.#executor = [...value.map(resolveExecutor), ...this.#executor];
    } else {
      this.#executor = [resolveExecutor(value), ...this.#executor];
    }
  };

  /** @param {NeonaicCommandContext|{privateExecutor?: boolean, internalCall?: boolean, this?: Object, executor?: string|string[]}} options */
  constructor(options) {
    super();
    this.#privateExecutor = !!options?.privateExecutor;
    this.#internalCall = !!options?.internalCall;
    this.#this = options?.this ?? undefined;
    this.executor = options?.executor;
  }

  /** 语法糖：创建一个新的上下文实例 */
  clone() {
    return new NeonaicCommandContext(this);
  }
}

/** 尝试解析执行者 @return {String} */
function resolveExecutor(stringLike) {
  /* 如果是 null/undefined 直接记作未知 */if (stringLike === undefined || stringLike === null) return neonaicCommandInterface.COMMAND_ENUMS.FROM_UNKNOW;
  /* 否则转为文本并删掉首尾空格 */if (typeof stringLike !== 'string') stringLike = parseString(stringLike).trim();
  /* 空文本也视作未知 */if (stringLike.length == 0) return neonaicCommandInterface.COMMAND_ENUMS.FROM_UNKNOW;
  return stringLike;
}

// ---- TAB 建议 ----

/** 所有可解析的名字（全局原名 + 全局别名 + 命名空间限定名） */
function allNames() {
  const names = new Set(globalNames.keys());
  for (const a of globalAliases.keys()) names.add(a);
  for (const f of fqns.keys()) names.add(f);
  return names;
}

function inferNext(input) {
  const trimmed = input.trimStart();
  if (!trimmed || trimmed.includes(' ')) return { hits: [], prefix: trimmed };
  const hits = [...allNames()].filter(n => n.startsWith(trimmed));
  return { hits, prefix: trimmed };
}

// ---- 工具 ----

/**
 * 获取所有已注册命令（按注册顺序）
 * @returns {Readonly<NeonaicTCommandMeta>[]} 副本
 */
function getCommands() { return allCommands.slice(0); }

/** 获取是否存在可解析的目标命令（含别名与命名空间） */
function hasCommand(cmd) { return resolveCommand(cmd) != null; }

// ---- 内置命令 ----

registerCommand('neonaic', 'help', function (...which) {
  /** @type {NeonaicCommandContext} */
  const ctx = this;
  const lookingupCmd = which.map(parseString).join('');
  if (!lookingupCmd) {
    const names = allCommands.filter((meta) => {
      // 过滤掉无权限命令
      if (!meta?.permissions?.length || ctx.internalCall) return true;
      return neonaicPermissionServer.checkPermissionFromContext(ctx, meta.permissions, meta.permissionDefault);
    }).map((meta) => {
      const label = meta.namespace ? `${meta.namespace}:${meta.name}` : meta.name;
      const aliasTxt = meta.aliases.length ? ` [别名: ${meta.aliases.join(', ')}]` : '';
      return meta?.description ? `${label}${aliasTxt}: ${meta.description}` : `${label}${aliasTxt}`;
    }).sort();
    return names.join('\n') || '暂无注册命令';
  } else {
    // 有子参数，查找命令
    const cmdItem = resolveCommand(lookingupCmd);
    if (!cmdItem) return `“${neonaicConfManager.getBotName()}”无法找到命令“${lookingupCmd}”。`;
    if (!neonaicPermissionServer.checkPermissionFromContext(ctx, cmdItem.permissions, cmdItem.permissionDefault))
      return `你无权查看“${lookingupCmd}”的详细信息。`;
    return [
      `命令“${cmdItem.namespace}:${cmdItem.name}”：`,
      `${cmdItem.usage ?? cmdItem.name}`,
      ``,
      `${cmdItem.description ?? "没有提供描述。"}`,
      `可用别名：${parseString(cmdItem.aliases)}`,
    ].join('\n');
  }
}, {
  description: '显示可用命令列表',
  usage: '/help [cmd]',
  permissions: ['neonaic.commmand.help'],
  permissionDefault: true,
});

async function sudoOrRunuser(inherit, who, cmd, ...args) {
  /** @type {NeonaicCommandContext} */
  const ctx = this;
  const targetCmd = typeof cmd === 'string' ? cmd.trim().toLocaleLowerCase() : '';
  if (/* 不检查who是考虑到部分情形下可能有转到匿名上下文的可能 */!targetCmd) throw new NeonaicIllegalArgumentError("参数不完整，应为 [sudo|runuser] <who> <cmd> [...args]");
  if (/* 嵌套保护 */['sudo','runuser','neonaic:sudo','neonaic:runuser'].includes(targetCmd)) {
    throw new NeonaicIllegalArgumentError("要执行的命令不能是 sudo 或 runuser，且 force 命令应在之前。");
  }
  // 切换到目标用户执行命令
  const currentExecutor = Array.isArray(ctx.executor) ? ctx.executor : (ctx.executor ? [ctx.executor] : []);
  const nextExecutor = inherit
    ? [resolveExecutor(who), ...currentExecutor]
    : [resolveExecutor(who)];
  return await executeCommandSilent(targetCmd, { ...ctx, executor: nextExecutor }, ...args);
}

registerCommand('neonaic', 'sudo', async function (who, cmd, ...args) {
  return await sudoOrRunuser.call(this, true, who, cmd, ...args);
}, {
  description: '以某个身份执行命令，会继承当前上下文。',
  usage: "sudo <who> <cmd> [args]",
  permissions: [[neonaicCommandInterface.COMMAND_ENUMS.PERM_SUPERADMIN, "neonaic.command.sudo"]],
});

registerCommand('neonaic', 'runuser', async function (who, cmd, ...args) {
  return await sudoOrRunuser.call(this, false, who, cmd, ...args);
}, {
  description: '切换到某个身份并执行命令，会重置上下文。',
  usage: "runuser <who> <cmd> [args]",
  permissions: [[neonaicCommandInterface.COMMAND_ENUMS.PERM_SUPERADMIN, "neonaic.command.sudo"]],
});

registerCommand('neonaic', 'force', async function (cmd, ...args) {
  /** @type {NeonaicCommandContext} */
  const ctx = this.clone();
  ctx.privateExecutor = true;
  return await executeCommandSilent(cmd, ctx, ...args);
}, {
  description: '强制将上下文视作私密场景执行命令，以绕过隐私检查。',
  usage: "force <cmd> [args]",
  permissions: [[neonaicCommandInterface.COMMAND_ENUMS.PERM_SUPERADMIN, "neonaic.command.force"]],
});

export const neonaicCommandServer = {
  resolveCommandArgs,
  registerCommand,
  resolveCommand,
  executeCommand,
  executeCommandSilent,
  inferNext,
  getCommands,
  hasCommand,
};
