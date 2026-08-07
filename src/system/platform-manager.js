/**
 * platform-manager.js — 平台 Profile 生命周期管理器
 *
 * 维护三个映射：
 *   _profileClasses  profileName → Platform class
 *   _profiles       profileName → Profile 配置对象
 *   _platforms      profileName → Platform 实例
 */

import { readFileSync, writeFileSync } from 'node:fs';
import JSON5 from 'json5';

import { registerCommand } from './commandServer.js';
import { getDebugMode, getLogger } from './logger.js';
import { Config, CONFIG_PATHS, getConfig } from './conf.js';

// ---- 颜色 ----
const CYAN   = '\x1b[36m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const DIM    = '\x1b[2m';
const R      = '\x1b[0m';

/** 语法糖，获取PM */
export function getPlatformManager() {
  return PlatformManager.instance;
}

export class PlatformManager {
  /** @type {PlatformManager | null} */
  static _instance = null;

  /** @returns {PlatformManager | null} */
  static get instance() {
    return PlatformManager._instance;
  }

  /**
   * @param {object} opts
   * @param {string} opts.configPath secret.json 的绝对路径
   * @param {import('./logger.js').Logger} opts.logger
   */
  constructor({ configPath, logger }) {
    if (PlatformManager._instance) {
      throw new Error('PlatformManager 已是单例，不可重复创建');
    }

    this._configPath = configPath;
    this._logger = logger;

    /** profileName → Platform class @type {Map<String, typeof import('../platform/PlatformInterface.js').Platform>} */
    this._profileClasses = new Map();
    /** profileName → Profile 配置对象 @type {Map<String, Config>} */
    this._profiles = new Map();
    /** profileName → Platform 实例 @type {Map<String, import('../platform/PlatformInterface.js').Platform>} */
    this._platforms = new Map();
    /** profileName → close 函数 @type {Map<String, Function>} */
    this._closers = new Map();

    // 加载所有 Profiles 配置
    for (const raw of this._getRawProfiles()) {
      const profile = { ...raw, _debug: getDebugMode() };
      this._profiles.set(raw.name, profile);
    }

    PlatformManager._instance = this;
    this._registerCLI();
  }

  // ---- 内部辅助 ----

  _getRawProfiles() {
    return getConfig(CONFIG_PATHS.secret).getList('platforms');
  }

  _readConfig() {
    return JSON5.parse(readFileSync(this._configPath, 'utf8'));
  }

  _writeProfileEnabled(name, enabled) {
    const cfg = this._readConfig();
    const list = Array.isArray(cfg.platforms) ? cfg.platforms : [];
    const profile = list.find((p) => p?.name === name);
    if (profile) profile.enabled = enabled;
    writeFileSync(this._configPath, JSON5.stringify(cfg, null, 2), 'utf8');
  }

  _registerCLI() {
    registerCommand('platform', async (args) => {
      const [sub, name] = args;
      if (!sub) {
        getLogger().platM.info(
          `${RED}用法: platform ${CYAN}start|stop|enable|disable${R} ${DIM}<name>${R}  或  platform ${CYAN}list${R}\n`
        );
        return;
      }

      switch (sub) {
        case 'start':
          if (!name) { getLogger().platM.info(`${RED}用法: platform start <name>${R}\n`); return; }
          await this.start(name);
          break;
        case 'stop':
          if (!name) { getLogger().platM.info(`${RED}用法: platform stop <name>${R}\n`); return; }
          await this.stop(name);
          break;
        case 'enable':
          if (!name) { getLogger().platM.info(`${RED}用法: platform enable <name>${R}\n`); return; }
          this.enable(name);
          break;
        case 'disable':
          if (!name) { getLogger().platM.info(`${RED}用法: platform disable <name>${R}\n`); return; }
          await this.disable(name);
          break;
        case 'list':
          this.list();
          break;
        default:
          getLogger().platM.warn(
            `${RED}未知子命令: ${sub}${R}\n` +
            `${DIM}用法: platform ${CYAN}start|stop|enable|disable${R} ${DIM}<name>  或  platform ${CYAN}list${R}\n`
          );
      }
    }, {
      description: '平台 Profile 生命周期管理',
      usage: 'platform start|stop|enable|disable|list [name]',
    });
  }

  // ---- 公开查询方法 ----

  /** profileName → Platform class */
  getProfileClass(name) { return this._profileClasses.get(name); }
  /** profileName → Profile 配置对象 */
  getProfile(name) { return this._profiles.get(name); }
  /** profileName → Platform 实例 */
  getPlatform(name) { return this._platforms.get(name); }

  // ---- 生命周期方法 ----

  /**
   * 注册 Platform 类，并为匹配 Profiles 创建实例。
   * @param {{ new(profile: string): import('../platform/PlatformInterface.js').Platform }} Cls
   */
  _registerClass(Cls) {
    if (this._profileClasses.has(Cls.type)) {
      throw new Error(`Platform 类 "${Cls.type}" 已被注册`);
    }

    for (const [name, profile] of this._profiles) {
      if (profile.type !== Cls.type) continue;

      this._profileClasses.set(name, Cls);
      const platform = new Cls(name);
      this._platforms.set(name, platform);

      this._logger.main.info(
        `Platform "${name}" (${Cls.type}) 已注册（${profile.enabled ? '已启用' : '已禁用'}）`
      );
    }
  }

  /** 获取所有 closers（供 entry.js 优雅关闭使用） */
  getClosers() {
    return [...this._closers.values()];
  }

  /**
   * 启动指定 Profile。
   * @param {string} name Profile 名称
   */
  async start(name) {
    const profile = this._profiles.get(name);
    if (!profile) {
      getLogger().platM.info(`${RED}未知 Profile: ${name}${R}\n`);
      return;
    }
    if (!profile.enabled) {
      getLogger().platM.info(`${YELLOW}${name}${R} Profile 未启用\n`);
      return;
    }
    const platform = this._platforms.get(name);
    if (!platform) {
      getLogger().platM.info(`${YELLOW}${name}${R} 无匹配的 Platform 实现\n`);
      return;
    }
    if (this._closers.has(name)) {
      getLogger().platM.info(`${YELLOW}${name}${R} Profile 已在运行中\n`);
      return;
    }

    this._logger.main.info(`正在启动 Profile "${name}"`);
    try {
      const result = await platform.start();
      if (typeof result === 'function') {
        this._closers.set(name, result);
      } else if (result && typeof result.close === 'function') {
        this._closers.set(name, () => result.close());
      } else {
        this._closers.set(name, () => {});
      }
      getLogger().platM.info(`${GREEN}${name}${R} Profile 已启动\n`);
    } catch (err) {
      getLogger().platM.info(`${RED}Profile ${name} 启动失败: ${err.message}${R}\n`);
    }
  }

  /**
   * 停止指定 Profile。
   * @param {string} name
   */
  async stop(name) {
    if (!this._profiles.has(name)) {
      getLogger().platM.info(`${RED}未知 Profile: ${name}${R}\n`);
      return;
    }

    this._logger.main.info(`正在停止 Profile "${name}"`);
    const closer = this._closers.get(name);
    if (closer) {
      try { await closer(); } catch { /* 忽略关闭错误 */ }
    }
    this._closers.delete(name);
    getLogger().platM.info(`${GREEN}${name}${R} Profile 已停止\n`);
  }

  /**
   * 启用 Profile（写回 secret.json）。
   * @param {string} name
   */
  enable(name) {
    const profile = this._profiles.get(name);
    if (!profile) {
      getLogger().platM.info(`${RED}未知 Profile: ${name}${R}\n`);
      return;
    }
    if (profile.enabled) {
      getLogger().platM.info(`${YELLOW}${name}${R} Profile 已启用\n`);
      return;
    }
    this._writeProfileEnabled(name, true);
    profile.enabled = true;
    getLogger().platM.info(`${GREEN}${name}${R} Profile 已启用（需手动 start 或重启生效）\n`);
  }

  /**
   * 禁用 Profile（正在运行则先停止）。
   * @param {string} name
   */
  async disable(name) {
    const profile = this._profiles.get(name);
    if (!profile) {
      getLogger().platM.info(`${RED}未知 Profile: ${name}${R}\n`);
      return;
    }
    if (!profile.enabled) {
      getLogger().platM.info(`${YELLOW}${name}${R} Profile 已禁用\n`);
      return;
    }
    if (this._closers.has(name)) {
      await this.stop(name);
    }
    this._writeProfileEnabled(name, false);
    profile.enabled = false;
    getLogger().platM.info(`${GREEN}${name}${R} Profile 已禁用\n`);
  }

  /** 列出所有 Profile 状态 */
  list() {
    if (this._profiles.size === 0) {
      getLogger().platM.info(`${DIM}暂无 Profile${R}\n`);
      return;
    }

    let output = '';
    for (const [name, profile] of this._profiles) {
      const isRunning = this._closers.has(name);
      const status = isRunning
        ? `${GREEN}运行中${R}`
        : profile.enabled
          ? `${YELLOW}已停止${R}`
          : `${DIM}已禁用${R}`;
      output += `  ${CYAN}${name}${R} (${DIM}${profile.type}${R})  ${status}\n`;
    }
    getLogger().platM.info(output);
  }

  /** 启动所有 enabled 的 Profile */
  async loadEnabled() {
    for (const [name, profile] of this._profiles) {
      if (profile.enabled) {
        await this.start(name);
      }
    }
  }
}

/**
 * Platform 实现模块在 import 时调用此函数注册。
 * @param {{ new(profile: string): import('../platform/PlatformInterface.js').Platform }} Cls
 */
export function registerPlatform(Cls) {
  const pm = PlatformManager.instance;
  if (!pm) {
    throw new Error('PlatformManager 尚未初始化，请确保在 system/entry.js 中先 new PlatformManager');
  }
  pm._registerClass(Cls);
}
