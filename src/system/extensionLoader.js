/**
 * system/extensionLoader.js — 扩展自动发现加载器
 *
 * 启动时扫描 extensions/ 目录，动态 import 所有扩展模块，
 * 无需在代码中硬编码路径。
 */

import { readdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLogger } from './logger/Logger.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EXT_DIR = resolve(ROOT, 'extensions');

/**
 * 加载所有扩展。
 * 扫描 extensions/handler/ 和 extensions/platform/ 下的一级子目录，
 * 每个子目录的 index.js 视为入口。
 */
export async function loadExtensions() {
  const log = getLogger().main;

  for (const category of ['handler', 'platform']) {
    const dir = resolve(EXT_DIR, category);
    if (!existsSync(dir)) continue;

    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const modPath = resolve(dir, entry.name, 'index.js');
      if (!existsSync(modPath)) continue;

      try {
        await import(`file://${modPath}`);
        log.debug(`已加载扩展: extensions/${category}/${entry.name}`);
      } catch (err) {
        log.warn(`扩展加载失败 extensions/${category}/${entry.name}: ${err.message}`);
      }
    }
  }
}
