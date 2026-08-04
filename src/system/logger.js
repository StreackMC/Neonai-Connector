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
 *   logger.main.error('错误');   // 输出到 Main 类型
 *   logger.info('未指定类型');   // 未指定类型时默认输出到 Main
 *   logger.log('console 重定向');// console.log 的重定向入口
 */

/**
 * 单个日志类型的实例（logger.<call> 的形态）。
 * @typedef {object} LoggerInstance
 * @property {(message: string) => void} info 输出 INFO 日志
 * @property {(message: string) => void} warn 输出 WARN 日志
 * @property {(message: string) => void} error 输出 ERROR 日志
 * @property {(message: string) => void} warning warn 的别名
 * @property {(message: string) => void} serve error 的别名
 */

/**
 * 日志器对象（createLogger 的返回值）。
 * 按内部名（call）访问各类型实例，或直接调用级别方法（默认 Other）。
 * 注意：若修改 LOG_TYPES，请同步更新本类型的属性。
 * @typedef {object} Logger
 * @property {LoggerInstance} chatIn ChatReceived 类型实例
 * @property {LoggerInstance} chatOut ChatSent 类型实例
 * @property {LoggerInstance} main Main 类型实例
 * @property {LoggerInstance} other Other 类型实例
 * @property {(message: string) => void} log console.log 重定向（Other 类型 INFO）
 * @property {(message: string) => void} info 默认 Other 类型的 INFO
 * @property {(message: string) => void} warn 默认 Other 类型的 WARN
 * @property {(message: string) => void} error 默认 Other 类型的 ERROR
 * @property {(message: string) => void} warning 默认 Other 类型的 WARN 别名
 * @property {(message: string) => void} serve 默认 Other 类型的 ERROR 别名
 * @property {(enable?: boolean) => void} redirectConsole 劫持全局 console 到 Main 日志（控制台保留原生格式化，文件尽量 toString）
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

// ---- Console 蹦床（模块加载时立即替换，确保任何后续库的 bind(console) 都抓到蹦床）----
const _origConsole = {
  debug: console.debug,
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
};
const _target = {
  debug: _origConsole.debug,
  log: _origConsole.log,
  info: _origConsole.info,
  warn: _origConsole.warn,
  error: _origConsole.error,
};

console.debug = (...a) => _target.debug.apply(console, a);
console.log   = (...a) => _target.log.apply(console, a);
console.info  = (...a) => _target.info.apply(console, a);
console.warn  = (...a) => _target.warn.apply(console, a);
console.error = (...a) => _target.error.apply(console, a);

/** 日志级别 -> 控制台标签 */
const LEVELS = {
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
};

/** 日志级别别名（未指定类型、顶层调用时同样生效） */
const LEVEL_ALIASES = {
  warning: 'warn',
  serve: 'error',
};

/** ANSI 颜色码 */
const COLORS = {
  reset: '\x1b[0m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

/** 日志级别 -> 控制台颜色（null 表示终端默认色；可在 createLogger({ levelColors }) 中覆盖） */
const LEVEL_COLORS = {
  debug: null,
  info: null,
  warn: 'yellow',
  error: 'red',
};

/** ---- 声明式：日志类型定义（硬编码，参考 Untitled-1）----
 *  key      : 类型名，用于控制台标签与日志目录命名
 *  console  : 是否输出到控制台
 *  file     : 是否写入文件
 *  call     : 代码内调用的内部名（logger.<call>.<level>()）
 *  color    : （可选）控制台类型标签的颜色，不设置则用终端默认色
 */
const LOG_TYPES = {
  ChatReceived: { console: true, file: true, call: 'chatIn' },
  ChatSent: { console: true, file: true, call: 'chatOut' },
  Main: { console: true, file: true, call: 'main' },
  Other: { console: true, file: true, call: 'other' },
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
 * @param {object} [options.types] 覆盖默认的日志类型定义（每项可含 color 字段）
 * @param {object} [options.levelColors] 覆盖默认的级别颜色，如 { error: 'red' }
 * @param {boolean} [options.colorize] 是否输出 ANSI 颜色；缺省时按终端 TTY 自动判断
 * @returns {Logger} 代理对象：logger.<call>.<level>(msg) 或 logger.<level>(msg)
 */
export function createLogger(options = {}) {
  const logDir = options.logDir ?? './logs';
  const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const levelColors = { ...LEVEL_COLORS, ...(options.levelColors ?? {}) };

  // 捕获原生 console（蹦床已设，内部输出必须走原始引用避免递归）
  const nativeConsole = {
    debug: _origConsole.debug,
    log: _origConsole.log,
    info: _origConsole.info,
    warn: _origConsole.warn,
    error: _origConsole.error,
  };

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

  /** 为文本包裹 ANSI 颜色；无该颜色名或关闭颜色时原样返回 */
  const wrap = (text, color) => (COLORS[color] ? `${COLORS[color]}${text}${COLORS.reset}` : text);

  /** 是否对某输出流启用颜色：colorize 显式指定时优先，否则按该流是否 TTY 判断 */
  const shouldColor = (stream) => options.colorize ?? stream.isTTY;

  /** 发出一条日志（控制台 + 文件）；文件始终写纯文本，控制台按需着色 */
  function emit(type, level, msg) {
    const time = formatTime();
    const tag = LEVELS[level];
    const plainLine = `[${time} | ${tag} | ${type.name}] ${msg}`;

    writeFile(type, plainLine);

    if (!type.console) return;
    const isError = level === 'error';
    const coloredLine = shouldColor(isError ? process.stderr : process.stdout)
      ? wrap(plainLine, levelColors[level])
      : plainLine;
    const out = isError ? nativeConsole.error : nativeConsole.log;
    out(coloredLine);
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

  /** 将值转为短字符串（对象/数组仅展开前 3 项，字符串超 80 字符截断） */
  function short(val) {
    if (val === null) return 'null';
    if (val === undefined) return 'undefined';
    if (typeof val === 'string') return val.length > 80 ? val.slice(0, 80) + '...' : val;
    if (val instanceof Error) return val.message ?? String(val);
    if (Array.isArray(val)) {
      const head = val.slice(0, 3).map(short);
      const tail = val.length > 3 ? ` ... (+${val.length - 3})` : '';
      return `[${head.join(', ')}${tail}]`;
    }
    if (typeof val === 'object') {
      const keys = Object.keys(val);
      const head = keys.slice(0, 3);
      const pairs = head.map((k) => `${k}: ${short(val[k])}`);
      const tail = keys.length > 3 ? ` ... (+${keys.length - 3})` : '';
      return `{${pairs.join(', ')}${tail}}`;
    }
    return String(val);
  }

  /** 将任意参数尽量转为字符串（供文件日志使用），复杂结构截断展开 */
  function toFileText(args) {
    return args.map(short).join(' ');
  }

  /** 生成全局 console 的劫持函数：文件与终端均走截断路径 */
  function makeRedirect(level, forceConsole = false) {
    return (...args) => {
      const otherType = getTypeByCall('other');
      if (!otherType) return;

      const time = formatTime();
      const tag = LEVELS[level];
      const body = toFileText(args);

      writeFile(otherType, `[${time} | ${tag} | ${otherType.name}] ${body}`);

      // 控制台：forceConsole 无视类型自身配置
      if (!forceConsole && !otherType.console) return;
      const isError = level === 'error';
      const plainLine = `[${time} | ${tag} | ${otherType.name}] ${body}`;
      const coloredLine = shouldColor(isError ? process.stderr : process.stdout)
        ? wrap(plainLine, levelColors[level])
        : plainLine;
      const method = (level === 'info' || level === 'debug') ? 'log' : level;
      nativeConsole[method](coloredLine);
    };
  }

  /**
   * 劫持全局 console 到 Other 类型日志。
   * 不直接替换 console.*（库可能已 bind 了旧引用），而是更新蹦床 _target。
   *
   * @param {boolean} enable 是否启用劫持
   * @param {boolean} [debugMode=false] 调试模式：无视类型 console 配置强制输出，
   *   且 console.log 使用 DEBUG 级别而非 INFO
   */
  function redirectConsole(enable = true, debugMode = false) {
    if (enable) {
      const logLevel = debugMode ? 'debug' : 'info';
      _target.debug = makeRedirect('debug', debugMode);
      _target.log   = makeRedirect(logLevel, debugMode);
      _target.info  = makeRedirect('info', debugMode);
      _target.warn  = makeRedirect('warn', debugMode);
      _target.error = makeRedirect('error', debugMode);
    } else {
      _target.debug = _origConsole.debug;
      _target.log   = _origConsole.log;
      _target.info  = _origConsole.info;
      _target.warn  = _origConsole.warn;
      _target.error = _origConsole.error;
    }
  }

  const cache = new Map();

  /** 代理：logger.<call>.<level>() 按内部名路由；未指定类型时默认 Other */
  return new Proxy({}, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;

      // console.log 重定向入口 -> Other 类型
      if (prop === 'log') {
        return (msg) => emit(getTypeByCall('other'), 'info', msg);
      }

      // 劫持全局 console 的方法
      if (prop === 'redirectConsole') return redirectConsole;

      // 命中类型内部名 -> 返回该类型实例
      const type = getTypeByCall(prop);
      if (type) {
        if (!cache.has(prop)) cache.set(prop, makeInstance(type));
        return cache.get(prop);
      }

      // 未命中类型：视为直接调用级别方法，默认 Other 类型（含别名）
      if (LEVELS[prop] || LEVEL_ALIASES[prop]) {
        const otherType = getTypeByCall('other');
        const level = LEVEL_ALIASES[prop] ?? prop;
        return (msg) => emit(otherType, level, msg);
      }
      return undefined;
    },
  });
}
