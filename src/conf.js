/**
 * conf.js — 配置模块
 *
 * 声明式思想：文件开头硬编码「内部名 -> 配置路径」的映射（CONFIG_PATHS），
 * 其余模块只需通过内部名读取配置，不关心配置文件的具体位置与格式。
 *
 * 解耦约定：本模块不依赖任何其他子模块，只负责读取 / 解析配置。
 *
 * 用法：
 *   import { loadConfig, loadAllConfigs } from './conf.js';
 *   const main = loadConfig('main');       // 读取内部名为 main 的配置
 *   const all = loadAllConfigs();          // 读取全部配置
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 项目根目录（用于相对配置路径的解析基准） */
const ROOT = resolve(__dirname, '..');

/** ---- 声明式：内部名 -> 配置路径（硬编码，勿依赖运行时推断）---- */
export const CONFIG_PATHS = {
  main: './config/main.json',
  websocket: './config/websocket.json',
  logger: './config/logger.json',
};

/**
 * 按内部名读取一份配置。
 * @param {string} name 内部名，如 'main' / 'websocket' / 'logger'
 * @returns {object} 解析后的配置对象
 */
export function loadConfig(name) {
  const rel = CONFIG_PATHS[name];
  if (!rel) {
    throw new Error(`未知配置项: "${name}"，可用: ${Object.keys(CONFIG_PATHS).join(', ')}`);
  }
  const filePath = resolve(ROOT, rel);
  const raw = readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

/**
 * 一次性读取全部配置。
 * @returns {Record<string, object>} 内部名 -> 配置对象
 */
export function loadAllConfigs() {
  return Object.fromEntries(
    Object.keys(CONFIG_PATHS).map((name) => [name, loadConfig(name)]),
  );
}
