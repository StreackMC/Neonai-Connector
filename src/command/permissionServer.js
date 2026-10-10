/**
 * permissionServer.js — 4 层权限系统
 *
 * 优先级（高 → 低）：
 *   临时权限 > 永久权限 > 全局临时权限 > 全局权限
 *   持久化到 config/permissions.json，每次变更自动写盘。
 *
 * 执行者链：["USR#xxx", "GRP#xxx"]
 *   最左侧最近，最后总隐式接 global ("*")。
 *   权限检查从最近开始，未设置时顺次向上继承。
 *
 * 权限表达式（permission）：
 *   叶子为字符串，可带 `!` 前缀表示「须缺失」；数组为分组，分组语义**按嵌套深度交替**：
 *     第 0 层（最外）AND → 第 1 层 OR → 第 2 层 AND → 第 3 层 OR → …
 *   例：'a' = a｜['a','b'] = a AND b｜[['a','b']] = a OR b
 *       [[['a','b'],'c']] = (a AND b) OR c｜[['a','b'],'c'] = (a OR b) AND c
 *   空数组取单位元（AND 层 true、OR 层 false）；最外层 `[]` 即「无要求」。
 *
 * 未显式设置（叶子在执行者链的四层里都无记录）由调用方的 fallback 决定取值
 * （默认 false，即「未设置 = 不具备该权限」），之后才施加 `!` 取反。
 * 故检查结果恒为布尔，调用方通过 fallback 表达「未设置怎么算」，不再有 null 三态。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSON5 from 'json5';
import { parseString } from '../utils/chore.js';
import { neonaicConfManager } from '../system/confManager.js';
import { neonaicCommandInterface } from './commandInterface.js';

// 注：本模块不 import commandServer.js 的运行期能力，避免循环依赖。
// 权限命令由组合根（entry.js）通过 installPermissionCommands(registerCommand) 安装。

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PERM_FILE = resolve(ROOT, 'config/saves/permissions.json');

// ---- 4 层存储 ----
const store = {
  /** user → { permission → { status: boolean, until: number } } */
  temp:       new Map(),
  /** user → { permission → boolean } */
  permanent:  new Map(),
  /** permission → { status: boolean, until: number } */
  globalTemp: new Map(),
  /** permission → boolean */
  global:     new Map(),
};

// ---- 持久化 ----

let _loaded = false;

function _load() {
  if (_loaded) return;
  _loaded = true;
  if (!existsSync(PERM_FILE)) return;
  try {
    const raw = JSON5.parse(readFileSync(PERM_FILE, 'utf8'));
    if (raw.permanent) {
      for (const [user, perms] of Object.entries(raw.permanent)) {
        store.permanent.set(user, { ...perms });
      }
    }
    if (raw.temp) {
      for (const [user, perms] of Object.entries(raw.temp)) {
        const m = {};
        for (const [k, v] of Object.entries(perms)) {
          m[k] = { status: !!v.status, until: v.until || 0 };
        }
        store.temp.set(user, m);
      }
    }
    if (raw.global) {
      for (const [k, v] of Object.entries(raw.global)) {
        store.global.set(k, !!v);
      }
    }
    if (raw.globalTemp) {
      for (const [k, v] of Object.entries(raw.globalTemp)) {
        store.globalTemp.set(k, { status: !!v.status, until: v.until || 0 });
      }
    }
  } catch {
    // 损坏的权限文件 → 从头开始
  }
}

function _save() {
  const out = {
    permanent: Object.fromEntries(
      [...store.permanent].map(([k, v]) => [k, { ...v }]),
    ),
    temp: Object.fromEntries(
      [...store.temp].map(([k, v]) => [k, { ...v }]),
    ),
    global: Object.fromEntries(store.global),
    globalTemp: Object.fromEntries(store.globalTemp),
  };
  // 用 JSON.stringify（而非 JSON5.stringify）持久化：
  // 1. 控制字符、引号、反斜杠统一使用标准 \uXXXX 转义；
  // 2. 关键：JSON.stringify 会把孤立代理项（U+D800–U+DFFF）转义为 \udXXX，
  //    而 JSON5.stringify 会将其原样写出，经 writeFileSync 的 UTF-8 编码时被替换为
  //    U+FFFD（�），造成静默数据损坏 —— JSON5 不具备 well-formed 序列化能力；
  // 3. JSON.stringify 不转义 U+2028/U+2029（ES2019 起在 JSON 中合法），但读取端
  //    JSON5.parse 仍会告警，故额外显式转义，确保每个字符都被正确处理。
  // 读取端继续用 JSON5.parse（JSON 超集），兼容旧的 JSON5 格式文件。
  const json = JSON.stringify(out, null, 2)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  writeFileSync(PERM_FILE, json, 'utf8');
}

// 模块加载时读取已有数据
_load();

// ---- 内部 ----

function userKey(user) {
  if (!user || (Array.isArray(user) && user.length === 0)) return '*';
  return Array.isArray(user) ? user[0] : String(user);
}

function ensure(tempOrPermanent, user) {
  const key = userKey(user);
  if (!store[tempOrPermanent].has(key)) {
    store[tempOrPermanent].set(key, {});
  }
  return store[tempOrPermanent].get(key);
}

// ---- 检查 ----

/** 内部哨兵：该权限在执行者链的四层里都没有被显式设置 @type {symbol} */
const UNSET = Symbol('UNSET');

/**
 * 沿执行者链查表：取最近一层显式设置的结果。
 * @param {string|string[]|null} user 用户标识（可为执行者链）
 * @param {string} permission 权限名（不含 `!`）
 * @returns {boolean|typeof UNSET} 整条链（含 `*` 兜底）都未设置时为 {@link UNSET}
 */
function _lookup(user, permission) {
  if (Array.isArray(user)) {
    for (let i = 0; i < user.length; i++) {
      const r = _lookupSingle(user[i], permission);
      if (r !== UNSET) return r;
    }
    return _lookupSingle('*', permission);
  }
  return _lookupSingle(user || '*', permission);
}

/**
 * 求值单个叶子（形如 `'perm'` / `'!perm'`）。
 *
 * 未显式设置的权限取 `fallback`（默认 false），**随后**才施加 `!` 取反；
 * 故 `'!a'` 在 a 未设置且 fallback=false 时通过（未设置 = 确实不具备该权限）。
 * 空名与 `'*'` 恒为 false（通配不成叶片）。
 * @param {string|string[]|null} user 用户标识（可为执行者链）
 * @param {string} permission 叶子权限，可带 `!` 前缀
 * @param {boolean} [fallback=false] 该权限未显式设置时的取值
 * @returns {boolean}
 */
function _evaluateLeaf(user, permission, fallback = false) {
  const isNegate = permission.startsWith('!');
  const name = isNegate ? permission.slice(1) : permission;
  if (!name || name === '*') return false;
  const raw = _lookup(user, name);
  const has = raw === UNSET ? !!fallback : raw;
  return isNegate ? !has : has;
}

/**
 * 递归求值权限表达式。
 *
 * 分组语义按嵌套深度交替：depth 为偶数（含最外层 0）是 AND，奇数是 OR。
 * 空数组取单位元：AND 层 true、OR 层 false。
 * @param {string|string[]|null} user 用户标识（可为执行者链）
 * @param {string|Array<*>} spec 权限表达式
 * @param {number} depth 当前嵌套深度
 * @param {boolean} fallback 叶子未显式设置时的取值
 * @returns {boolean}
 */
function _evaluate(user, spec, depth, fallback) {
  if (Array.isArray(spec)) {
    const isAnd = depth % 2 === 0;
    for (const item of spec) {
      const r = _evaluate(user, item, depth + 1, fallback);
      if (isAnd && !r) return false; // AND：一项不通过即失败
      if (!isAnd && r) return true;  // OR ：一项通过即成功
    }
    return isAnd; // 空组取单位元；非空组走完循环亦同此结论
  }
  return _evaluateLeaf(user, String(spec), fallback);
}

/**
 * 检查单条权限（支持 `!` 否定前缀）。
 * 供 commandServer 与拓展复用，统一否定语义。
 * @param {string|string[]|null} user 用户标识（可为执行者链）
 * @param {string} permission 权限名，可带 `!` 前缀
 * @param {boolean} [fallback=false] 该权限未显式设置时的判定值
 * @returns {boolean} true = 通过
 */
function checkSinglePermission(user, permission, fallback = false) {
  return _evaluateLeaf(user, permission, fallback);
}

/**
 * 测试用户是否满足权限规则。
 * @param {string|string[]|null} user 用户标识（可为执行者链）
 * @param {string|Array<*>} permission 权限表达式
 *   - 字符串 → 单个叶子（支持 `!` 否定）
 *   - 数组 → 分组，语义按嵌套深度交替：第 0 层 AND、第 1 层 OR、第 2 层 AND……
 *     例：`[a, b]` = a AND b；`[[a, b]]` = a OR b；`[[[a, b], c]]` = (a AND b) OR c
 *   - 未传 / `''` / `'*'` → 恒 false（无要求请用 `[]`）
 * @param {boolean} [fallback=false] 叶子权限未显式设置时的判定值。
 *   注意最外层 `[]` 表示「无要求」恒为 true，不受本参数影响。
 * @returns {boolean} 恒为布尔
 */
function checkPermission(user, permission, fallback = false) {
  if (!permission || permission === '*') return false;
  return _evaluate(user, permission, 0, fallback);
}

/**
 * 测试命令上下文是否满足权限规则。
 * CLI/internalCall 始终返回 true。
 * @param { import('./commandServer.js').NeonaicCommandContext } ctx
 * @param {string|Array<*>} permission 权限表达式
 * @param {boolean} [fallback=false] 叶子权限未显式设置时的判定值
 * @returns {boolean}
 */
function checkPermissionFromContext(ctx, permission, fallback = false) {
  if (ctx?.internalCall) return true;
  return checkPermission(ctx?.executor, permission, fallback);
}

/**
 * 单个执行者的 4 层查表。
 * 过期的临时项就地删除后继续向下层继承 —— 因此「过期」表现为**回落到下一层**（最终可能为未设置），
 * 而不是变成拒绝。
 * @param {string} user 单个执行者
 * @param {string} permission 权限名（不含 `!`）
 * @returns {boolean|typeof UNSET} 四层均未显式设置时为 {@link UNSET}
 */
function _lookupSingle(user, permission) {
  const key = String(user ?? '*');

  // 1. 临时权限
  const tMap = store.temp.get(key);
  if (tMap?.[permission] != null) {
    if (tMap[permission].until && Date.now() > tMap[permission].until) {
      // 过期，删除并继续向下
      delete tMap[permission];
    } else {
      return !!tMap[permission].status;
    }
  }

  // 2. 永久权限
  const pMap = store.permanent.get(key);
  if (pMap?.[permission] != null) return !!pMap[permission];

  // 3. 全局临时
  const gt = store.globalTemp.get(permission);
  if (gt != null) {
    if (gt.until && Date.now() > gt.until) {
      store.globalTemp.delete(permission);
    } else {
      return !!gt.status;
    }
  }

  // 4. 全局永久
  const gp = store.global.get(permission);
  if (gp != null) return !!gp;

  return UNSET; // 所有层级未设置
}

// ---- 设置 ----

/**
 * 设置权限。
 * @param {string|string[]} user
 * @param {string} permission
 * @param {boolean} [status=true]
 * @returns {'invalid_user'|'successfully'}
 */
function setPermission(user, permission, status = true) {
  if (!user || !permission) return 'invalid_user';
  const map = ensure('permanent', user);
  map[permission] = !!status;
  _save();
  return 'successfully';
}

/**
 * 设置临时权限。
 * @param {string|string[]} user
 * @param {string} permission
 * @param {boolean} [status=true]
 * @param {number|Date} [until] 过期时间（时间戳 ms 或 Date）
 * @returns {'invalid_user'|'successfully'}
 */
function setTempPermission(user, permission, status = true, until) {
  if (!user || !permission) return 'invalid_user';
  const map = ensure('temp', user);
  const ts = until instanceof Date ? until.getTime() : (typeof until === 'number' ? until : 0);
  map[permission] = { status: !!status, until: ts || 0 };
  _save();
  return 'successfully';
}

/**
 * 设置全局权限。
 * @param {string} permission
 * @param {boolean} [status=true]
 * @returns {'invalid_perm'|'successfully'}
 */
function setGlobalPermission(permission, status = true) {
  if (!permission) return 'invalid_perm';
  store.global.set(permission, !!status);
  _save();
  return 'successfully';
}

/**
 * 设置全局临时权限。
 * @param {string} permission
 * @param {boolean} [status=true]
 * @param {number|Date} [until]
 * @returns {'invalid_perm'|'successfully'}
 */
function setGlobalTempPermission(permission, status = true, until) {
  if (!permission) return 'invaild_perm';
  const ts = until instanceof Date ? until.getTime() : (typeof until === 'number' ? until : 0);
  store.globalTemp.set(permission, { status: !!status, until: ts || 0 });
  _save();
  return 'successfully';
}

// ---- 清除 ----

/**
 * 清除指定用户的永久权限。
 * @param {string|string[]|null} user 用户标识
 * @param {string} permission 权限名；"*" 清除该用户全部永久权限
 * @returns {'invalid_user'|'successfully'}
 */
function clearPermission(user, permission) {
  if (!user) return 'invalid_user';
  const key = userKey(user);
  let changed = false;
  if (permission === '*') {
    store.permanent.delete(key);
    changed = true;
  } else {
    const map = store.permanent.get(key);
    if (map) { delete map[permission]; changed = true; }
  }
  if (changed) _save();
  return 'successfully';
}

/**
 * 清除指定用户的临时权限。
 * @param {string|string[]|null} user 用户标识
 * @param {string} permission 权限名；"*" 清除该用户全部临时权限
 * @param {number} [until=-1] 若权限的语义过期时间晚于该时间戳则不删除
 * @returns {'invalid_user'|'successfully'}
 */
function clearTempPermission(user, permission, until = -1) {
  if (!user) return 'invalid_user';
  const key = userKey(user);
  let changed = false;
  if (permission === '*') {
    store.temp.delete(key);
    changed = true;
  } else {
    const map = store.temp.get(key);
    if (map) {
      if (until !== -1 && map[permission]?.until && map[permission].until > until) return 'successfully';
      delete map[permission]; changed = true;
    }
  }
  if (changed) _save();
  return 'successfully';
}

/**
 * 清除全局永久权限。
 * @param {string} permission 权限名；"*" 清空全部全局永久权限
 * @returns {'successfully'}
 */
function clearGlobalPermission(permission) {
  if (permission === '*') { store.global.clear(); _save(); return 'successfully'; }
  store.global.delete(permission);
  _save();
  return 'successfully';
}

/**
 * 清除全局临时权限。
 * @param {string} permission 权限名；"*" 清空全部全局临时权限
 * @param {number} [until=-1] 若权限的语义过期时间晚于该时间戳则不删除
 * @returns {'successfully'}
 */
function clearGlobalTempPermission(permission, until = -1) {
  if (permission === '*') { store.globalTemp.clear(); _save(); return 'successfully'; }
  if (until !== -1) {
    const v = store.globalTemp.get(permission);
    if (v?.until && v.until > until) return 'successfully';
  }
  store.globalTemp.delete(permission);
  _save();
  return 'successfully';
}

// ---- 与命令交互 ----

/**
 * 权限管理命令。
 *
 * 用法：
 *   permission set <user|*> <perm> [true|false] [lasting]   设置权限
 *   permission unset <user|*> <perm>                        清除权限
 *
 *   - <user|*>: "*" 表示全局权限，否则为指定用户的权限
 *   - [true|false]: 权限值，默认 true
 *   - [lasting]: 持续时间（临时权限），如 '1y2M3d4h5m6s'（年/月/天/时/分/秒）。
 *                提供时写入临时权限层（过期时间 = 当前 + 持续），否则写入永久权限层
 *
 * @param {string} type     'set' | 'unset'
 * @param {string} user     用户标识或 '*'
 * @param {string} permission 权限名
 * @param {string} [status] 'true' | 'false'（仅 set）
 * @param {string} [lasting] 持续时间（仅 set）
 * @this { import('./commandServer.js').NeonaicCommandContext }
 * @returns {string} 执行结果描述
 */
function cmd(type, user, permission, status, lasting) {
  /** @type { import('./commandServer.js').NeonaicCommandContext } */
  const ctx = this;

  // 不允许大庭广众下进行权限操作
  if (!ctx.privateExecutor) return `“${neonaicConfManager.getBotName()}”未能完成操作，因为当前上下文不是私密的。`;

  if (!type || (type !== 'set' && type !== 'unset')) {
    return `用法: ${cmd.meta.usage}`;
  }
  if (!user || !permission) {
    return `用法: ${cmd.meta.usage}`;
  }

  const isGlobal = user === '*';

  // ---- set ----
  if (type === 'set') {
    const bool = status === undefined ? true : /^(true|1|yes|on)$/i.test(String(status));
    let until = 0;

    // 解析持续时间（若有）→ 过期时间 = 当前 + 持续
    if (lasting !== undefined) {
      const ms = parseDuration(lasting);
      if (ms == null) {
        return `无法解析持续时间: "${lasting}"（如 '1y2M3d4h5m6s'）`;
      }
      until = Date.now() + ms;
    }

    if (isGlobal) {
      if (until) {
        setGlobalTempPermission(permission, bool, until);
        return `已设置全局临时权限 ${permission}=${bool}，持续 ${lasting}，过期 ${new Date(until).toLocaleString()}`;
      }
      setGlobalPermission(permission, bool);
      return `已设置全局权限 ${permission}=${bool}`;
    }

    if (until) {
      setTempPermission(user, permission, bool, until);
      return `已设置 ${user} 的临时权限 ${permission}=${bool}，持续 ${lasting}，过期 ${new Date(until).toLocaleString()}`;
    }
    setPermission(user, permission, bool);
    return `已设置 ${user} 的权限 ${permission}=${bool}`;
  }

  // ---- unset ----
  if (isGlobal) {
    clearGlobalTempPermission(permission);
    clearGlobalPermission(permission);
    return `已清除全局权限 ${permission}`;
  }
  clearTempPermission(user, permission);
  clearPermission(user, permission);
  return `已清除 ${user} 的权限 ${permission}`;
}
cmd.meta = {
  usage: "permission <set|unset> <user|*> <perm> [true|false] [lasting]",
  description: "控制权限"
}

/**
 * 解析持续时间字符串，如 '1y2M3d4h5m6s'。
 * 单位（区分大小写）：y=年，M=月，d=天，h=时，m=分，s=秒。
 * @param {string} input 持续时间，如 '1y'、'2h30m'、'1y2M3d4h5m6s'
 * @returns {number|null} 对应的毫秒数；无法解析返回 null
 */
function parseDuration(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;

  const UNIT_MS = {
    y: 365 * 24 * 60 * 60 * 1000,   // 年（按 365 天计）
    M: 30 * 24 * 60 * 60 * 1000,    // 月（按 30 天计）
    d: 24 * 60 * 60 * 1000,         // 天
    h: 60 * 60 * 1000,              // 时
    m: 60 * 1000,                   // 分
    s: 1000,                        // 秒
  };

  // 至少一段 "数字+单位"，可重复拼接；单位仅限定 y/M/d/h/m/s，不允许空段
  if (!/^(\d+(?:[yMdhm]|s))+$/.test(s)) return null;

  let total = 0;
  const re = /(\d+)(?:([yMdhm])|(s))/g;
  let m;
  while ((m = re.exec(s))) {
    const unit = m[2] || m[3];
    total += Number(m[1]) * UNIT_MS[unit];
  }
  return total;
}

/**
 * 注册权限管理与控制命令
 * @apiNote 由组合根在 commandServer 就绪后调用，避免循环依赖
 * @param {(namespace: string, name: string, handler: Function, meta?: import('./commandInterface.js').CommandRegisterOptions) => void} registerCommand 命令注册函数（commandServer.registerCommand）
 */
function installPermissionCommands(registerCommand) {
  registerCommand('neonaic', 'permission', cmd, {
    permissions: [[neonaicCommandInterface.COMMAND_ENUMS.PERM_SUPERADMIN, "neonaic.command.permission"]],
    description: cmd.meta.description,
    usage: cmd.meta.usage,
    alias: ["perm"]
  });
  registerCommand('neonaic', 'whoami', function () {
    const LEFT_CHAR_IF_HIDDING_RATE = .4;
    /** @type { import('./commandServer.js').NeonaicCommandContext } */
    const ctx = this;
    const singalExecutor = (ctx.executor instanceof Array) ? (ctx.executor.length > 0) ? ctx.executor[0] : undefined : ctx.executor;
    let result = '';
    if (ctx.privateExecutor) {
      // 非公开场景
      result += `你正以“${singalExecutor}”的身份执行命令，具备上下文：${parseString(ctx.executor)}\n`;
    } else {
      // 公开场景，模糊化一些信息
      const blurredExecutor = ctx.executor.map((v) => blurText(v, 5, 1, LEFT_CHAR_IF_HIDDING_RATE));
      result += `你正以“${blurText(singalExecutor, 5, 1, LEFT_CHAR_IF_HIDDING_RATE)}”的身份执行命令，具备上下文：${parseString(blurredExecutor)}。\n`;
      result += `当前上下文不是私密的，已自动抹去一些隐私信息。\n`;
    }

    result += (checkPermission(singalExecutor, neonaicCommandInterface.COMMAND_ENUMS.PERM_ADMIN)) ? "✓ 你的身份是管理员\n" : "× 你的身份不是管理员\n";
    result += (checkPermission(singalExecutor, neonaicCommandInterface.COMMAND_ENUMS.PERM_SUPERADMIN)) ? "✓ 你的身份是超级管理员\n" : "× 你的身份不是超级管理员\n";
    if (ctx.internalCall) {
      result += "✓ 你的上下文可以无视大部分权限检查";
    } else {
      result += (checkPermissionFromContext(ctx, neonaicCommandInterface.COMMAND_ENUMS.PERM_ADMIN)) ? "✓ 你的上下文是管理员\n" : "× 你的上下文不是管理员\n";
      result += (checkPermissionFromContext(ctx, neonaicCommandInterface.COMMAND_ENUMS.PERM_SUPERADMIN)) ? "✓ 你的上下文是超级管理员\n" : "× 你的上下文不是超级管理员\n";
    }
    return result;
  }, {
    description: "查询当前上下文身份以及特权令牌",
  });
}

/**
 * 模糊文本
 * @param {String} [origin=""] 原文本
 * @param {number} [keptStart=1] 开头保留数量
 * @param {number} [keptEnd=1] 结尾保留数量
 * @param {number} [castRate=.6] 被屏蔽文本的数量，最终中间*号的个数是原文本数量乘以本数值并向上取整
 * @returns {String} 模糊后的文本。如果原文本长度太短不会模糊。
 */
function blurText(origin = "", keptStart = 1, keptEnd = 1, castRate = 0.6) {
  if (typeof origin !== 'string') origin = parseString(origin);
  if (origin.length <= (keptEnd + keptStart)) return origin;

  const [start, end, middle] = [origin.slice(0, keptStart), origin.slice(-keptEnd), origin.slice(keptStart, -keptEnd)];
  return start + '*'.repeat(Math./* 理论上这里不会小于1，但是防御一下使意图明确 */max(Math.ceil(middle.length * castRate), 1)) + end;
}

export const neonaicPermissionServer = {
  checkSinglePermission,
  checkPermission,
  checkPermissionFromContext,
  setPermission,
  setTempPermission,
  setGlobalPermission,
  setGlobalTempPermission,
  clearPermission,
  clearTempPermission,
  clearGlobalPermission,
  clearGlobalTempPermission,
  parseDuration,
  installPermissionCommands,
};
