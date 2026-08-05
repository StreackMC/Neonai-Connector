/**
 * conf.js — 配置模块
 *
 * 声明式思想：文件开头硬编码「内部名 -> 配置路径」的映射（CONFIG_PATHS），
 * 其余模块只需通过内部名读取配置，不关心配置文件的具体位置与格式。
 *
 * 解耦约定：本模块不依赖任何其他子模块，只负责读取 / 解析配置。
 *
 * 配置格式：使用 JSON5 解析，因此同时支持：
 *   - 严格 JSON（向后兼容）
 *   - JSONC：单行 // 与多行 /* *\/ 注释、尾逗号
 *   - JSON5：单引号字符串、无引号键名、十六进制数、+Infinity / NaN 等
 *
 * 用法：
 *   import { loadConfig, loadAllConfigs } from './conf.js';
 *   const main = loadConfig('main');       // 读取内部名为 main 的配置
 *   const all = loadAllConfigs();          // 读取全部配置
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSON5 from 'json5';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 项目根目录（用于相对配置路径的解析基准） */
const ROOT = resolve(__dirname, '../..');

/** ---- 声明式：内部名 -> 配置路径（硬编码，勿依赖运行时推断）---- */
export const CONFIG_PATHS = {
  app: './package.json',
  main: './config/main.json',
  logger: './config/logger.json',
  secret: './secret.json',
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
  return JSON5.parse(raw);
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

let _configs = null;

/**
 * 获取全部配置（惰性单例，供各模块复用）。
 * @returns {Record<string, object>} 内部名 -> 配置对象
 */
export function getConfigs() {
  if (!_configs) _configs = loadAllConfigs();
  return _configs;
}
