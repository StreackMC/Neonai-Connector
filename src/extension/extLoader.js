import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { parseString } from '../logger/Logger.js';
import { NeonaicConfManager } from "../system/confManager.js";
import { NeonaicConfig } from "../system/NeonaicConfig.js";
import { NeonaicNewable } from "../system/NeonaicNewableClass.js";

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
  constructor(path) {
    super();
    this.#conf = new NeonaicConfig(resolve(path, "manifest.json"));

    // 确认清单文件合理
    const [ver, id, name, entry] = [
      this.#conf.getList(MANIFEST_STRUCTURE.meta.version, undefined),
      this.#conf.getString(MANIFEST_STRUCTURE.meta.id, undefined),
      this.#conf.getString(MANIFEST_STRUCTURE.particulars.name, undefined),
      this.#conf.getString(MANIFEST_STRUCTURE.entry, undefined)
    ];
    if (!ver || !id || !name || !entry || !name?.trim() || !/^[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)*$/.test(parseString(id))) throw new Error(`拓展“${parseString(path)}”的清单文件无效、不存在或无法访问。`);
    this.#name = this.#conf.getString(MANIFEST_STRUCTURE.particulars.name, undefined);
    this.#id = this.#conf.getString(MANIFEST_STRUCTURE.meta.id, undefined);

    // 接着找到入口
    const entry_file = resolve(path, entry);
    const entry_file_rel = relative(path, entry_file);
    if (entry_file_rel.startsWith('..') || isAbsolute(entry_file_rel)) {
      // 阻止路径穿越
      throw new Error(`拓展“${parseString(this.fullname)}”的加载会产生意外访问，因此“${NeonaicConfManager.getBotName()}”拒绝加载。`);
    }
    if (!existsSync(entry_file)) {
      // 文件不存在
      throw new Error(`拓展“${parseString(this.fullname)}”的入口文件不存在或无法访问。`);
    }

    // 缓存
    this.#entry = entry_file;
  }

  /** @type {import('node:module').Module|null} */
  #instance = null;
  /** @type {String|null} */
  #entry = null;
  /** @type {NeonaicConfig|null} */
  #conf = null;
  /** @type {String|null} */
  #name = null;
  /** @type {String|null} */
  #id = null;

  /** 获取拓展提供的导出 */
  get export() { return this.#instance; }
  /** 获取拓展属性 */
  get manifest() { return this.#conf; }
  /** 获取拓展名称 */
  get name() { return this.#name; }
  /** 获取拓展标识符 */
  get id() { return this.#id; }
  /** 获取拓展全名 */
  get fullname() { return `${this.#name}(${this.#id})`; }
  /** 启用拓展 */
  async enable(...args) {
    if (!this.#instance) {
      this.#instance = await import(this.#entry);
    };
    if (typeof this.#instance.onEnable !== 'function' || typeof this.#instance.onDisable !== 'function') throw new Error(`拓展“${this.fullname}”没有提供有效的入口函数，因此“${NeonaicConfManager.getBotName()}”无法加载。`);
    await this.#instance.onEnable.apply(this, args);
  }
  /** 禁用拓展 @apiNote 警惕内存泄露 */
  async disable(...args) {
    await this.#instance.onDisable.apply(this, args);
    this.#instance = null;
  }
}

export const NeonaicExtLoader = {
  MANIFEST_STRUCTURE,
};
