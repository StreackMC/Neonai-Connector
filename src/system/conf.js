/**
 * conf.js — 配置模块（SConfig API 风格）
 *
 * 按路径创建 Config 实例：`new Config(path)` 读取单个配置文件，
 * 或 `getConfig(path)` 获取（按路径缓存的）单例。
 * 支持点号嵌套路径（如 "qqbot.appid"），每个 getter 均有默认值回退。
 * 通过 set(key, value) + save() 支持写回文件。
 *
 * 仅支持 JSON5 格式（覆盖 JSON / JSONC）。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSON5 from 'json5';

// 本模块自算项目根路径，避免与 entry.js 形成循环依赖
// conf.js 位于 <根>/src/system/，故向上 2 层为项目根
const ROOT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** 内部名 → 配置文件相对路径 */
export const CONFIG_PATHS = Object.freeze({
  app:    './package.json',
  main:   './config/main.json',
  secret: './secret.json',
});

// ---- 嵌套路径工具 ----

/** 找到第一个未转义的 . ，找不到返回 -1 */
function dotIndex(key) {
  for (let i = 0, esc = false; i < key.length; i++) {
    if (key[i] === '\\') { esc = !esc; continue; }
    if (key[i] === '.' && !esc) return i;
    esc = false;
  }
  return -1;
}

/** 从嵌套 Map 中取值，中途非 Map 返回 undefined */
function getNested(map, key) {
  const idx = dotIndex(key);
  if (idx === -1) return map[key];
  const first = key.slice(0, idx);
  const rest  = key.slice(idx + 1);
  const child = map[first];
  if (!child || typeof child !== 'object' || Array.isArray(child)) return undefined;
  return getNested(child, rest);
}

/** 向嵌套 Map 中写入值，沿途创建空对象 */
function setNested(map, key, value) {
  const idx = dotIndex(key);
  if (idx === -1) { map[key] = value; return; }
  const first = key.slice(0, idx);
  const rest  = key.slice(idx + 1);
  if (!map[first] || typeof map[first] !== 'object' || Array.isArray(map[first])) {
    map[first] = {};
  }
  setNested(map[first], rest, value);
}

// ---- Config 类 ----

export class Config {
  /**
   * 按路径读取单个配置文件。
   * @param {string} path 配置文件路径（相对项目根或绝对路径）
   */
  constructor(path) {
    this._path = resolve(ROOT_PATH, path);
    this._data = JSON5.parse(readFileSync(this._path, 'utf8'));
    this._dirty = false;
  }

  // ---- 写入 ----

  /**
   * 设置值（点号嵌套路径，如 "platforms.0.enabled"）。
   * 修改仅在内存中生效，需调用 save() 持久化。
   * @param {string} key
   * @param {*} value
   */
  set(key, value) {
    setNested(this._data, key, value);
    this._dirty = true;
  }

  /**
   * 将变更写回文件。未变更时跳过。
   */
  save() {
    if (!this._dirty) return;
    writeFileSync(this._path, JSON5.stringify(this._data, null, 2), 'utf8');
    this._dirty = false;
  }

  /** @returns {boolean} 是否有未持久化的变更 */
  get dirty() { return this._dirty; }

  /**
   * 获取顶层 section（整个配置源）。
   * @param {string} name 内部名，如 'main' / 'secret' / 'logger' / 'app'
   * @returns {object}
   */
  section(name) {
    return this._data[name] ?? {};
  }

  // ---- 类型化 getter ----

  /**
   * 获取字符串。
   * @param {string} key  点号嵌套路径，如 "secret.qqbot.appid"
   * @param {string} [def='']
   */
  getString(key, def = '') {
    const v = this.get(key);
    return v == null ? def : String(v);
  }

  /**
   * 获取整数。
   * @param {string} key
   * @param {number} [def=0]
   */
  getInt(key, def = 0) {
    const v = this.get(key);
    if (typeof v === 'number') return Math.trunc(v);
    if (typeof v === 'string') { const n = parseInt(v, 10); if (!isNaN(n)) return n; }
    return def;
  }

  /**
   * 获取布尔值。
   * @param {string} key
   * @param {boolean} [def=false]
   */
  getBoolean(key, def = false) {
    const v = this.get(key);
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      return /^(true|1|yes|on)$/i.test(v) ? true : /^(false|0|no|off)$/i.test(v) ? false : def;
    }
    return def;
  }

  /**
   * 获取原始值（无类型转换）。
   * @param {string} key    点号嵌套路径，前缀为内部名，如 "main.log.redirectConsole"
   * @param {*} [def=undefined]
   */
  get(key, def) {
    const v = getNested(this._data, key);
    return v !== undefined ? v : def;
  }

  /**
   * 获取子配置段（返回原对象引用，只读勿改）。
   * @param {string} key 如 "main" 或 "main.log"
   * @returns {object|null}
   */
  getSection(key) {
    const v = this.get(key);
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
  }

  /**
   * 获取列表。
   * @param {string} key
   * @param {Array} [def=[]]
   * @returns {Array}
   */
  getList(key, def = []) {
    const v = this.get(key);
    return Array.isArray(v) ? v : def;
  }

  /**
   * 获取列表。
   * @apiNote 会将返回值强行封装为数组
   * @param {string} key
   * @returns {Array}
   */
  getArray(key) {
    const v = this.get(key);
    return Array.isArray(v) ? v : [v];
  }
}

const _cache = new Map();

/**
 * 按路径获取配置单例（首次调用时创建并缓存）。
 * @param {string} path 配置文件路径（相对项目根或绝对路径）
 * @returns {Config} 该路径对应的共享配置实例
 */
export function getConfig(path) {
  if (!_cache.has(path)) _cache.set(path, new Config(path));
  return _cache.get(path);
}

/** 语法糖：获取机器人名称 */
export function getBotName() {
  return getConfig(CONFIG_PATHS.main).getString('name');
}
/** 语法糖：获取机器人次要名称 */
export function getBotSubName() {
  return getConfig(CONFIG_PATHS.main).getString('subname');
}