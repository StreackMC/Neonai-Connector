/**
 * src/identity.js — MC 身份 ↔ 聊天身份 的绑定表（协议 V2 `identity.*`）
 *
 * ── 它解决什么 ──
 * MC 侧的玩家（`{ name, uuid }`）与聊天侧的账号（如 `qUSR#<openid>@<botid>`）是两套互不相干的
 * 标识空间。绑定表记录「这个聊天账号 = 那个 MC 玩家」，于是：
 *   - 出站 `chat.publish` 时可以按 MC 身份刷新玩家名快照（玩家改名后显示不失真）；
 *   - 入站 `chat.broadcast` 时把来源换成 MC 玩家名（已绑定）而不是聊天昵称（未绑定）；
 *   - `identity.resolve` / `identity.unbind` 按 MC 身份查询与解除。
 *
 * ── 为什么以「聊天标识」为键 ──
 * 权威持有方在本端（Joyous 只持一次性代码），而**查询方向有三种**：
 * 按聊天标识查（内播）、按 MC 身份查（resolve / unbind）、按 UUID 批量刷新（改名保鲜）。
 * 以 `chatId` 为键最贴合「一个聊天账号绑定一个 MC 玩家」的语义，也让同一玩家可以
 * 绑定多个聊天账号（多端/多平台）而不互相覆盖；其余两个方向由遍历 + 索引得出。
 *
 * ── 为什么放拓展内、而不是内核的用户名录 ──
 * 内核的 {@link import('../../../src/message/userDirectory.js').neonaicUserDirectory} 解决的是
 * 「**一个**标识 → 人话」的单向翻译；而绑定表解决的是「**两个**平台标识之间的对应关系」，
 * 它只在同时认识 MC 与聊天两侧的 joyous 拓展里才有意义 ⇒ 属于拓展自身的数据。
 *
 * ── 存储 ──
 * `config/saves/joyous-identities.json`（JSON5）：
 * ```json
 * { "<profile>": { "<chatId>": { "uuid": "…", "name": "Steve", "boundAt": 1730000000000 } } }
 * ```
 * 该目录被 `.gitignore` 忽略，因此真实身份不会进入版本库。
 */

import JSON5 from 'json5';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getLogger } from '#/logger/Logger.js';
import { parseString } from '#/utils/chore.js';
import { NeonaicIllegalArgumentError } from '#/utils/NeonaicNewableError.js';
import { neonaicLifeCycleManager } from '#/system/lifeCycleManager.js';

// 本模块自算项目根路径，避免与组合根形成循环依赖
// identity.js 位于 <根>/extensions/joyous/src/，故向上 3 层为项目根
const ROOT_PATH = neonaicLifeCycleManager.ROOT_PATH;
const FILE = resolve(ROOT_PATH, 'config/saves/joyous-identities.json');

/**
 * 一条绑定记录。
 * @typedef {object} IdentityBinding
 * @property {string} chatId 聊天侧标识（如 `qUSR#…@…`）
 * @property {string|null} uuid MC 玩家 UUID；拿不到时为 null（此时只能按名字匹配）
 * @property {string} name MC 玩家名快照（会随 `chat.publish` 的聊天流保鲜）
 * @property {number} boundAt 绑定时刻（毫秒）
 */

/** 内存态绑定表：profile → (chatId → 绑定记录) @type {Map<string, Map<string, IdentityBinding>>} */
const store = new Map();

/** 是否已尝试从磁盘加载过 */
let _loaded = false;

// ---- 磁盘 ----

/** 从磁盘载入（只在首次调用前自动执行一次） */
function load() {
  if (_loaded) return;
  _loaded = true;
  if (!existsSync(FILE)) return;

  let raw;
  try {
    raw = JSON5.parse(readFileSync(FILE, 'utf8'));
  } catch (e) {
    // 文件损坏不应让桥接崩掉：当作空表继续，只留下告警
    getLogger().other.warn(`[joyous/identity] 无法解析 ${FILE}，已按空绑定表继续：${e?.message ?? e}`);
    return;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;

  for (const [profile, section] of Object.entries(raw)) {
    if (!section || typeof section !== 'object' || Array.isArray(section)) continue;
    const bucket = new Map();
    for (const [chatId, entry] of Object.entries(section)) {
      const normalized = normalizeBinding(chatId, entry);
      if (normalized) bucket.set(String(chatId), normalized);
    }
    if (bucket.size) store.set(String(profile), bucket);
  }
}

/** 强制重新从磁盘载入（丢弃内存态） */
function reload() {
  _loaded = false;
  store.clear();
  load();
}

/** 把内存态写回磁盘 */
function save() {
  const out = {};
  for (const [profile, bucket] of store) {
    if (!bucket.size) continue;
    const section = {};
    for (const [chatId, entry] of bucket) {
      section[chatId] = {
        uuid: entry.uuid,
        name: entry.name,
        boundAt: entry.boundAt,
      };
    }
    out[profile] = section;
  }
  // 与 permissionServer / userDirectory 一致：JSON.stringify 能正确转义孤立代理项
  const json = JSON.stringify(out, null, 2)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  writeFileSync(FILE, `${json}\n`, 'utf8');
}

// ---- 归一化 ----

/**
 * 归一化一条绑定记录。chatId 为空视为无效。
 * @param {string} chatId
 * @param {object|string|null|undefined} raw
 * @returns {IdentityBinding|null}
 */
function normalizeBinding(chatId, raw) {
  const key = parseString(chatId ?? '').trim();
  if (!key) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const uuid = parseString(raw.uuid ?? '').trim();
  const binding = {
    chatId: key,
    uuid: uuid || null,
    name: parseString(raw.name ?? '').trim(),
    boundAt: Number.isFinite(Number(raw.boundAt)) ? Number(raw.boundAt) : 0,
  };
  // 没有 uuid 又没有名字，这条记录毫无用处
  if (!binding.uuid && !binding.name) return null;
  return binding;
}

/** 归一化 MC 身份入参 @param {object|string|null|undefined} mc @returns {{uuid: string, name: string}} */
function normalizeMc(mc) {
  if (typeof mc === 'string') return { uuid: '', name: parseString(mc).trim() };
  if (!mc || typeof mc !== 'object') return { uuid: '', name: '' };
  return {
    uuid: parseString(mc.uuid ?? '').trim(),
    name: parseString(mc.name ?? '').trim(),
  };
}

/**
 * 记录是否对应某个 MC 身份。
 * @apiNote **有 uuid 就只认 uuid**（玩家改名不失效）；只有拿不到 uuid 时才退回按名字匹配
 *          （名字匹配忽略大小写，MC 的名字本就不区分大小写）。
 * @param {IdentityBinding} binding
 * @param {{uuid: string, name: string}} mc
 * @returns {boolean}
 */
function matchesMc(binding, mc) {
  if (mc.uuid) return binding.uuid === mc.uuid;
  if (!mc.name || !binding.name) return false;
  return binding.name.toLowerCase() === mc.name.toLowerCase();
}

/** @param {string} profile @returns {string} @throws {NeonaicIllegalArgumentError} */
function requireProfile(profile) {
  const key = parseString(profile ?? '').trim();
  if (!key) throw new NeonaicIllegalArgumentError('identity 相关方法的 profile 不能为空');
  return key;
}

// ---- 写入 ----

/**
 * 建立/更新绑定（以 chatId 为键，同一聊天账号只会有一条）。
 * @param {string} profile
 * @param {{ name?: string, uuid?: string }|string} mc MC 身份
 * @param {string} chatId 聊天侧标识
 * @returns {IdentityBinding} 生效后的记录
 * @throws {NeonaicIllegalArgumentError} 任一参数不合法
 */
function bind(profile, mc, chatId) {
  const key = requireProfile(profile);
  const chat = parseString(chatId ?? '').trim();
  if (!chat) throw new NeonaicIllegalArgumentError('identity.bind 需要一个非空的 chatId');

  const identity = normalizeMc(mc);
  if (!identity.uuid && !identity.name) {
    throw new NeonaicIllegalArgumentError('identity.bind 需要一个带 uuid 或 name 的 MC 身份');
  }

  const entry = {
    chatId: chat,
    uuid: identity.uuid || null,
    name: identity.name,
    boundAt: Date.now(),
  };

  load();
  if (!store.has(key)) store.set(key, new Map());
  store.get(key).set(chat, entry);
  save();
  return entry;
}

/**
 * 玩家改名后刷新名称快照（PROTOCOL-V2 §5.7.4）。
 * @apiNote 跨 profile 刷新：名字是**玩家自身**的属性，与消息从哪个 profile 来无关。
 * @param {string} uuid MC 玩家 UUID
 * @param {string} name 最新玩家名
 * @returns {number} 被更新的记录数
 */
function refreshNameByUuid(uuid, name) {
  const id = parseString(uuid ?? '').trim();
  const fresh = parseString(name ?? '').trim();
  if (!id || !fresh) return 0;

  load();
  let touched = 0;
  for (const bucket of store.values()) {
    for (const entry of bucket.values()) {
      if (entry.uuid !== id || entry.name === fresh) continue;
      entry.name = fresh;
      touched++;
    }
  }
  if (touched) save();
  return touched;
}

// ---- 查询 ----

/**
 * 按 MC 身份查绑定（`identity.resolve`）。
 * @param {string} profile
 * @param {{ name?: string, uuid?: string }|string} mc
 * @returns {IdentityBinding|null}
 */
function resolveByMc(profile, mc) {
  const key = parseString(profile ?? '').trim();
  if (!key) return null;
  const identity = normalizeMc(mc);
  if (!identity.uuid && !identity.name) return null;
  load();
  for (const entry of store.get(key)?.values() ?? []) {
    if (matchesMc(entry, identity)) return entry;
  }
  return null;
}

/**
 * 按聊天标识查绑定（内播时把来源换成 MC 玩家名，PROTOCOL-V2 §5.3.1）。
 * @param {string} profile
 * @param {string} chatId
 * @returns {IdentityBinding|null}
 */
function resolveByChatId(profile, chatId) {
  const key = parseString(profile ?? '').trim();
  const chat = parseString(chatId ?? '').trim();
  if (!key || !chat) return null;
  load();
  return store.get(key)?.get(chat) ?? null;
}

/**
 * 跨 profile 查某个聊天标识的全部绑定（`/joyous:bind clear` 用）。
 * @param {string} chatId
 * @returns {Array<{ profile: string } & IdentityBinding>}
 */
function findByChatId(chatId) {
  const chat = parseString(chatId ?? '').trim();
  if (!chat) return [];
  load();
  const out = [];
  for (const [profile, bucket] of store) {
    const entry = bucket.get(chat);
    if (entry) out.push({ profile, ...entry });
  }
  return out;
}

/**
 * 列出绑定。
 * @param {string} [profile] 省略时列出全部 profile
 * @returns {Array<{ profile: string } & IdentityBinding>}
 */
function list(profile) {
  load();
  const key = parseString(profile ?? '').trim();
  const profiles = key ? [key] : [...store.keys()];
  const out = [];
  for (const name of profiles) {
    for (const entry of store.get(name)?.values() ?? []) {
      out.push({ profile: name, ...entry });
    }
  }
  return out;
}

/** 条目总数 @returns {number} */
function size() {
  load();
  let total = 0;
  for (const bucket of store.values()) total += bucket.size;
  return total;
}

// ---- 解除 ----

/**
 * 解除某个 MC 身份的全部绑定（`identity.unbind`）。
 * @param {{ name?: string, uuid?: string }|string} mc
 * @param {string} [profile] 省略表示全部 profile
 * @returns {string[]} 被解除的聊天标识列表（**空数组不是错误**）
 */
function unbindByMc(mc, profile) {
  const identity = normalizeMc(mc);
  if (!identity.uuid && !identity.name) return [];

  load();
  const key = parseString(profile ?? '').trim();
  const profiles = key ? [key] : [...store.keys()];
  const removed = [];

  for (const name of profiles) {
    const bucket = store.get(name);
    if (!bucket) continue;
    for (const [chatId, entry] of [...bucket]) {
      if (!matchesMc(entry, identity)) continue;
      bucket.delete(chatId);
      removed.push(chatId);
    }
    if (!bucket.size) store.delete(name);
  }
  if (removed.length) save();
  return removed;
}

/**
 * 按聊天标识解除绑定（`/joyous:bind clear`：移除调用者自己）。
 * @param {string} chatId
 * @param {string} [profile] 省略表示全部 profile
 * @returns {string[]} 被解除的聊天标识（同一 chatId 可能出现在多个 profile）
 */
function removeByChatId(chatId, profile) {
  const chat = parseString(chatId ?? '').trim();
  if (!chat) return [];
  load();
  const key = parseString(profile ?? '').trim();
  const profiles = key ? [key] : [...store.keys()];
  const removed = [];

  for (const name of profiles) {
    const bucket = store.get(name);
    if (!bucket?.delete(chat)) continue;
    removed.push(chat);
    if (!bucket.size) store.delete(name);
  }
  if (removed.length) save();
  return removed;
}

export const joyousIdentity = Object.freeze({
  FILE,
  load,
  reload,
  save,
  bind,
  refreshNameByUuid,
  // 导出名避开 node:path 的 `resolve`，对外语义仍是「按 MC 身份解析出绑定」
  resolve: resolveByMc,
  resolveByMc,
  resolveByChatId,
  findByChatId,
  unbindByMc,
  removeByChatId,
  list,
  size,
});
