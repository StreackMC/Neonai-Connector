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
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSON5 from 'json5';
import { parseString } from '../system/logger/logger.js';

// 注：本模块不 import commandServer.js，避免循环依赖。
// 权限命令由组合根（entry.js）通过 installPermissionCommands(registerCommand) 安装。

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PERM_FILE = resolve(ROOT, 'config/permissions.json');

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
  writeFileSync(PERM_FILE, JSON5.stringify(out, null, 2), 'utf8');
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

/**
 * 检查用户对单条权限（无 AND/OR）的原始结果。
 * @returns {boolean|null}
 */
function _test(user, permission) {
  if (Array.isArray(user)) {
    for (let i = 0; i < user.length; i++) {
      const r = _checkSingle(user[i], permission);
      if (r !== null) return r;
    }
    return _checkSingle('*', permission);
  }
  return _checkSingle(user || '*', permission);
}

/**
 * 检查单条权限（支持 "!" 否定前缀）。
 * 供 commandServer 等复用，统一否定语义。
 * @returns {boolean} true = 通过
 */
export function checkSinglePermission(user, permission) {
  const isNegate = permission.startsWith('!');
  const name = isNegate ? permission.slice(1) : permission;
  if (!name || name === '*') return false;
  const has = _test(user, name);
  return isNegate ? has !== true : has === true;
}

/**
 * 测试用户是否满足权限规则（支持 AND/OR 嵌套）。
 * @param {string|string[]|null} user 用户标识
 * @param {string|(string|string[])[]} permission 权限规则
 *   - 字符串 → 单条（支持 "!" 否定）
 *   - 数组 → 外层 AND，内层 OR
 * @returns {boolean|null}
 *   true/false: 明确结果 | null: 所有层级均未设置（仅单条查询时）
 */
export function checkPermission(user, permission) {
  if (!permission || permission === '*') return false;

  // AND/OR 嵌套语法
  if (Array.isArray(permission)) {
    for (const item of permission) {
      if (Array.isArray(item)) {
        // OR 组：至少一项通过
        if (!item.some((p) => checkSinglePermission(user, p))) return false;
      } else {
        // AND 项：必须通过
        if (!checkSinglePermission(user, item)) return false;
      }
    }
    return true;
  }

  // 单条字符串
  return _test(user, permission);
}

/**
 * 测试命令上下文是否满足权限规则。
 * CLI/internalCall 始终返回 true。
 * @param {import('./commandServer.js').CommandContext} ctx
 * @param {string|(string|string[])[]} permission
 * @returns {boolean}
 */
export function checkPermissionFromContext(ctx, permission) {
  if (ctx?.internalCall) return true;
  const result = checkPermission(ctx?.executor, permission);
  return result === true;
}

/** 对单用户检查 4 层权限 */
function _checkSingle(user, permission) {
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

  return null; // 所有层级未设置
}

// ---- 设置 ----

/**
 * 设置权限。
 * @param {string|string[]} user
 * @param {string} permission
 * @param {boolean} [status=true]
 * @returns {'invalid_user'|'successfully'}
 */
export function setPermission(user, permission, status = true) {
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
export function setTempPermission(user, permission, status = true, until) {
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
export function setGlobalPermission(permission, status = true) {
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
export function setGlobalTempPermission(permission, status = true, until) {
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
export function clearPermission(user, permission) {
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
export function clearTempPermission(user, permission, until = -1) {
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
export function clearGlobalPermission(permission) {
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
export function clearGlobalTempPermission(permission, until = -1) {
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
 * @this {import('./commandServer.js').CommandContext}
 * @returns {string} 执行结果描述
 */
function cmd(type, user, permission, status, lasting) {
  /** @type {import('./commandServer.js').CommandContext} */
  const ctx = this;

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

/**
 * 解析持续时间字符串，如 '1y2M3d4h5m6s'。
 * 单位（区分大小写）：y=年，M=月，d=天，h=时，m=分，s=秒。
 * @param {string} input 持续时间，如 '1y'、'2h30m'、'1y2M3d4h5m6s'
 * @returns {number|null} 对应的毫秒数；无法解析返回 null
 */
export function parseDuration(input) {
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
 * @param {(namespace: string, name: string, handler: Function, meta?: import('./commandServer.js').CommandRegisterOptions) => void} registerCommand 命令注册函数（commandServer.registerCommand）
 */
export function installPermissionCommands(registerCommand) {
  registerCommand('neonaic', 'permission', cmd, {
    permissions: [["superadmin", "neonaic.command.permission"]],
    description: "控制权限",
    usage: "permission <set|unset> <user|*> <perm> [true|false] [lasting]",
    alias: ["perm"]
  });
  registerCommand('neonaic', 'whoami', function () {
    /** @type {import('./commandServer.js').CommandContext} */
    const ctx = this;
    const singalExecutor = (ctx.executor instanceof Array) ? (ctx.executor.length > 0) ? ctx.executor[0] : undefined : ctx.executor;
    let result = '';
    if (ctx.privateExecutor) {
      // 非公开场景
      result += `你正以"${singalExecutor}"的身份执行命令，具备上下文：${parseString(ctx.executor)}\n\n`;
    } else {
      // 公开场景，模糊化一些信息
      const blurredExecutor = ctx.executor.map((v) => blurText(v, 5, 1));
      result += `你正以"${blurText(singalExecutor, 5, 1)}"的身份执行命令，具备上下文：${parseString(blurredExecutor)}\n\n`;
    }

    result += (checkPermission(singalExecutor, "admin")) ? "✓ 你的身份是管理员\n" : "× 你的身份不是管理员\n";
    result += (checkPermission(singalExecutor, "superadmin")) ? "✓ 你的身份是超级管理员\n" : "× 你的身份不是超级管理员\n";
    if (ctx.internalCall) {
      result += "✓ 你的上下文可以无视大部分权限检查";
    } else {
      result += (checkPermissionFromContext(ctx, "admin")) ? "✓ 你的上下文是管理员\n" : "× 你的上下文不是管理员\n";
      result += (checkPermissionFromContext(ctx, "superadmin")) ? "✓ 你的上下文是超级管理员\n" : "× 你的上下文不是超级管理员\n";
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
 * @param {number} [castRate=.6] 被屏蔽文本的保留数量，最终中间*号的个数是原文本数量乘以本数值并向上取整
 * @returns {String} 模糊后的文本。如果原文本长度太短不会模糊。
 */
function blurText(origin = "", keptStart = 1, keptEnd = 1, castRate = 0.6) {
  if (origin.length <= (keptEnd + keptStart)) return origin;
  if (typeof origin !== 'string') origin = parseString(origin);

  const [start, end, middle] = [origin.slice(keptStart), origin.slice(-keptEnd), origin.slice(keptStart + 1, keptEnd)];
  return start + '*'.repeat(Math.ceil(middle.length)) + end;
}