/**
 * logger.js — 分模块日志
 *
 * 声明式思想：文件开头硬编码日志类型定义（LOG_TYPES），
 * 每种类型声明是否输出到控制台 / 文件，以及代码内调用的内部名（call）。
 *
 * 日志格式（参考项目设计）：
 *   控制台:  [2026-08-04 19:03:01 | INFO | WebSocket] msg....
 *   文件:    /logs/WebSocket/latest.log
 *   轮转:    latest.log 超过大小上限或跨天后压缩为 <日期>.log.gz 并重建
 *
 * 解耦约定：本模块不依赖其他子模块，通过工厂函数 createLogger(options)
 * 接收配置（日志目录、大小上限等），由调用方（组合根）注入。
 *
 * 用法：
 *   import { createLogger } from './logger.js';
 *   const logger = createLogger({ logDir: './logs' });
 *
 *   logger.ws.info('消息');      // 输出到 WebSocket 类型
 *   logger.main.error('错误');   // 输出到 Main 类型
 *   logger.info('未指定类型');   // 未指定类型时默认输出到 Main
 *   logger.log('console 重定向');// console.log 的重定向入口
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

/** 日志级别 -> 控制台标签 */
const LEVELS = {
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
};

/** 日志级别别名（未指定类型、顶层调用时同样生效） */
const LEVEL_ALIASES = {
  warning: 'warn',
  serve: 'error',
};

/** ---- 声明式：日志类型定义（硬编码，参考 Untitled-1）----
 *  key      : 类型名，用于控制台标签与日志目录命名
 *  console  : 是否输出到控制台
 *  file     : 是否写入文件
 *  call     : 代码内调用的内部名（logger.<call>.<level>()）
 */
const LOG_TYPES = {
  WebSocket: { console: true, file: true, call: 'ws' },
  Chat: { console: true, file: true, call: 'chat' },
  Main: { console: true, file: true, call: 'main' },
};

/** 默认单文件大小上限（字节），超过即轮转 */
const DEFAULT_MAX_FILE_SIZE = 1024 * 1024;

/** 补零到两位 */
const pad = (n) => String(n).padStart(2, '0');

/** 日期字符串，如 2026-08-04 */
function formatDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 时间字符串，如 2026-08-04 19:03:01 */
function formatTime(d = new Date()) {
  return `${formatDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 创建日志器。
 * @param {object} [options] 配置项
 * @param {string} [options.logDir] 日志根目录，默认 './logs'
 * @param {number} [options.maxFileSize] 单文件大小上限（字节）
 * @param {object} [options.types] 覆盖默认的日志类型定义
 * @returns {object} 代理对象：logger.<call>.<level>(msg) 或 logger.<level>(msg)
 */
export function createLogger(options = {}) {
  const logDir = options.logDir ?? './logs';
  const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;

  // 归一化类型定义：为每个类型补充 name 字段
  const types = Object.fromEntries(
    Object.entries(options.types ?? LOG_TYPES).map(([name, def]) => [name, { ...def, name }]),
  );

  // 预创建各类型的日志目录
  for (const type of Object.values(types)) {
    mkdirSync(join(logDir, type.name), { recursive: true });
  }

  /** 按内部名查找类型定义 */
  function getTypeByCall(call) {
    return Object.values(types).find((t) => t.call === call) ?? null;
  }

  /** 写入日志文件，写入前按需轮转 */
  function writeFile(type, line) {
    if (!type.file) return;
    const filePath = join(logDir, type.name, 'latest.log');
    rotateIfNeeded(filePath);
    appendFileSync(filePath, `${line}\n`, 'utf8');
  }

  /** 轮转：跨天或文件过大时，将 latest.log 压缩为 <日期>.log.gz 并重建 */
  function rotateIfNeeded(filePath) {
    if (!existsSync(filePath)) return;
    const stat = statSync(filePath);
    const today = formatDate();
    const mtime = formatDate(stat.mtime);
    const tooLong = stat.size >= maxFileSize;
    if (mtime === today && !tooLong) return;
    const archivePath = join(dirname(filePath), `${mtime}.log.gz`);
    writeFileSync(archivePath, gzipSync(readFileSync(filePath)));
    rmSync(filePath);
  }

  /** 发出一条日志（控制台 + 文件） */
  function emit(type, level, msg) {
    const line = `[${formatTime()} | ${LEVELS[level]} | ${type.name}] ${msg}`;
    if (type.console) {
      const out = level === 'error' ? console.error : console.log;
      out(line);
    }
    writeFile(type, line);
  }

  /** 为某类型创建实例（含各级别方法及别名） */
  function makeInstance(type) {
    const instance = {
      info: (msg) => emit(type, 'info', msg),
      warn: (msg) => emit(type, 'warn', msg),
      error: (msg) => emit(type, 'error', msg),
    };
    instance.warning = instance.warn; // warn 的别名
    instance.serve = instance.error;  // error 的别名（serve）
    return instance;
  }

  const cache = new Map();

  /** 代理：logger.<call>.<level>() 按内部名路由；未指定类型时默认 Main */
  return new Proxy({}, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;

      // console.log 重定向入口 -> Main 类型
      if (prop === 'log') {
        return (msg) => emit(getTypeByCall('main'), 'info', msg);
      }

      // 命中类型内部名 -> 返回该类型实例
      const type = getTypeByCall(prop);
      if (type) {
        if (!cache.has(prop)) cache.set(prop, makeInstance(type));
        return cache.get(prop);
      }

      // 未命中类型：视为直接调用级别方法，默认 Main 类型（含别名）
      if (LEVELS[prop] || LEVEL_ALIASES[prop]) {
        const mainType = getTypeByCall('main');
        const level = LEVEL_ALIASES[prop] ?? prop;
        return (msg) => emit(mainType, level, msg);
      }
      return undefined;
    },
  });
}
