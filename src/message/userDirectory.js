/**
 * userDirectory.js — 用户名录：内部代号 → 人类可读身份
 *
 * ── 为什么需要它 ──
 * 平台侧的标识对模型而言是纯噪声：QQ 给的是 `USR#<32位openid>`、`GRP#<32位openid>`，
 * 模型看到它只会当作随机字符串。而 `askAI` 手上的 `caller` 链全是这种代号。
 * 名录把「机器代号 ↔ 人话」这层翻译集中到一处，供 AI 工具/提示词按需取用。
 *
 * ── 为什么放内核（而不是各平台的 profile）──
 * 判据是「会不会留下『本体只在某拓展存在时才有意义』的东西」：
 *   - 名录本身是**通用概念**：任何平台都面临「内部代号 vs 人类可读名」，
 *     内核只认识「一个字符串 → 一段可读描述」的字典，**不认识任何平台的 ID 形态** ⇒ 放内核。
 *   - 「某个平台怎么拿到名字」是**平台特定**的：QQ 用 openid、Minecraft 用 UUID ⇒ 放拓展
 *     （qqbot 会在群消息里自动登记 `group_name`，那是免费的；发送者昵称 QQ 官方接口不提供）。
 *
 * ── 存储 ──
 * `config/saves/identities.json`（JSON5）。写入是低频操作（仅命令/显式设置时），
 * 平台侧的自动登记走内存态（`persist: false`），不会每条消息都写盘。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSON5 from 'json5';

import { parseString } from '../utils/chore.js';
import { getLogger } from '../logger/Logger.js';
import { NeonaicIllegalArgumentError } from '../utils/NeonaicNewableError.js';

// 本模块自算项目根路径，避免与组合根形成循环依赖
// userDirectory.js 位于 <根>/src/message/，故向上 2 层为项目根
const ROOT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FILE = resolve(ROOT_PATH, 'config/saves/identities.json');

/**
 * 名录条目。
 * @typedef {object} DirectoryEntry
 * @property {string} name 可读名（必填）：昵称 / 群名
 * @property {string} [pronoun] 用户自己对称呼的性别偏好，自由文本（如 `'用「她」称呼'`）
 * @property {string} [note] 补充说明（如 `'群主'`）
 */

/** 内存态名录：code → 条目 @type {Map<string, DirectoryEntry>} */
const store = new Map();

/** 是否已尝试从磁盘加载过 */
let _loaded = false;

// ---- 磁盘 ----

/** 从磁盘载入（只在首次调用 get/set/list 前自动执行一次） */
function load() {
  if (_loaded) return;
  _loaded = true;
  if (!existsSync(FILE)) return;
  try {
    const raw = JSON5.parse(readFileSync(FILE, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [code, entry] of Object.entries(raw)) {
        const normalized = normalizeEntry(entry);
        if (normalized) store.set(String(code), normalized);
      }
    }
  } catch (e) {
    // 文件损坏不应让 AI 链路崩掉：当作空名录继续，只留下告警
    getLogger().other.warn(`[directory] 无法解析 ${FILE}，已按空名录继续：${e?.message ?? e}`);
  }
}

/** 强制重新从磁盘载入（丢弃内存中的临时条目） */
function reload() {
  _loaded = false;
  store.clear();
  load();
}

/** 把内存态写回磁盘 */
function save() {
  const out = Object.fromEntries(store);
  // 与 permissionServer 一致：JSON.stringify 能正确转义孤立代理项与 U+2028/2029
  const json = JSON.stringify(out, null, 2)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  writeFileSync(FILE, `${json}\n`, 'utf8');
}

// ---- 归一化与渲染 ----

/**
 * 归一化一个条目。字符串视为 `{ name }`；`name` 为空则视为无效。
 * @param {string|object|null|undefined} raw
 * @returns {DirectoryEntry|null}
 */
function normalizeEntry(raw) {
  if (typeof raw === 'string') {
    const name = raw.trim();
    return name ? { name } : null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const name = parseString(raw.name ?? '').trim();
  if (!name) return null;

  const entry = { name };
  const pronoun = parseString(raw.pronoun ?? '').trim();
  const note = parseString(raw.note ?? '').trim();
  if (pronoun) entry.pronoun = pronoun;
  if (note) entry.note = note;
  return entry;
}

/**
 * 渲染单条为「名（补充，补充）」。
 * @param {DirectoryEntry} entry
 * @returns {string}
 */
function renderEntry(entry) {
  if (!entry?.name) return '';
  const extras = [entry.pronoun, entry.note].filter(Boolean).join('，');
  return extras ? `${entry.name}（${extras}）` : entry.name;
}

/**
 * 归一化 code 入参为字符串数组。
 * @param {string|string[]|null|undefined} codes
 * @returns {string[]}
 */
function toCodeList(codes) {
  const arr = Array.isArray(codes) ? codes : (codes == null ? [] : [codes]);
  return arr.map((c) => parseString(c).trim()).filter(Boolean);
}

// ---- 查询 ----

/**
 * 取单条。
 * @param {string} code
 * @returns {DirectoryEntry|null}
 */
function get(code) {
  load();
  const key = parseString(code).trim();
  if (!key) return null;
  return store.get(key) ?? null;
}

/**
 * 列出全部（含内存态条目）。
 * @returns {Array<{ code: string, entry: DirectoryEntry }>}
 */
function list() {
  load();
  return [...store].map(([code, entry]) => ({ code, entry }));
}

/** 条目数量 @returns {number} */
function size() {
  load();
  return store.size;
}

// ---- 写入 ----

/**
 * 设置一条。
 * @param {string} code
 * @param {string|DirectoryEntry} info 可读描述；字符串等价于 `{ name }`
 * @param {object} [options]
 * @param {boolean} [options.persist=true] 是否写盘。平台侧自动登记建议传 `false`，避免每条消息写盘
 * @param {boolean} [options.overwrite=true] 已存在时是否覆盖。自动登记建议传 `false`，以免盖掉人工设置的名字
 * @returns {DirectoryEntry} 生效后的条目
 * @throws {NeonaicIllegalArgumentError} code 为空，或 info 无法归一化出 name
 */
function set(code, info, options = {}) {
  const { persist = true, overwrite = true } = options;
  const key = parseString(code).trim();
  if (!key) throw new NeonaicIllegalArgumentError('用户名录的 code 不能为空');

  load();
  if (!overwrite && store.has(key)) return store.get(key);

  const entry = normalizeEntry(info);
  if (!entry) throw new NeonaicIllegalArgumentError(`用户名录条目缺少可读名（name）：${JSON.stringify(info)}`);

  store.set(key, entry);
  if (persist) save();
  return entry;
}

/**
 * 删除一条。
 * @param {string} code
 * @param {object} [options]
 * @param {boolean} [options.persist=true]
 * @returns {boolean} 是否确实删除了
 */
function remove(code, options = {}) {
  const { persist = true } = options;
  load();
  const key = parseString(code).trim();
  if (!key || !store.delete(key)) return false;
  if (persist) save();
  return true;
}

// ---- 渲染 ----

/**
 * 由「说话者条目 + 场景 code 链」渲染成完整句子。
 * @param {DirectoryEntry|null} selfEntry 说话者条目；为 null 时只渲染场景
 * @param {string|string[]|null} [contextCodes] 场景 code（如群），查不到的一律丢弃
 * @returns {string} 无可读信息时返回空串
 */
function composeSentence(selfEntry, contextCodes) {
  const parts = [];
  if (selfEntry) parts.push(`当前与你对话的人：${renderEntry(selfEntry)}`);

  const contexts = toCodeList(contextCodes)
    .map((code) => get(code))
    .filter(Boolean)
    .map((entry) => renderEntry(entry));
  if (contexts.length) parts.push(`所在场景：${contexts.join('、')}`);

  return parts.length ? `${parts.join('；')}。` : '';
}

/**
 * 由 code 链渲染：第一个 code 视为说话者，其余视为场景。
 * @apiNote 查不到的 code **一律丢弃** —— 绝不把原始代号透给模型，否则本模块就白做了。
 * @param {string|string[]|null|undefined} codes
 * @returns {string} 无可读信息时返回空串
 */
function describe(codes) {
  const list_ = toCodeList(codes);
  if (!list_.length) return '';
  return composeSentence(get(list_[0]), list_.slice(1));
}

export const neonaicUserDirectory = Object.freeze({
  FILE,
  load,
  reload,
  save,
  get,
  list,
  size,
  set,
  remove,
  normalizeEntry,
  renderEntry,
  composeSentence,
  describe,
});
