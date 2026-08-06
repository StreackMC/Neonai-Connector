/**
 * conf.js — 配置模块（SConfig API 风格）
 *
 * Config 类由 entry.js 初始化并持有单例，通过 getConfig() 暴露。
 * 支持点号嵌套路径（如 "secret.qqbot.appid"），
 * 每个 getter 均有默认值回退。
 *
 * 仅支持 JSON5 格式（覆盖 JSON / JSONC）。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSON5 from 'json5';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

/** 内部名 → 配置文件相对路径 */
export const CONFIG_PATHS = Object.freeze({
  app:    './package.json',
  main:   './config/main.json',
  logger: './config/logger.json',
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

// ---- Config 类 ----

export class Config {
  /**
   * @param {Record<string, object>} sources 内部名 → 解析后的对象
   */
  constructor(sources) {
    this._ = sources;
  }

  /**
   * 获取顶层 section（整个配置源）。
   * @param {string} name 内部名，如 'main' / 'secret' / 'logger' / 'app'
   * @returns {object}
   */
  section(name) {
    return this._[name] ?? {};
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
    const idx = dotIndex(key);
    if (idx === -1) {
      // 无嵌套：顶层 section 名
      return this._[key] !== undefined ? this._[key] : def;
    }
    const section = key.slice(0, idx);
    const path    = key.slice(idx + 1);
    const map     = this._[section];
    if (!map || typeof map !== 'object') return def;
    const v = getNested(map, path);
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
}

// ---- 单例 ----

let _instance = null;

/**
 * 由 entry.js 在启动时调用，初始化全局配置。
 */
export function initConfig() {
  const sources = Object.fromEntries(
    Object.entries(CONFIG_PATHS).map(([name, rel]) => {
      const raw = readFileSync(resolve(ROOT, rel), 'utf8');
      return [name, JSON5.parse(raw)];
    }),
  );
  _instance = new Config(sources);
  return _instance;
}

/**
 * 获取配置单例（需先调用 initConfig）。
 * @returns {Config}
 */
export function getConfig() {
  if (!_instance) throw new Error('Config 尚未初始化，请先调用 initConfig()');
  return _instance;
}
