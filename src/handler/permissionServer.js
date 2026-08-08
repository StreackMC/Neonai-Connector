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
 * 测试用户是否有指定权限。
 * @param {string|string[]|null} user 用户标识，null/空 → global ("*")。
 *   string[] 时从左到右检查，未设时继承下一级。
 * @param {string} permission 权限名。"*" 始终返回 false。
 * @returns {boolean|null} boolean: 明确结果 | null: 所有层级均未设置
 */
export function checkPermission(user, permission) {
  if (!permission || permission === '*') return false;

  // 数组 → 逐级检查，未设时继承
  if (Array.isArray(user)) {
    for (let i = 0; i < user.length; i++) {
      const r = _checkSingle(user[i], permission);
      if (r !== null) return r;
    }
    // 最后 Fallback → global
    return _checkSingle('*', permission);
  }

  // 单用户
  return _checkSingle(user || '*', permission);
}

/**
 * 测试上下文是否有指定权限。
 * @param {import('./commandServer.js').CommandContext} ctx 上下文
 * @param {string} permission 权限名。"*" 始终返回 false。
 * @returns {boolean|null} boolean: 明确结果 | null: 所有层级均未设置
 */
export function checkPermissionFromContext(ctx, permission) {
  if (ctx?.internalCall) return true;
  return checkPermission(ctx?.executor, permission);
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
 * @returns {'invaild_user'|'successfully'}
 */
export function setPermission(user, permission, status = true) {
  if (!user || !permission) return 'invaild_user';
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
 * @returns {'invaild_user'|'successfully'}
 */
export function setTempPermission(user, permission, status = true, until) {
  if (!user || !permission) return 'invaild_user';
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
 * @returns {'invaild_perm'|'successfully'}
 */
export function setGlobalPermission(permission, status = true) {
  if (!permission) return 'invaild_perm';
  store.global.set(permission, !!status);
  _save();
  return 'successfully';
}

/**
 * 设置全局临时权限。
 * @param {string} permission
 * @param {boolean} [status=true]
 * @param {number|Date} [until]
 * @returns {'invaild_user'|'successfully'}
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
 * @returns {'invail_user'|'successfully'}
 */
export function clearPermission(user, permission) {
  if (!user) return 'invail_user';
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
 * @returns {'invail_user'|'successfully'}
 */
export function clearTempPermission(user, permission, until = -1) {
  if (!user) return 'invail_user';
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
// 权限管理命令由 commandServer 方调用 permissionServer API；此处仅实现功能。
// function cmd(param) { }
// registerCommand('permission', cmd)