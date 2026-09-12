/**
 * confManager.js — 配置模块（SConfig API 风格）
 *
 * 按路径创建 Config 实例：`new NeonaicConfig(path)` 读取单个配置文件，
 * 或 `getConfig(path)` 获取（按路径缓存的）单例。
 * 支持点号嵌套路径（如 "qqbot.appid"），每个 getter 均有默认值回退。
 * 通过 set(key, value) + save() 支持写回文件。
 *
 * 仅支持 JSON5 格式（覆盖 JSON / JSONC）。
 */

import { neonaicCommandInterface } from '../command/commandInterface.js';
import { getLogger } from '../logger/Logger.js';
import { NeonaicConfig } from './NeonaicConfig.js';

/** 内部名 → 配置文件相对路径 */
const CONFIG_PATHS = Object.freeze({
  app: './package.json',
  main: './config/main.json',
  secret: './secret.json',
});

/** @type {Map<string, import('./NeonaicConfig.js').NeonaicConfig>} */
const _cache = new Map();

/**
 * 按路径获取配置单例（首次调用时创建并缓存）。
 * @param {string} path 配置文件路径（相对项目根或绝对路径）
 * @returns {NeonaicConfig} 该路径对应的共享配置实例
 */
function getConfig(path) {
  if (!_cache.has(path)) _cache.set(path, new NeonaicConfig(path));
  return _cache.get(path);
}

/** reload 命令处理器（清空配置缓存） */
function reloadCmd() {
  _cache.clear();
  /** @type { import('../command/commandServer.js').NeonaicCommandContext } */
  const ctx = this;
  if (ctx?.internalCall) getLogger().main.info('配置文件已由控制台权限重载');
  else getLogger().main.info(`配置文件已由${ctx?.executor?.[0] ?? '未知'}重载`);
  return;
}
reloadCmd.meta = {
  permissions: [[neonaicCommandInterface.COMMAND_ENUMS.PERM_SUPERADMIN, 'neonaic.command.reload']],
  description: '立即重载配置文件。对部分功能不生效，需要手动重启。',
};

/**
 * 安装配置相关命令（由组合根在 commandServer 就绪后调用，避免循环依赖）。
 * @param {(namespace: string, name: string, handler: Function, meta?: object) => void} register 命令注册函数
 */
function installConfigCommands(register) {
  register('neonaic', 'reload', reloadCmd, reloadCmd.meta);
}

/** 语法糖：获取机器人名称 */
function getBotName() {
  return getConfig(CONFIG_PATHS.main).getString('name');
}
/** 语法糖：获取机器人次要名称 */
function getBotSubName() {
  return getConfig(CONFIG_PATHS.main).getString('subname');
}

export const neonaicConfManager = {
  CONFIG_PATHS,
  getConfig,
  installConfigCommands,
  getBotName,
  getBotSubName,
};
