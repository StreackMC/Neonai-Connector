/**
 * platform-manager.js — 平台生命周期管理器
 *
 * 职责：
 *   - 维护平台注册表（name → lifecycle / enabled / running）
 *   - 提供 start / stop / enable / disable / list 操作
 *   - enable / disable 直接写入 config/main.json
 *   - 注册 platform CLI 命令
 *
 * 用法（在 system/entry.js 中）：
 *   import { createPlatformManager } from './platform-manager.js';
 *   const pm = createPlatformManager({ configPath, logger });
 *   await import('../platform/qqbot.js'); // 触发 registerPlatform()
 *   await pm.loadEnabled();
 *
 * 平台模块中注册：
 *   import { Platform } from '../platform/Platform.js';
 *   import { registerPlatform } from '../system/platform-manager.js';
 *   class PlatformQQBot extends Platform { ... }
 *   registerPlatform(new PlatformQQBot());
 */

import { readFileSync, writeFileSync } from 'node:fs';
import JSON5 from 'json5';

import { registerCommand } from './commandServer.js';
import { getLogger } from './logger.js';

// ---- 颜色 ----
const CYAN   = '\x1b[36m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const DIM    = '\x1b[2m';
const R      = '\x1b[0m';

/** 当前实例（供 registerPlatform 使用，由 createPlatformManager 设置） */
let _pm = null;

/**
 * 获取平台管理器单例（未初始化时返回 null）。
 * @returns {object | null} 平台管理器实例
 */
export function getPM() {
  return _pm;
}

/**
 * 平台模块在 import 时调用此函数注册自身。
 *
 * @param {import('../platform/Platform.js').Platform} platform 平台实例
 */
export function registerPlatform(platform) {
  if (!_pm) {
    throw new Error('PlatformManager 尚未初始化，请确保在 system/entry.js 中先调用 createPlatformManager');
  }
  _pm._register(platform);
}

/**
 * 创建平台管理器。
 *
 * @param {object} opts
 * @param {string} opts.configPath config/main.json 的绝对路径
 * @param {import('./logger.js').Logger} opts.logger
 */
export function createPlatformManager({ configPath, logger }) {
  /** @type {Map<string, { platform: import('../platform/Platform.js').Platform, enabled: boolean, running: boolean }>} */
  const registry = new Map();

  /** 正在运行的平台 close 函数集合 */
  const closers = new Map();

  // ---- 内部方法 ----

  /** 读取当前配置 */
  function readConfig() {
    return JSON5.parse(readFileSync(configPath, 'utf8'));
  }

  /** 将 listening 变更写回配置文件 */
  function writeListening(update) {
    const cfg = readConfig();
    cfg.listening = { ...(cfg.listening ?? {}), ...update };
    writeFileSync(configPath, JSON5.stringify(cfg, null, 2), 'utf8');
  }

  // ---- 公开方法 ----

  const pm = {
    /** 供 registerPlatform 调用的内部注册 */
    _register(platform) {
      const cfg = readConfig();
      const name = platform.name;
      const enabled = cfg?.listening?.[name]?.enabled ?? false;
      registry.set(name, { platform, enabled, running: false });
      logger.main.info(`平台 "${name}" 已注册（${enabled ? '已启用' : '已禁用'}）`);
    },

    /** 获取所有 closers（供 entry.js 优雅关闭使用） */
    getClosers() {
      return [...closers.values()];
    },

    /** 启动指定平台 */
    async start(name) {
      const entry = registry.get(name);
      if (!entry) {
        getLogger().platM.info(`${RED}未知平台: ${name}${R}\n`);
        return;
      }
      if (entry.running) {
        getLogger().platM.info(`${YELLOW}${name}${R} 已在运行中\n`);
        return;
      }

      logger.main.info(`正在启动平台 "${name}"`);
      try {
        const result = await entry.platform.start();
        entry.running = true;

        // 收集 close 函数
        if (typeof result === 'function') {
          closers.set(name, result);
        } else if (result && typeof result.close === 'function') {
          closers.set(name, () => result.close());
        } else {
          closers.set(name, () => {});
        }

        getLogger().platM.info(`${GREEN}${name}${R} 已启动\n`);
      } catch (err) {
        getLogger().platM.info(`${RED}启动 ${name} 失败: ${err.message}${R}\n`);
      }
    },

    /** 停止指定平台 */
    async stop(name) {
      const entry = registry.get(name);
      if (!entry) {
        getLogger().platM.info(`${RED}未知平台: ${name}${R}\n`);
        return;
      }
      if (!entry.running) {
        getLogger().platM.info(`${YELLOW}${name}${R} 未在运行\n`);
        return;
      }

      logger.main.info(`正在停止平台 "${name}"`);
      const closer = closers.get(name);
      if (closer) {
        try { await closer(); } catch { /* 忽略关闭错误 */ }
      }
      closers.delete(name);
      entry.running = false;
      getLogger().platM.info(`${GREEN}${name}${R} 已停止\n`);
    },

    /** 在配置中启用平台 */
    enable(name) {
      if (!registry.has(name)) {
        getLogger().platM.info(`${RED}未知平台: ${name}${R}\n`);
        return;
      }
      const entry = registry.get(name);
      if (entry.enabled) {
        getLogger().platM.info(`${YELLOW}${name}${R} 已启用\n`);
        return;
      }
      writeListening({ [name]: true });
      entry.enabled = true;
      getLogger().platM.info(`${GREEN}${name}${R} 已启用（需手动 start 或重启生效）\n`);
    },

    /** 在配置中禁用平台（若正在运行则先停止） */
    async disable(name) {
      if (!registry.has(name)) {
        getLogger().platM.info(`${RED}未知平台: ${name}${R}\n`);
        return;
      }
      const entry = registry.get(name);
      if (!entry.enabled) {
        getLogger().platM.info(`${YELLOW}${name}${R} 已禁用\n`);
        return;
      }
      if (entry.running) {
        await pm.stop(name);
      }
      writeListening({ [name]: false });
      entry.enabled = false;
      getLogger().platM.info(`${GREEN}${name}${R} 已禁用\n`);
    },

    /** 列出所有平台状态 */
    list() {
      if (registry.size === 0) {
        getLogger().platM.info(`${DIM}暂无已注册平台${R}\n`);
        return;
      }

      let output = '';
      for (const [name, entry] of registry) {
        const status = entry.running
          ? `${GREEN}运行中${R}`
          : entry.enabled
            ? `${YELLOW}已停止${R}`
            : `${DIM}已禁用${R}`;
        output += `  ${CYAN}${name}${R}  ${status}\n`;
      }
      getLogger().platM.info(output);
    },

    /** 加载所有 enabled 平台（启动时调用） */
    async loadEnabled() {
      for (const [name, entry] of registry) {
        if (entry.enabled) {
          await pm.start(name);
        }
      }
    },
  };

  _pm = pm;

  // ---- CLI 命令 ----

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
        await pm.start(name);
        break;
      case 'stop':
        if (!name) { getLogger().platM.info(`${RED}用法: platform stop <name>${R}\n`); return; }
        await pm.stop(name);
        break;
      case 'enable':
        if (!name) { getLogger().platM.info(`${RED}用法: platform enable <name>${R}\n`); return; }
        pm.enable(name);
        break;
      case 'disable':
        if (!name) { getLogger().platM.info(`${RED}用法: platform disable <name>${R}\n`); return; }
        await pm.disable(name);
        break;
      case 'list':
        pm.list();
        break;
      default:
        getLogger().platM.info(
          `${RED}未知子命令: ${sub}${R}\n` +
          `${DIM}用法: platform ${CYAN}start|stop|enable|disable${R} ${DIM}<name>  或  platform ${CYAN}list${R}\n`
        );
    }
  }, {
    description: '平台生命周期管理',
    usage: 'platform start|stop|enable|disable|list [name]',
  });

  return pm;
}
