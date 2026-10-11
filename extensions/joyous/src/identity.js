/**
 * src/identity.js — MC 身份 ↔ 聊天身份 的绑定表（协议 V2 `identity.bind` / `identity.resolve`）
 *
 * ── 它解决什么 ──
 * MC 侧的玩家（`{ name, uuid }`）与聊天侧的账号（如 `qUSR#<openid>@<botid>`）是两套互不相干的
 * 标识空间。绑定表记录「这个 MC 玩家 = 那个聊天账号」，于是：
 *   - `identity.resolve` 能在渲染外部消息时补全显示名；
 *   - 将来做「私聊定向内播」（`chat.broadcast` 的 `visibility: "private"` + `target`）时，能被反查。
 *
 * ── 为什么放拓展内、而不是内核的用户名录 ──
 * 内核的 {@link import('../../../src/message/userDirectory.js').neonaicUserDirectory} 解决的是
 * 「**一个**标识 → 人话」的单向翻译；而绑定表解决的是「**两个**平台标识之间的对应关系」，
 * 它只在同时认识 MC 与聊天两侧的 joyous 拓展里才有意义 ⇒ 属于拓展自身的数据。
 * 需要给人/模型看的可读名仍写在名录里（本表只存 `chatId`，不重复存名字）。
 *
 * ── 存储 ──
 * `config/saves/joyous-identities.json`（JSON5）。该目录被 `.gitignore` 忽略，
 * 因此真实身份不会进入版本库。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSON5 from 'json5';

import { parseString } from '../../../src/utils/chore.js';
import { getLogger } from '../../../src/logger/Logger.js';
import { NeonaicIllegalArgumentError } from '../../../src/utils/NeonaicNewableError.js';

// 本模块自算项目根路径，避免与组合根形成循环依赖
// identity.js 位于 <根>/extensions/joyous/src/，故向上 3 层为项目根
const ROOT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const FILE = resolve(ROOT_PATH, 'config/saves/joyous-identities.json');

/**
 * 一条绑定记录。
 * @typedef {object} IdentityBinding
 * @property {string} chatId 聊天侧标识（如 `qUSR#...@...`）
 * @property {string} [name] 绑定当时的 MC 玩家名（仅作展示快照，权威来源始终是 MC 侧）
 * @property {number} boundAt 绑定时刻（毫秒）
 */

/** 内存态绑定表：profile → (mcKey → 绑定记录) @type {Map<string, Map<string, IdentityBinding>>} */
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
    for (const [key, entry] of Object.entries(section)) {
      const normalized = normalizeBinding(entry);
      if (normalized) bucket.set(String(key), normalized);
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
    // 逐条重建普通对象；键名用 MC 侧 uuid（缺失时退回名字）
    const section = {};
    for (const [key, entry] of bucket) {
      section[key] = entry.name
        ? { name: entry.name, chatId: entry.chatId, boundAt: entry.boundAt }
        : { chatId: entry.chatId, boundAt: entry.boundAt };
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
 * 归一化一条绑定记录。`chatId` 为空视为无效。
 * @param {object|string|null|undefined} raw
 * @returns {IdentityBinding|null}
 */
function normalizeBinding(raw) {
  if (typeof raw === 'string') {
    const chatId = raw.trim();
    return chatId ? { chatId, boundAt: 0 } : null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const chatId = parseString(raw.chatId ?? '').trim();
  if (!chatId) return null;

  const binding = { chatId, boundAt: Number.isFinite(Number(raw.boundAt)) ? Number(raw.boundAt) : 0 };
  const name = parseString(raw.name ?? '').trim();
  if (name) binding.name = name;
  return binding;
}

/**
 * 取 MC 身份在表中的键。
 * @apiNote **以 uuid 为准**（玩家改名后绑定不失效）；只有拿不到 uuid 时才退回名字。
 * @param {object|null|undefined} mc
 * @returns {string} 空串表示身份不合法
 */
function mcKeyOf(mc) {
  if (typeof mc === 'string') return mc.trim();
  if (!mc || typeof mc !== 'object') return '';
  const uuid = parseString(mc.uuid ?? '').trim();
  if (uuid) return uuid;
  return parseString(mc.name ?? '').trim();
}

// ---- 读写 ----

/**
 * 建立绑定（已存在则覆盖）。
 * @param {string} profile Joyous 侧的 profile 键
 * @param {{ name?: string, uuid?: string }|string} mc MC 身份
 * @param {string} chatId 聊天侧标识
 * @returns {IdentityBinding} 生效后的记录
 * @throws {NeonaicIllegalArgumentError} 任一参数不合法
 */
function bind(profile, mc, chatId) {
  const key = requireProfile(profile);
  const mcKey = mcKeyOf(mc);
  if (!mcKey) throw new NeonaicIllegalArgumentError('identity.bind 需要一个带 uuid 或 name 的 MC 身份');
  const chat = parseString(chatId ?? '').trim();
  if (!chat) throw new NeonaicIllegalArgumentError('identity.bind 需要一个非空的 chatId');

  const name = (mc && typeof mc === 'object' ? parseString(mc.name ?? '') : '').trim();
  const entry = { chatId: chat, boundAt: Date.now() };
  if (name) entry.name = name;

  load();
  if (!store.has(key)) store.set(key, new Map());
  store.get(key).set(mcKey, entry);
  save();
  return entry;
}

/**
 * 查询绑定。
 * @param {string} profile
 * @param {{ name?: string, uuid?: string }|string} mc
 * @returns {IdentityBinding|null}
 */
function resolveByMc(profile, mc) {
  const key = parseString(profile ?? '').trim();
  if (!key) return null;
  const mcKey = mcKeyOf(mc);
  if (!mcKey) return null;
  load();
  return store.get(key)?.get(mcKey) ?? null;
}

/**
 * 解除绑定。
 * @param {string} profile
 * @param {{ name?: string, uuid?: string }|string} mc
 * @returns {boolean} 是否确实解除了
 */
function unbind(profile, mc) {
  const key = parseString(profile ?? '').trim();
  const mcKey = mcKeyOf(mc);
  if (!key || !mcKey) return false;
  load();
  const bucket = store.get(key);
  if (!bucket || !bucket.delete(mcKey)) return false;
  if (!bucket.size) store.delete(key);
  save();
  return true;
}

/**
 * 按聊天标识反查（用于展示，以及将来把外部私聊定向投递给对应玩家）。
 * @param {string} profile
 * @param {string} chatId
 * @returns {({ mcKey: string } & IdentityBinding)|null}
 */
function resolveByChatId(profile, chatId) {
  const key = parseString(profile ?? '').trim();
  const chat = parseString(chatId ?? '').trim();
  if (!key || !chat) return null;
  load();
  for (const [mcKey, entry] of store.get(key) ?? []) {
    if (entry.chatId === chat) return { mcKey, ...entry };
  }
  return null;
}

/**
 * 列出绑定。
 * @param {string} [profile] 省略时列出全部 profile
 * @returns {Array<{ profile: string, mcKey: string } & IdentityBinding>}
 */
function list(profile) {
  load();
  const key = parseString(profile ?? '').trim();
  const profiles = key ? [key] : [...store.keys()];
  const out = [];
  for (const name of profiles) {
    for (const [mcKey, entry] of store.get(name) ?? []) {
      out.push({ profile: name, mcKey, ...entry });
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

/**
 * @param {string} profile
 * @returns {string}
 * @throws {NeonaicIllegalArgumentError} profile 为空
 */
function requireProfile(profile) {
  const key = parseString(profile ?? '').trim();
  if (!key) throw new NeonaicIllegalArgumentError('identity 相关方法的 profile 不能为空');
  return key;
}

export const joyousIdentity = Object.freeze({
  FILE,
  load,
  reload,
  save,
  bind,
  // 导出名避开 node:path 的 `resolve`，对外语义仍是「解析出绑定」
  resolve: resolveByMc,
  resolveByChatId,
  unbind,
  list,
  size,
  mcKeyOf,
});
