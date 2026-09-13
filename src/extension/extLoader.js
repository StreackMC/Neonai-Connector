import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import { parseString } from '../utils/chore.js';
import { neonaicConfManager } from "../system/confManager.js";
import { NeonaicConfig } from "../utils/NeonaicConfig.js";
import { NeonaicNewable } from "../utils/NeonaicNewableClass.js";
import { NeonaicExtensionError, NeonaicFileNotFoundError, NeonaicIllegalArgumentError, NeonaicIllegalStateError } from '../utils/NeonaicNewableError.js';
import { neonaicFileSystem } from '../utils/io.js';

/**
 * @typedef {Object} NeonaicExtContext Neonaic 拓展上下文，用于告诉拓展当前环境信息
 * @property {NeonaicConfig} manifest 拓展描述文件
 * @property {string} pwd 拓展所在的目录
 * @property {number} ext_item_id 拓展被识别后所分配的 ID
 * @property {number} ext_item_timestamp 拓展被识别时的时间戳
 */

/** 枚举清单文件属性 */
const MANIFEST_STRUCTURE = Object.freeze({
  meta: {
    _root: 'meta',
    version: 'meta.version',
    id: 'meta.id',
  },
  particulars: {
    _root: 'particulars',
    name: 'particulars.name',
    author: 'particulars.author',
    description: 'particulars.description',
    url: 'particulars.url',
    license: 'particulars.license',
  },
  entry: 'entry',
  depends: 'depends',
  softdepends: 'softdepends',
});

/** 枚举一个拓展 */
export class NeonaicExtItem extends NeonaicNewable {
  /** @throws 不可达或无效拓展 */
  constructor(path, saves) {
    super();
    if (!(typeof path === 'string')) throw new NeonaicIllegalArgumentError("NeonaicExtItem 构造器的第一个参数应该是 String", path);
    if (!(saves instanceof NeonaicConfig)) throw new NeonaicIllegalArgumentError("NeonaicExtItem 构造器的第二个参数应该是 NeonaicConfig", saves);
    const manifest_file = resolve(path, "manifest.json");
    if (!existsSync(manifest_file)) throw new NeonaicFileNotFoundError(`拓展“${parseString(path)}”的描述文件不存在或无法访问`);
    this.#manifest_config = new NeonaicConfig(manifest_file);

    // 确认清单文件合理
    const [ver, id, name, entry] = [
      this.#manifest_config.getList(MANIFEST_STRUCTURE.meta.version, undefined),
      this.#manifest_config.getString(MANIFEST_STRUCTURE.meta.id, undefined),
      this.#manifest_config.getString(MANIFEST_STRUCTURE.particulars.name, undefined),
      this.#manifest_config.getString(MANIFEST_STRUCTURE.entry, undefined)
    ];
    if (!ver || !id || !name || !entry || !name?.trim() || !/^[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)*$/.test(parseString(id))) throw new NeonaicFileNotFoundError(`拓展“${parseString(path)}”的描述文件无效`);
    this.#name = this.#manifest_config.getString(MANIFEST_STRUCTURE.particulars.name, undefined);
    this.#id = this.#manifest_config.getString(MANIFEST_STRUCTURE.meta.id, undefined);

    // 接着找到入口
    const entry_file = resolve(path, entry);
    if (!existsSync(entry_file)) {
      // 文件不存在
      throw new NeonaicFileNotFoundError(`拓展“${parseString(this.fullname)}”的入口文件不存在或无法访问`);
    }
    if (neonaicFileSystem.isTraversalSync(entry_file, path)) {
      // 阻止路径穿越
      throw new NeonaicIllegalArgumentError(`拓展“${parseString(this.fullname)}”的加载会产生意外访问，因此“${neonaicConfManager.getBotName()}”拒绝加载`);
    }

    // 缓存一些数据
    this.#entry = entry_file;
    this.#global_config = saves;
  }

  /** @type {import('node:module').Module|null} */
  #instance = null;
  /** @type {String|null} */
  #entry = null;
  /** @type {NeonaicConfig|null} */
  #manifest_config = null;
  /** @type {NeonaicConfig|null} */
  #global_config = null;
  /** @type {String|null} */
  #name = null;
  /** @type {String|null} */
  #id = null;

  /** 获取拓展提供的导出 */
  get export() { return this.#instance; }
  /** 获取拓展属性 */
  get manifest() { return this.#manifest_config; }
  /** 获取拓展名称 */
  get name() { return this.#name; }
  /** 获取拓展标识符 */
  get id() { return this.#id; }
  /** 获取拓展全名 */
  get fullname() { return `${this.#name}(${this.#id})`; }
  /** 获取拓展入口文件地址 */
  get entry_path() { return this.#entry; }
  /** 获取启用状态 @returns {null|boolean} */
  get enabled() { return this.#global_config.getBoolean(this.id.replaceAll('.', '\.') + ".enabled", true); }
  /** 设置启用状态，**不会**影响插件的现行状态 */
  set enabled(v) { this.#global_config.putBoolean(this.id.replaceAll('.', '\.') + ".enabled", v); }

  /**
   * 加载拓展
   * @throws {NeonaicIllegalStateError} 拓展已被禁用
   * @throws {NeonaicExtensionError} 加载时发生错误
   */
  async enable() {
    if (!this.enabled) throw new NeonaicIllegalStateError(`“${this.fullname}”已被禁用而无法加载`)
    try {
      if (!this.#instance) {
        this.#instance = await import(this.#entry);
      };
      if (typeof this.#instance.onEnable !== 'function' || typeof this.#instance.onDisable !== 'function') throw new NeonaicExtensionError(`拓展“${this.fullname}”没有提供有效的入口函数，因此“${neonaicConfManager.getBotName()}”无法加载`);
      await this.#instance.onEnable.apply(this, {
        manifest: this.#manifest_config,
        pwd: resolve(this.entry_path, '..'),
        ext_item_id: this.INSTANCE_ID,
        ext_item_timestamp: this.TIMESTAMP,
      });
    } catch (error) {
      this.#instance = null;
      if (error instanceof NeonaicExtensionError) throw error;
      throw new NeonaicExtensionError(`加载拓展“${this.fullname}”时发生了错误：${parseString(error)}`, error);
    }
  }

  /**
   * 卸载拓展
   * @deprecated 警惕内存泄露
   * @throws {NeonaicExtensionError} 卸载时发生错误
   */
  async disable() {
    try {
      await this.#instance.onDisable.apply(this);
    } catch (error) {
      throw new NeonaicExtensionError(`卸载拓展“${this.fullname}”时发生了错误：${parseString(error)}`, error);
    }
    this.#instance = null;
  }
}

export const neonaicExtensionLoader = {
  MANIFEST_STRUCTURE,
};