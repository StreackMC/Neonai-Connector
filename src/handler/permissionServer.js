/**
 * permissionServer.js — 4 层权限系统
 *
 * 优先级（高 → 低）：
 *   临时权限 > 永久权限 > 全局临时权限 > 全局权限
 *   四层互不冲突，高层覆盖低层。未显式设置时向上继承。
 *
 * 执行者链：["USR#xxx", "GRP#xxx"]
 *   最左侧最近，最后总隐式接 global ("*")。
 *   权限检查从最近开始，未设置时顺次向上继承。
 */

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
 */
export function setPermission(user, permission, status = true) {
  if (!user || !permission) return 'invail_user';
  const map = ensure('permanent', user);
  map[permission] = !!status;
  return 'successfully';
}

/**
 * 设置临时权限。
 * @param {string|string[]} user
 * @param {string} permission
 * @param {boolean} [status=true]
 * @param {number|Date} [until] 过期时间（时间戳 ms 或 Date）
 */
export function setTempPermission(user, permission, status = true, until) {
  if (!user || !permission) return 'invail_user';
  const map = ensure('temp', user);
  const ts = until instanceof Date ? until.getTime() : (typeof until === 'number' ? until : 0);
  map[permission] = { status: !!status, until: ts || 0 };
  return 'successfully';
}

/**
 * 设置全局权限。
 * @param {string} permission
 * @param {boolean} [status=true]
 */
export function setGlobalPermission(permission, status = true) {
  if (!permission) return 'invaild_perm';
  store.global.set(permission, !!status);
  return 'successfully';
}

/**
 * 设置全局临时权限。
 * @param {string} permission
 * @param {boolean} [status=true]
 * @param {number|Date} [until]
 */
export function setGlobalTempPermission(permission, status = true, until) {
  if (!permission) return 'invaild_perm';
  const ts = until instanceof Date ? until.getTime() : (typeof until === 'number' ? until : 0);
  store.globalTemp.set(permission, { status: !!status, until: ts || 0 });
  return 'successfully';
}

// ---- 清除 ----

export function clearPermission(user, permission) {
  if (!user) return 'invail_user';
  const key = userKey(user);
  if (permission === '*') {
    store.permanent.delete(key);
    return 'successfully';
  }
  const map = store.permanent.get(key);
  if (map) delete map[permission];
  return 'successfully';
}

export function clearTempPermission(user, permission, until = -1) {
  if (!user) return 'invail_user';
  const key = userKey(user);
  if (permission === '*') {
    store.temp.delete(key);
    return 'successfully';
  }
  const map = store.temp.get(key);
  if (map) {
    if (until !== -1 && map[permission]?.until && map[permission].until > until) return 'successfully';
    delete map[permission];
  }
  return 'successfully';
}

export function clearGlobalPermission(permission) {
  if (permission === '*') { store.global.clear(); return 'successfully'; }
  store.global.delete(permission);
  return 'successfully';
}

export function clearGlobalTempPermission(permission, until = -1) {
  if (permission === '*') { store.globalTemp.clear(); return 'successfully'; }
  if (until !== -1) {
    const v = store.globalTemp.get(permission);
    if (v?.until && v.until > until) return 'successfully';
  }
  store.globalTemp.delete(permission);
  return 'successfully';
}
