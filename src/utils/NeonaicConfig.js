/**
 * NeonaicConfig.js — 单文件配置处理器（SConfig 的 JS 移植）
 *
 * 与 Java 版 `com.github.streackmc.StreackLib.types.SConfig` 对齐，特性包括：
 *   - 点号嵌套路径读写（支持 `\.` 转义为字面点号）
 *   - 严格类型 getter / putter（链式调用）
 *   - 五种写入模式（AUTOSAVE / INERTIA / WRITELOCK / READONLY / MEMORY）
 *   - 自动重载（文件监视 + 间隔节流 + 失败退避）与手动 reload
 *   - 缺省值配置、存在性 / 可触达判定、静默删除
 *   - 原子写入（临时文件 + rename）、惰性临时文件、内存态配置
 *   - 根数组（`_root_array`）特例
 *
 * 与 Java 版的**有意差异**（均因 JS 无对应物或原版行为不当）：
 *   1. 仅支持 JSON5 一种格式（覆盖 JSON / JSONC），故无 TYPES / getType 多类型概念，
 *      注释（CommentableBackend）与 RootName（RootNamedBackend）这两类**后端专属**能力不实现。
 *   2. 线程安全：JS 单线程，无需 ReentrantReadWriteLock。
 *   3. 无 SEventCentral 事件总线，事件以 onAutoReloaded / onLoadFailure 回调表达。
 *   4. BigDecimal 无 JS 对应物，不实现（Java 的 getBigDecimal/putBigDecimal）。
 *   5. 保存后会同步自身记录的 mtime，避免自动重载被自己的写入触发（Java 版存在此自触发）。
 *   6. getBoolean 兼容 Java 的 `Boolean.parseBoolean` 语义，并额外接受 1/0/yes/on 等宽松写法。
 *
 * @since 0.1.0
 */

import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync,
  unwatchFile, watch, watchFile, writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import JSON5 from 'json5';
import { NeonaicNewable } from './NeonaicNewableClass.js';
import {
  NeonaicIllegalArgumentError,
  NeonaicIllegalStateError,
  NeonaicIOError,
} from './NeonaicNewableError.js';

// 本模块自算项目根路径，避免与 entry.js 形成循环依赖
// NeonaicConfig.js 位于 <根>/src/utils/，故向上 2 层为项目根
const ROOT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** 根数组包装键名（JSON 系特有的 Array As Root 特性） */
const ROOT_ARRAY_KEY = '_root_array';

/** 五种写入模式，语义见 {@link NeonaicConfig.WRITE_MODES} */
const WRITE_MODES = Object.freeze({
  /** 自动保存：产生修改后立即写入文件。默认值。 */
  AUTOSAVE: 'autosave',
  /** 手动保存：修改仅在内存，须调用 save() 才落盘。 */
  INERTIA: 'inertia',
  /** 写保护：可以修改内存，但 save() 会抛错。 */
  WRITELOCK: 'writelock',
  /** 只读：任何修改尝试都会抛错。 */
  READONLY: 'readonly',
  /** 仅内存：所有涉及文件对象的操作（save/reload/getFile/自动重载）都会被拒绝。 */
  MEMORY: 'memory',
});

const DEFAULT_AUTORELOAD_INTERVAL = 1000;
const DEFAULT_AUTORELOAD_BREAK = 2000;

// ---- 嵌套路径工具 ----

/**
 * 支持 `\.` 转义的路径切割。
 * `a\.b.c` → ['a.b', 'c']；其余位置的反斜杠原样保留。
 * @param {string} key
 * @returns {string[]} 路径分段；无嵌套时为单元素数组
 */
function splitPath(key) {
  const parts = [];
  let buf = '';
  for (let i = 0; i < key.length; i++) {
    const c = key[i];
    if (c === '\\') {
      if (i + 1 < key.length && key[i + 1] === '.') {
        // 转义点号：并入当前段，不触发分割
        buf += '.';
        i++;
      } else {
        // 其它情况：保留反斜杠本身
        buf += '\\';
      }
      continue;
    }
    if (c === '.') { parts.push(buf); buf = ''; continue; }
    buf += c;
  }
  parts.push(buf);
  return parts;
}

/** 是否为「可继续下探的嵌套层」 */
function isBranch(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 从嵌套路径读取值；路径不存在或中途类型不匹配返回 undefined。
 * @param {object} origin 起始对象
 * @param {string} key 点号嵌套路径
 */
function getNested(origin, key) {
  const parts = splitPath(key);
  let current = origin;
  for (const part of parts) {
    if (!isBranch(current)) return undefined;
    current = current[part];
  }
  return current;
}

/**
 * 确保嵌套路径存在，返回最末一级的父对象以便写入。
 * 中途遇到非嵌套节点（或被自动创建的空节点）时按 Java 版语义处理。
 * @param {object} origin 起始对象
 * @param {string} key 点号嵌套路径
 * @param {boolean} [create=true] 是否沿途自动创建空对象
 * @returns {object|null} 可写入的父对象；中途类型冲突时返回 null
 */
function ensureNestedMap(origin, key, create = true) {
  const parts = splitPath(key);
  let current = origin;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = current[parts[i]];
    if (next === undefined || next === null) {
      if (!create) return null;
      const fresh = {};
      current[parts[i]] = fresh;
      current = fresh;
    } else if (isBranch(next)) {
      current = next;
    } else {
      // 中途节点非嵌套结构，无法继续下探
      return null;
    }
  }
  return current;
}

/**
 * 向嵌套路径写入值；中途类型冲突时退化为「以完整 key 写入顶层」。
 * @param {object} origin 起始对象
 * @param {string} key 点号嵌套路径
 * @param {*} value 目标值
 */
function putNested(origin, key, value) {
  const target = ensureNestedMap(origin, key);
  if (target === null) {
    origin[key] = value;
    return;
  }
  const parts = splitPath(key);
  target[parts[parts.length - 1]] = value;
}

/** 校验键名合法性 */
function assertKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new NeonaicIllegalArgumentError(`配置键无效：${key}`);
  }
  return key;
}

// ---- 日期时间（Java LocalDate / LocalTime / LocalDateTime 的 JS 映射）----

/**
 * 三个 Date 子类用于在序列化时区分落盘形态。
 * 它们仍然是 Date（`instanceof Date` 成立），只是多带一个「该写成什么形状」的标记。
 * @internalApi
 */
class NeonaicLocalDate extends Date { }
class NeonaicLocalTime extends Date { }
class NeonaicLocalDateTime extends Date { }

const pad2 = (n) => String(n).padStart(2, '0');

/** 格式化为 `YYYY-MM-DD` */
function formatLocalDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 格式化为 `HH:mm:ss` */
function formatLocalTime(d) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 格式化为 `YYYY-MM-DDTHH:mm:ss[.SSS]` */
function formatLocalDateTime(d) {
  const base = `${formatLocalDate(d)}T${formatLocalTime(d)}`;
  return d.getMilliseconds() === 0 ? base : `${base}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

const RE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const RE_TIME = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;
const RE_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/;

/** 解析 `YYYY-MM-DD`（严格：2026-02-30 视为非法） @returns {Date|null} */
function parseLocalDate(text) {
  const m = RE_DATE.exec(text);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(y, mo - 1, d);
  // JS 会把越界日期顺延（如 2 月 30 日），据此反查可判定非法
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

/** 解析 `HH:mm[:ss]` @returns {Date|null} 基准日为 1970-01-01（本地时区） */
function parseLocalTime(text) {
  const m = RE_TIME.exec(text);
  if (!m) return null;
  const [h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  if (h > 23 || mi > 59 || s > 59) return null;
  return new Date(1970, 0, 1, h, mi, s);
}

/** 解析 `YYYY-MM-DD[T| ]HH:mm[:ss][.SSS]` @returns {Date|null} */
function parseLocalDateTime(text) {
  const m = RE_DATETIME.exec(text);
  if (!m) return null;
  const base = parseLocalDate(`${m[1]}-${m[2]}-${m[3]}`);
  if (!base) return null;
  const [h, mi, s] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  if (h > 23 || mi > 59 || s > 59) return null;
  const ms = m[7] ? Number(m[7].padEnd(3, '0')) : 0;
  return new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, mi, s, ms);
}

/** 把任意输入规范化为「仅日期」的 Date @throws {NeonaicIllegalArgumentError} */
function asLocalDate(value) {
  if (value == null) return value;
  let d = null;
  if (value instanceof Date) d = value;
  else if (typeof value === 'string') d = parseLocalDate(value);
  if (!d) throw new NeonaicIllegalArgumentError(`无法解析为 LocalDate：${value}`);
  return new NeonaicLocalDate(d.getFullYear(), d.getMonth(), d.getDate());
}

/** 把任意输入规范化为「仅时间」的 Date @throws {NeonaicIllegalArgumentError} */
function asLocalTime(value) {
  if (value == null) return value;
  let d = null;
  if (value instanceof Date) d = value;
  else if (typeof value === 'string') d = parseLocalTime(value);
  if (!d) throw new NeonaicIllegalArgumentError(`无法解析为 LocalTime：${value}`);
  return new NeonaicLocalTime(1970, 0, 1, d.getHours(), d.getMinutes(), d.getSeconds());
}

/** 把任意输入规范化为「完整日期时间」的 Date @throws {NeonaicIllegalArgumentError} */
function asLocalDateTime(value) {
  if (value == null) return value;
  let d = null;
  if (value instanceof Date) d = value;
  else if (typeof value === 'string') d = parseLocalDateTime(value);
  if (!d) throw new NeonaicIllegalArgumentError(`无法解析为 LocalDateTime：${value}`);
  return new NeonaicLocalDateTime(
    d.getFullYear(), d.getMonth(), d.getDate(),
    d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds(),
  );
}

/**
 * 把 Date 换成其对应的 ISO-8601 文本，供落盘使用。
 * `NeonaicLocalDate` → `YYYY-MM-DD`；`NeonaicLocalTime` → `HH:mm:ss`；
 * 其余 Date（含 `NeonaicLocalDateTime`）→ 完整 ISO 本地时间。
 */
function toSerializable(value) {
  if (value instanceof NeonaicLocalDate) return formatLocalDate(value);
  if (value instanceof NeonaicLocalTime) return formatLocalTime(value);
  if (value instanceof Date) return formatLocalDateTime(value);
  if (Array.isArray(value)) return value.map((v) => toSerializable(v));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = toSerializable(v);
    return out;
  }
  return value;
}

/** 深拷贝，且保留 Date 子类身份（结构化克隆会把子类降级为普通 Date） */
function deepClone(value) {
  if (value instanceof Date) return new value.constructor(value.getTime());
  if (Array.isArray(value)) return value.map((v) => deepClone(v));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepClone(v);
    return out;
  }
  return value;
}

// ---- Config 类 ----

export class NeonaicConfig extends NeonaicNewable {
  /** 五种写入模式，语义同 Java 版 `SConfig.WRITE_MODE` */
  static WRITE_MODES = WRITE_MODES;

  /** 配置文件内容（已解构的树状结构） @type {object} */
  #data = {};
  /** 是否存在尚未落盘的修改 */
  #dirty = false;
  /** 配置文件绝对路径；仅内存态为 null @type {string|null} */
  #path = null;
  /** 惰性临时文件后缀（仅内存态用） @type {string|null} */
  #tempSuffix = null;
  /** 读写文件使用的编码 */
  #encoding = 'utf8';

  /** 当前写入模式 @type {string} */
  #writeMode = WRITE_MODES.AUTOSAVE;
  /** 写入模式是否已被永久锁定 */
  #writeModeLocked = false;

  /** 最近一次加载时记录的 mtime（ms） */
  #lastModified = 0;
  /** 是否正在自动重载 */
  #watching = false;
  /** 文件监视句柄 @type {import('node:fs').FSWatcher|null} */
  #watcher = null;
  /** 是否退化到了轮询监视（fs.watchFile） */
  #polling = false;
  /** 节流用：上一次检查时间 */
  #lastCheck = 0;
  /** 自动重载检查间隔（ms） */
  #reloadInterval = DEFAULT_AUTORELOAD_INTERVAL;
  /** 重载出错后的等待时长（ms）：负数立即停止、0 立即重试、正数等待 */
  #reloadBreak = DEFAULT_AUTORELOAD_BREAK;
  /** 出错退避的定时器 @type {NodeJS.Timeout|null} */
  #breakTimer = null;

  /** 自动重载成功后的回调 @type {((conf: NeonaicConfig) => void)|null} */
  #onAutoReloaded = null;
  /** 加载失败时的回调 @type {((conf: NeonaicConfig, err: Error) => void)|null} */
  #onLoadFailure = null;

  /**
   * 构造配置对象。
   *
   * - 传入路径 → 从文件读取（读取失败的文件不存在视作空配置，与 Java 版 reload 一致）
   * - 传入 `null` / `undefined` → 仅内存态（{@link WRITE_MODES.MEMORY}），不触碰磁盘
   *
   * @param {string|null} [path] 配置文件路径（相对项目根或绝对路径）
   * @param {object} [options]
   * @param {string} [options.encoding='utf8'] 读写编码
   * @param {string} [options.suffix] 惰性临时文件的后缀，如 '.json5'
   * @param {string} [options.writeMode] 初始写入模式
   */
  constructor(path = null, options = {}) {
    super();
    const { encoding = 'utf8', suffix = null, writeMode } = options;
    this.#encoding = encoding;
    this.#tempSuffix = suffix;

    if (path === null || path === undefined) {
      // 仅内存态：不分配文件对象，直到切换写入模式并保存
      this.#path = null;
      this.#data = {};
      this.setWriteMode(WRITE_MODES.MEMORY);
    } else {
      this.#path = resolve(ROOT_PATH, path);
      this.reload();
    }
    if (writeMode) this.setWriteMode(writeMode);
  }

  /**
   * 以已有数据构造仅内存态配置（Java 版 `SConfig(Map, ctype, suffix)` 的对应物）。
   * @param {object|null} rawData 初始数据，null 视作空
   * @param {object} [options] 同构造函数
   * @returns {NeonaicConfig}
   */
  static fromObject(rawData = null, options = {}) {
    const conf = new NeonaicConfig(null, options);
    conf.#data = isBranch(rawData) ? deepClone(rawData) : {};
    return conf;
  }

  /**
   * 以 JSON5 文本构造仅内存态配置（Java 版 `SConfig(String rawData, ctype, suffix)` 的对应物）。
   * @param {string|null} rawText 原始配置文本，null 视作空
   * @param {object} [options] 同构造函数
   * @returns {NeonaicConfig}
   */
  static fromJSON5(rawText = null, options = {}) {
    const conf = new NeonaicConfig(null, options);
    conf.#data = NeonaicConfig.#parseText(rawText ?? '');
    return conf;
  }

  // ---- 基础访问 ----

  /** 配置文件绝对路径；仅内存态为 null @returns {string|null} */
  get path() { return this.#path; }

  /** 是否有尚未落盘的修改 @returns {boolean} */
  get dirty() { return this.#dirty; }

  /** 标准化后的格式名（仅 JSON5 一种） @returns {string} */
  getType() { return 'json5'; }

  /**
   * 获取当前配置文件路径。
   * @param {boolean} [allowCreate=true] 仅内存态未分配文件对象时，是否立即分配一个惰性临时文件
   * @returns {string|null} 拒绝分配时返回 null
   * @throws {NeonaicIllegalStateError} 仅内存模式下不允许访问文件对象
   * @throws {NeonaicIOError} 无法创建临时文件
   */
  getFile(allowCreate = true) {
    if (this.#writeMode === WRITE_MODES.MEMORY) {
      throw new NeonaicIllegalStateError('仅内存模式下硬盘文件对象不可用');
    }
    if (this.#path === null) {
      if (!allowCreate) return null;
      const file = this.#ensurePath();
      try {
        // 与 Java 版略有差异：这里直接写入当前内容，避免交出一个空文件
        writeFileSync(file, this.#serialize(), this.#encoding);
      } catch (err) {
        throw new NeonaicIOError(`无法创建临时配置文件：${err.message}`, err);
      }
      this.#lastModified = safeMtime(file);
    }
    return this.#path;
  }

  /** 惰性分配临时文件路径（不写盘） */
  #ensurePath() {
    if (this.#path !== null) return this.#path;
    const suffix = this.#tempSuffix ?? '.json5';
    this.#path = resolve(
      tmpdir(),
      `NeonaicConfig-${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${suffix}`,
    );
    return this.#path;
  }

  // ---- 加载与重载 ----

  /**
   * 把文件内容加载到内存。
   * 文件不存在时清空数据并返回（不会新建文件），与 Java 版行为一致。
   * @returns {NeonaicConfig} 自身，便于链式调用
   * @throws {NeonaicIllegalStateError} 仅内存模式，或文件对象尚未初始化
   * @throws {NeonaicIOError} 读取或解析失败
   */
  reload() {
    if (this.#writeMode === WRITE_MODES.MEMORY) {
      throw new NeonaicIllegalStateError('仅内存模式下无法加载文件到缓存');
    }
    if (this.#path === null) {
      throw new NeonaicIllegalStateError('当前配置文件尚未初始化，请先 save() 或 getFile() 创建文件');
    }
    if (!existsSync(this.#path)) {
      this.#data = {};
      this.#dirty = false;
      // 与 File.lastModified() 对不存在的文件返回 0 的行为对齐
      this.#lastModified = 0;
      return this;
    }
    let text;
    try {
      text = readFileSync(this.#path, this.#encoding);
    } catch (err) {
      this.#onLoadFailure?.(this, err);
      throw new NeonaicIOError(`无法加载配置文件：${err.message}`, err);
    }
    try {
      this.#data = NeonaicConfig.#parseText(text);
    } catch (err) {
      this.#onLoadFailure?.(this, err);
      throw new NeonaicIOError(`无法加载配置文件：${err.message}`, err);
    }
    this.#dirty = false;
    this.#lastModified = safeMtime(this.#path);
    return this;
  }

  /**
   * 获取当前数据的**镜像**（深拷贝，含 Date 子类身份）。
   * 修改返回值不会影响配置对象本身。
   * @returns {object}
   */
  getRawData() {
    return deepClone(this.#data);
  }

  // ---- 回调 ----

  /**
   * 设置自动重载成功后的回调。
   * @param {(conf: NeonaicConfig) => void|null} func
   */
  onAutoReloaded(func) {
    this.#onAutoReloaded = func ?? null;
    return this;
  }

  /**
   * 设置加载失败时的回调。
   * @param {(conf: NeonaicConfig, err: Error) => void|null} func
   */
  onLoadFailure(func) {
    this.#onLoadFailure = func ?? null;
    return this;
  }

  // ---- 写入模式 ----

  /** @returns {string} 当前写入模式，取值见 {@link NeonaicConfig.WRITE_MODES} */
  getWriteMode() { return this.#writeMode; }

  /** @returns {boolean} 写入模式是否已被永久锁定 */
  getWriteModeLocked() { return this.#writeModeLocked; }

  /**
   * 设置写入模式。
   * @param {string|null} mode 取值为 {@link NeonaicConfig.WRITE_MODES} 之一；
   *   null 视作 AUTOSAVE，无法识别时视作 INERTIA；不区分大小写
   * @returns {NeonaicConfig} 自身，便于链式调用
   * @throws {NeonaicIllegalStateError} 写入模式已被锁定
   */
  setWriteMode(mode) {
    if (this.#writeModeLocked) {
      throw new NeonaicIllegalStateError('写入模式已被锁定，无法修改。');
    }
    if (mode === null || mode === undefined) {
      this.#writeMode = WRITE_MODES.AUTOSAVE;
      return this;
    }
    const normalized = String(mode).trim().toLowerCase();
    this.#writeMode = Object.values(WRITE_MODES).includes(normalized)
      ? normalized
      : WRITE_MODES.INERTIA;
    return this;
  }

  /**
   * 设置写入模式并永久锁定，此后任何修改尝试都会抛错。
   * @param {string|null} mode 同 {@link NeonaicConfig#setWriteMode}
   * @returns {NeonaicConfig} 自身，便于链式调用
   */
  setWriteModeForever(mode) {
    this.setWriteMode(mode);
    this.#writeModeLocked = true;
    return this;
  }

  // ---- 自动重载 ----

  /**
   * 启用 / 停用自动重载。重复启用会被静默忽略。
   * @param {boolean} status
   * @returns {NeonaicConfig} 自身，便于链式调用
   * @throws {NeonaicIllegalStateError} 仅内存模式
   * @throws {NeonaicIllegalArgumentError} 检查间隔不是正数
   * @throws {NeonaicIOError} 无法启用监视
   */
  setAutoReload(status) {
    if (status) this.#startAutoReload();
    else this.#stopAutoReload();
    return this;
  }

  /** @returns {boolean} 是否正在自动重载 */
  isAutoReloading() { return this.#watching; }

  /**
   * 设置自动重载的检查间隔（ms），影响文件变化检测的节流粒度。
   * 非正数会导致无法启用自动重载。
   * @param {number|null} [ms=1000]
   * @returns {NeonaicConfig} 自身，便于链式调用
   */
  setAutoReloadInterval(ms) {
    this.#reloadInterval = (ms === null || ms === undefined) ? DEFAULT_AUTORELOAD_INTERVAL : Number(ms);
    if (this.#watching) { this.#stopAutoReload(); this.#startAutoReload(); }
    return this;
  }

  /** @returns {number} 自动重载检查间隔（ms） */
  getAutoReloadInterval() { return this.#reloadInterval; }

  /**
   * 设置自动重载出错后的等待时长（ms）。
   * 负数表示出错即停止自动重载，0 表示立即重试。
   * @param {number|null} [ms=2000]
   * @returns {NeonaicConfig} 自身，便于链式调用
   */
  setAutoReloadBreak(ms) {
    this.#reloadBreak = (ms === null || ms === undefined) ? DEFAULT_AUTORELOAD_BREAK : Number(ms);
    return this;
  }

  /** @returns {number} 自动重载出错后的等待时长（ms） */
  getAutoReloadBreak() { return this.#reloadBreak; }

  // ---- 存在性与可触达 ----

  /**
   * 判断配置项是否已设置。
   * @apiNote 显式设置为 null 也会返回 false（与 Java 版一致）
   * @param {string} key
   * @returns {boolean}
   */
  isExist(key) {
    const v = getNested(this.#data, key);
    return v === null || v === undefined ? false : true;
  }

  /**
   * 判断配置项是否可触达：即路径中间每一层都已是嵌套结构。
   *
   * 用于防止「嵌套写入退化为顶层写入」：
   * ```js
   * conf.isReachable('user.score', () => conf.putDouble('user.score', 99.5));
   * ```
   *
   * @apiNote 中间节点**不存在**同样视为不可触达（与 Java 版一致），
   *          尽管此时 putNested 其实会沿途自动创建空对象。
   * @param {string} key 目标配置项
   * @param {(() => any)} [action] 可触达时执行的动作
   * @returns {boolean} 不可触达时为 false
   */
  isReachable(key, action) {
    const parts = splitPath(key);
    let reachable = true;
    if (parts.length > 1) {
      let current = this.#data;
      for (let i = 0; i < parts.length - 1; i++) {
        const next = current[parts[i]];
        if (!isBranch(next)) { reachable = false; break; }
        current = next;
      }
    }
    if (reachable && typeof action === 'function') action();
    return reachable;
  }

  // ---- 通用读写 ----

  /**
   * 获取原始值（不做类型转换）。
   * @param {string} key 点号嵌套路径
   * @param {*} [def] 缺失时的返回值
   */
  get(key, def) {
    const v = getNested(this.#data, key);
    return v !== undefined ? v : def;
  }

  /**
   * 设置值（点号嵌套路径，如 "platforms.0.enabled"）。
   * @apiNote 是否立即落盘取决于当前写入模式。
   * @param {string} key
   * @param {*} value
   * @returns {NeonaicConfig} 自身，便于链式调用
   */
  set(key, value) {
    return this.#put(key, value);
  }

  /**
   * 删除配置项；路径不存在或中途类型不匹配时静默返回。
   * @param {string} key 点号嵌套路径
   * @returns {NeonaicConfig} 自身，便于链式调用
   */
  remove(key) {
    assertKey(key);
    this.#assertWritable();
    const parts = splitPath(key);
    if (parts.length === 1) {
      if (!Object.hasOwn(this.#data, key)) return this;
      delete this.#data[key];
    } else {
      const parent = ensureNestedMap(this.#data, key, false);
      if (parent === null || !Object.hasOwn(parent, parts[parts.length - 1])) return this;
      delete parent[parts[parts.length - 1]];
    }
    this.#afterWrite();
    return this;
  }

  // ---- 类型化 getter：字符串 / 数值 / 布尔 ----

  /**
   * 获取字符串。
   * @param {string} key
   * @param {string} [def='']
   * @returns {string}
   */
  getString(key, def = '') {
    const v = this.get(key);
    return v === null || v === undefined ? def : String(v);
  }

  /**
   * 获取整数（截断小数部分）。
   * @param {string} key
   * @param {number} [def=0]
   * @returns {number}
   */
  getInt(key, def = 0) {
    const v = this.get(key);
    if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
    if (typeof v === 'string') { const n = Number.parseInt(v, 10); if (!Number.isNaN(n)) return n; }
    return def;
  }

  /**
   * 获取 16 位有符号整数（与 Java `Number.shortValue()` 一致，按位截断回绕）。
   * @param {string} key
   * @param {number} [def=0]
   * @returns {number} -32768 ~ 32767
   */
  getShort(key, def = 0) {
    const v = this.get(key);
    if (typeof v === 'number' && Number.isFinite(v)) return toShort(v);
    if (typeof v === 'string') { const n = Number.parseInt(v, 10); if (!Number.isNaN(n)) return toShort(n); }
    return def;
  }

  /**
   * 获取长整数（JS 无 int64，取整到安全整数范围，超出则为原始双精度值）。
   * @param {string} key
   * @param {number} [def=0]
   * @returns {number}
   */
  getLong(key, def = 0) {
    const v = this.get(key);
    if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
    if (typeof v === 'string') { const n = Number.parseInt(v, 10); if (!Number.isNaN(n)) return n; }
    return def;
  }

  /**
   * 获取单精度浮点（与 Java `Number.floatValue()` 一致，按 float32 舍入）。
   * @param {string} key
   * @param {number} [def=0]
   * @returns {number}
   */
  getFloat(key, def = 0) {
    const v = this.get(key);
    if (typeof v === 'number' && Number.isFinite(v)) return Math.fround(v);
    if (typeof v === 'string') { const n = Number.parseFloat(v); if (!Number.isNaN(n)) return Math.fround(n); }
    return def;
  }

  /**
   * 获取双精度浮点。
   * @param {string} key
   * @param {number} [def=0]
   * @returns {number}
   */
  getDouble(key, def = 0) {
    const v = this.get(key);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') { const n = Number.parseFloat(v); if (!Number.isNaN(n)) return n; }
    return def;
  }

  /**
   * 获取布尔值。
   * @apiNote 兼容 Java `Boolean.parseBoolean` 的严格语义，并额外接受 `1 / yes / on`（以及对应的假值写法）。
   * @param {string} key
   * @param {boolean} [def=false]
   * @returns {boolean}
   */
  getBoolean(key, def = false) {
    const v = this.get(key);
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') {
      if (v === 0) return false;
      if (v === 1) return true;
      return def;
    }
    if (typeof v === 'string') {
      if (/^(true|1|yes|on)$/i.test(v)) return true;
      if (/^(false|0|no|off)$/i.test(v)) return false;
      return def;
    }
    return def;
  }

  // ---- 类型化 getter：日期时间 ----

  /**
   * 获取日期（当日 00:00 的 Date）。
   * @param {string} key
   * @param {Date|null} [def=null]
   * @returns {Date|null}
   */
  getLocalDate(key, def = null) {
    const v = this.get(key);
    if (v instanceof Date) return v;
    if (typeof v === 'string') return parseLocalDate(v) ?? def;
    return def;
  }

  /**
   * 获取时间（基准日为 1970-01-01 的 Date）。
   * @param {string} key
   * @param {Date|null} [def=null]
   * @returns {Date|null}
   */
  getLocalTime(key, def = null) {
    const v = this.get(key);
    if (v instanceof Date) return v;
    if (typeof v === 'string') return parseLocalTime(v) ?? def;
    return def;
  }

  /**
   * 获取日期时间。
   * @param {string} key
   * @param {Date|null} [def=null]
   * @returns {Date|null}
   */
  getLocalDateTime(key, def = null) {
    const v = this.get(key);
    if (v instanceof Date) return v;
    if (typeof v === 'string') return parseLocalDateTime(v) ?? def;
    return def;
  }

  // ---- 类型化 getter：列表与子段 ----

  /**
   * 获取字符串列表；元素非字符串时逐项 String() 化。
   * @param {string} key
   * @param {string[]} [def=[]]
   * @returns {string[]}
   */
  getListOfString(key, def = []) {
    const v = this.get(key);
    if (Array.isArray(v)) {
      if (v.length === 0 || typeof v[0] === 'string') return v;
      return v.map((o) => String(o));
    }
    return def;
  }

  /**
   * 获取一般列表。
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
   * @apiNote 本方法是 Neonaic 的扩展，会将返回值强行封装为数组
   * @param {string} key
   * @returns {Array}
   */
  getArray(key) {
    const v = this.get(key);
    return Array.isArray(v) ? v : [v];
  }

  /**
   * 获取子配置段（返回浅拷贝，修改不会影响配置对象）。
   * @param {string} key 如 "main" 或 "main.log"
   * @param {object} [def={}]
   * @returns {object}
   */
  getSection(key, def = {}) {
    const v = this.get(key);
    return isBranch(v) ? { ...v } : def;
  }

  /**
   * 获取顶层 section。
   * @apiNote 本方法是 Neonaic 的扩展：直接按顶层键取，不走嵌套路径
   * @param {string} name 如 'main' / 'secret'
   * @returns {object}
   */
  section(name) {
    const v = this.#data[name];
    return isBranch(v) ? v : {};
  }

  // ---- 类型化 putter（全部支持链式调用）----

  /**
   * 写入字符串。
   * @param {string} key
   * @param {string} value
   * @returns {NeonaicConfig}
   */
  putString(key, value) { return this.#put(key, value === null || value === undefined ? value : String(value)); }

  /**
   * 写入整数。
   * @param {string} key
   * @param {number} value
   * @returns {NeonaicConfig}
   */
  putInt(key, value) { return this.#put(key, Math.trunc(Number(value))); }

  /**
   * 写入 16 位有符号整数（按位截断回绕）。
   * @param {string} key
   * @param {number} value
   * @returns {NeonaicConfig}
   */
  putShort(key, value) { return this.#put(key, toShort(Number(value))); }

  /**
   * 写入长整数。
   * @param {string} key
   * @param {number} value
   * @returns {NeonaicConfig}
   */
  putLong(key, value) { return this.#put(key, Math.trunc(Number(value))); }

  /**
   * 写入单精度浮点（按 float32 舍入）。
   * @param {string} key
   * @param {number} value
   * @returns {NeonaicConfig}
   */
  putFloat(key, value) { return this.#put(key, Math.fround(Number(value))); }

  /**
   * 写入双精度浮点。
   * @param {string} key
   * @param {number} value
   * @returns {NeonaicConfig}
   */
  putDouble(key, value) { return this.#put(key, Number(value)); }

  /**
   * 写入布尔值。
   * @param {string} key
   * @param {boolean} value
   * @returns {NeonaicConfig}
   */
  putBoolean(key, value) { return this.#put(key, Boolean(value)); }

  /**
   * 写入日期（落盘为 `YYYY-MM-DD`）。
   * @param {string} key
   * @param {Date|string|null} value
   * @returns {NeonaicConfig}
   * @throws {NeonaicIllegalArgumentError} 无法解析为日期
   */
  putLocalDate(key, value) { return this.#put(key, asLocalDate(value)); }

  /**
   * 写入时间（落盘为 `HH:mm:ss`）。
   * @param {string} key
   * @param {Date|string|null} value
   * @returns {NeonaicConfig}
   * @throws {NeonaicIllegalArgumentError} 无法解析为时间
   */
  putLocalTime(key, value) { return this.#put(key, asLocalTime(value)); }

  /**
   * 写入日期时间（落盘为 `YYYY-MM-DDTHH:mm:ss[.SSS]`）。
   * @param {string} key
   * @param {Date|string|null} value
   * @returns {NeonaicConfig}
   * @throws {NeonaicIllegalArgumentError} 无法解析为日期时间
   */
  putLocalDateTime(key, value) { return this.#put(key, asLocalDateTime(value)); }

  /**
   * 写入字符串列表。
   * @param {string} key
   * @param {string[]} value
   * @returns {NeonaicConfig}
   */
  putListOfString(key, value) {
    return this.#put(key, Array.isArray(value) ? value.map((v) => String(v)) : value);
  }

  /**
   * 写入一般列表（存入副本）。
   * @param {string} key
   * @param {Array} value
   * @returns {NeonaicConfig}
   */
  putList(key, value) {
    return this.#put(key, Array.isArray(value) ? [...value] : value);
  }

  /**
   * 写入子配置段（存入浅拷贝）。
   * @param {string} key
   * @param {object|NeonaicConfig} section 子段数据，或另一个 NeonaicConfig 实例
   * @returns {NeonaicConfig}
   */
  putSection(key, section) {
    if (section instanceof NeonaicConfig) return this.#put(key, section.getRawData());
    return this.#put(key, isBranch(section) ? { ...section } : section);
  }

  // ---- 保存 ----

  /**
   * 将内存数据原子写入文件（先写临时文件再 rename）。
   *
   * 无变更时跳过写入；但写入模式的校验总是先行，以便尽早暴露状态错误。
   *
   * @returns {NeonaicConfig} 自身，便于链式调用
   * @throws {NeonaicIllegalStateError} WRITELOCK / READONLY / MEMORY 模式下不允许写入
   * @throws {NeonaicIOError} 写入失败
   */
  save() {
    if (this.#writeMode === WRITE_MODES.WRITELOCK) {
      throw new NeonaicIllegalStateError('写保护模式下无法写入缓存到文件');
    }
    if (this.#writeMode === WRITE_MODES.READONLY) {
      throw new NeonaicIllegalStateError('只读模式下无法写入缓存到文件');
    }
    if (this.#writeMode === WRITE_MODES.MEMORY) {
      throw new NeonaicIllegalStateError('仅内存模式下硬盘文件对象不可用');
    }
    if (!this.#dirty) return this;
    // 尚未分配文件对象（临时配置）→ 惰性分配，对齐 Java 版 save() 内部调用 getFile() 的行为
    if (this.#path === null) this.#ensurePath();

    const text = this.#serialize();
    const dir = dirname(this.#path);
    const tmp = resolve(dir, `.${basename(this.#path)}.${process.pid}.${Date.now().toString(36)}.tmp`);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(tmp, text, this.#encoding);
      try {
        renameSync(tmp, this.#path);
      } catch {
        // 某些文件系统 / 平台不支持跨设备 rename，退化为覆盖写后清理
        writeFileSync(this.#path, text, this.#encoding);
        rmSync(tmp, { force: true });
      }
    } catch (err) {
      rmSync(tmp, { force: true });
      throw new NeonaicIOError(`无法写入配置文件：${err.message}`, err);
    }
    this.#dirty = false;
    // 同步自身记录的 mtime，避免自动重载被本次写入触发
    this.#lastModified = safeMtime(this.#path);
    return this;
  }

  // ---- 内部实现 ----

  /** 解析配置文本为数据对象 */
  static #parseText(text) {
    if (text == null || String(text).trim() === '') return {};
    const parsed = JSON5.parse(text);
    if (Array.isArray(parsed)) return { [ROOT_ARRAY_KEY]: parsed };
    if (isBranch(parsed)) return parsed;
    // 标量根（如 `123` / `"str"`）视作空配置，与 Java 版 JSON 后端一致
    return {};
  }

  /** 校验当前状态是否允许修改 */
  #assertWritable() {
    if (this.#writeMode === WRITE_MODES.READONLY) {
      throw new NeonaicIllegalStateError('只读模式下无法修改配置');
    }
  }

  /** 统一的写入路径：校验模式 → 写入 → 视模式落盘 */
  #put(key, value) {
    assertKey(key);
    this.#assertWritable();
    putNested(this.#data, key, value);
    this.#afterWrite();
    return this;
  }

  /** 标记脏并视写入模式落盘 */
  #afterWrite() {
    this.#dirty = true;
    if (this.#writeMode === WRITE_MODES.AUTOSAVE) this.save();
  }

  /** 序列化为落盘文本（含根数组特例与 Date 规整化） */
  #serialize() {
    const onlyRootArray = Object.keys(this.#data).length === 1 && Array.isArray(this.#data[ROOT_ARRAY_KEY]);
    const target = onlyRootArray ? this.#data[ROOT_ARRAY_KEY] : this.#data;
    return JSON5.stringify(toSerializable(target), null, 2) ?? '{}';
  }

  // ---- 自动重载：内部实现 ----

  /** 启动文件监视 */
  #startAutoReload() {
    if (this.#watching) return;
    if (this.#writeMode === WRITE_MODES.MEMORY) {
      throw new NeonaicIllegalStateError('仅内存模式下无法启用自动重载');
    }
    if (!(this.#reloadInterval > 0)) {
      throw new NeonaicIllegalArgumentError(`自动重载间隔不是有效的正数：${this.#reloadInterval}`);
    }
    const file = this.getFile(false);
    if (file === null) {
      throw new NeonaicIllegalStateError('当前配置文件尚未初始化，无法启用自动重载');
    }
    if (!existsSync(file)) {
      throw new NeonaicIOError(`无法启用自动重载：配置文件不存在 ${file}`);
    }
    this.#watching = true;
    if (this.#lastModified === 0) this.#lastModified = safeMtime(file);
    this.#openWatcher();
  }

  /** 打开底层监视句柄，失败时退化为轮询 */
  #openWatcher() {
    const file = this.#path;
    const onEvent = () => this.#onFileEvent();
    try {
      const watcher = watch(dirname(file), () => onEvent());
      watcher.on('error', () => {
        // 监视器失效：退化为轮询
        watcher.close();
        this.#openPollingWatcher();
      });
      // 作为守护资源：不阻止进程退出（对齐 Java 的 daemon thread）
      watcher.unref?.();
      this.#watcher = watcher;
      this.#polling = false;
    } catch {
      this.#openPollingWatcher();
    }
  }

  /** 轮询监视（fs.watch 不可用时的退路） */
  #openPollingWatcher() {
    const file = this.#path;
    watchFile(file, { interval: this.#reloadInterval }, () => this.#onFileEvent());
    this.#polling = true;
    this.#watcher = null;
  }

  /** 收到文件变化通知：节流 → 比对 mtime → 重载 */
  #onFileEvent() {
    if (!this.#watching) return;
    const now = Date.now();
    if (now - this.#lastCheck < this.#reloadInterval) return;
    this.#lastCheck = now;
    try {
      const mtime = existsSync(this.#path) ? safeMtime(this.#path) : 0;
      if (mtime === this.#lastModified) return;
      this.reload();
      this.#onAutoReloaded?.(this);
    } catch (err) {
      if (this.#reloadBreak < 0) {
        // 负数：出错即停止自动重载
        this.#stopAutoReload();
      } else if (this.#reloadBreak > 0) {
        // 正数：暂停监视，等待该时长后重试
        this.#closeWatcher();
        this.#breakTimer = setTimeout(() => {
          this.#breakTimer = null;
          if (this.#watching) this.#openWatcher();
        }, this.#reloadBreak);
        this.#breakTimer.unref?.();
      }
      // 0：立即重试，等下一次文件事件即可
    }
  }

  /** 停用自动重载 */
  #stopAutoReload() {
    this.#watching = false;
    if (this.#breakTimer) { clearTimeout(this.#breakTimer); this.#breakTimer = null; }
    this.#closeWatcher();
  }

  /** 关闭底层监视句柄 */
  #closeWatcher() {
    if (this.#watcher) { try { this.#watcher.close(); } catch { /* 忽略关闭错误 */ } this.#watcher = null; }
    if (this.#polling) {
      try { unwatchFile(this.#path); } catch { /* 忽略关闭错误 */ }
      this.#polling = false;
    }
  }
}

/** 按 Java `Number.shortValue()` 语义回绕到 16 位有符号整数 */
function toShort(value) {
  if (!Number.isFinite(value)) return 0;
  const truncated = Math.trunc(value);
  return ((truncated + 32768) % 65536 + 65536) % 65536 - 32768;
}

/** 读取文件 mtime，失败返回 0（对齐 File.lastModified() 对不存在文件的行为） */
function safeMtime(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}
