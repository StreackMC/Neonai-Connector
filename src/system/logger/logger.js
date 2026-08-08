/**
 * logger.js — 分模块日志系统
 *
 * 模块加载时立即劫持 console.* 为蹦床，后续由 redirectConsole 控制目标。
 * 所有日志接口接受无限参数。调试模式（_isDebug）强制输出到原生 console，
 * 非调试模式按类型配置带颜色输出。文件日志始终走截断路径，
 * 所有类型共用一个日志文件（不按类型分文件夹）。
 * 日志轮转惰性触发，最小检测间隔挂在 logger.<call>.checker 上。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { getConfig, CONFIG_PATHS } from '../conf.js';
import { DEBUGING, ROOT_PATH } from '../entry.js';

// ---- 常量与工具函数 ----
const LEVELS = { debug: 'DEBUG', info: 'INFO', warn: 'WARN', error: 'ERROR' };
const LEVEL_COLORS = { debug: null, info: null, warn: 'yellow', error: 'red' };

const COLORS = {
  reset: '\x1b[0m', gray: '\x1b[90m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', white: '\x1b[37m',
};

/** 声明式日志类型 */
const LOG_TYPES = {
  Main: { console: true, file: true, call: 'main' },
  Other: { console: true, file: true, call: 'other' },
  "Chat:Received": { console: true, file: true, call: 'chatIn' },
  "Chat:Sent": { console: true, file: true, call: 'chatOut' },
  "Toolcall:AI": { console: true, file: true, call: 'toolAi' },
  "Platform:Manager": { console: true, file: true, call: 'platM' },
  "Platform:Profile": { console: true, file: true, call: 'platP' },
  Command: { console: true, file: true, call: 'cmd' },
};

/**
 * 日志器对象（`createLogger` / `getLogger` 的返回值）。
 * @typedef {object} Logger
 * @property {LoggerInstance} main
 * @property {LoggerInstance} other
 * @property {LoggerInstance} chatIn
 * @property {LoggerInstance} chatOut
 * @property {LoggerInstance} platM
 * @property {LoggerInstance} platP
 * @property {LoggerInstance} toolAi
 * @property {LoggerInstance} cmd
 * @property {(...args: any[]) => void} log         无类型默认日志（走 Other）
 * @property {(err?: Error) => void} writeCrashReport
 * @property {(enable?: boolean, |debugMode?: boolean) => void} redirectConsole
 * @property {(...args: any[]) => void} info        无类型默认 INFO（走 Other）
 * @property {(...args: any[]) => void} warn        无类型默认 WARN（走 Other）
 * @property {(...args: any[]) => void} error       无类型默认 ERROR（走 Other）
 * @property {(...args: any[]) => void} debug       无类型默认 DEBUG（走 Other）
 */

/**
 * 单个日志类型的实例（如 `logger.main`）。
 * @typedef {object} LoggerInstance
 * @property {(...args: any[]) => void} debug
 * @property {(...args: any[]) => void} info
 * @property {(...args: any[]) => void} warn
 * @property {(...args: any[]) => void} error
 * @property {{ last: number }} checker  轮转检测时间戳
 */

const DEFAULT_MAX_FILE_SIZE = 1024 * 1024;
const ROTATE_CHECK_MS = 500; // 最小轮转检测间隔（ms）

const pad = (n) => String(n).padStart(2, '0');
function formatDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function formatTime(d = new Date()) {
  return `${formatDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ---- Console 蹦床（模块加载时立即执行）----
const _orig = {
  debug: console.debug,
  log:   console.log,
  info:  console.info,
  warn:  console.warn,
  error: console.error,
};

let _logger = null;

let _target = {
  debug: _orig.debug,
  log:   _orig.log,
  info:  _orig.info,
  warn:  _orig.warn,
  error: _orig.error,
};

console.debug = (...a) => _target.debug.apply(console, a);
console.log   = (...a) => _target.log  .apply(console, a);
console.info  = (...a) => _target.info .apply(console, a);
console.warn  = (...a) => _target.warn .apply(console, a);
console.error = (...a) => _target.error.apply(console, a);

// ---- 全局调试标志（由 entry.js 通过 setDebugMode 控制）----
let _isDebug = false;
export function setDebugMode(on) { _isDebug = !!on; }
export function getDebugMode(on) { return !!_isDebug; }

// ---- 控制台输出钩子（与 REPL 协作：输出前清 prompt，输出后重绘）----
let _beforeWrite = null;
let _afterWrite = null;

/**
 * 设置控制台输出钩子（由 entry.js 在启动 REPL 后注入）。
 * @param {() => void} [before] 输出到控制台前调用（清掉当前 prompt）
 * @param {() => void} [after] 输出到控制台后调用（重绘 prompt）
 */
export function setConsoleHooks(before, after) {
  _beforeWrite = before ?? null;
  _afterWrite = after ?? null;
}

/**
 * 尝试将输入尽可能地转化为文本
 * @param {boolean} [short] 是否要截断:会只枚举前3个属性/对象；当调试模式时默认禁用，反之同理。**必须显式指定布尔值类型才可覆盖**
 */
export function parseString(val, short) {
  if (typeof short !== 'boolean') short = !(DEBUGING || getConfig(CONFIG_PATHS.main).getBoolean('detailedLog', false));
  if (val === null) return 'null';
  if (val === undefined) return 'undefined';
  if (typeof val === 'string') return val;
  if (val instanceof Error) return val.message ?? String(val);
  if (Array.isArray(val)) {
    if (!short) return `[${val.map(parseString).join(', ').replace(/\n/g, '\\n')}]`;
    const head = val.slice(0, 3).map(parseString);
    const tail = val.length > 3 ? ` ... (+${val.length - 3})` : '';
    return `[${head.join(', ').replace(/\n/g, '\\n') }${tail}]`;
  }
  if (typeof val === 'object') {
    const keys = Object.keys(val);
    if (!short) {
      const pairs = keys.map((k) => `${k}: '${parseString(val[k])}'`);
      return `{${pairs.join(', ').replace(/\n/g, '\\n') }}`;
    }
    const head = keys.slice(0, 3);
    const pairs = head.map((k) => `${k}: '${parseString(val[k])}'`);
    const tail = keys.length > 3 ? ` ... (+${keys.length - 3})` : '';
    return `{${pairs.join(', ').replace(/\n/g, '\\n') }${tail}}`;
  }
  return String(val);
}

function toText(args) { return args.map(parseString).join(' '); }

/**
 * 创建日志器。
 * @param {object} [options]
 * @param {string} [options.logDir]
 * @param {number} [options.maxFileSize]
 * @returns {Logger}
 */
export function createLogger(options = {}) {
  const logDir      = options.logDir ?? './logs';
  const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const levelColors = { ...LEVEL_COLORS, ...(options.levelColors ?? {}) };
  const native      = { ..._orig };

  const types = Object.fromEntries(
    Object.entries(options.types ?? LOG_TYPES).map(([name, def]) => [name, { ...def, name }]),
  );

  // 预建日志目录 + 共享轮转检测器
  mkdirSync(logDir, { recursive: true });
  const fileChecker = { last: 0 };

  const getType  = (call) => Object.values(types).find((t) => t.call === call) ?? null;
  const wrap     = (text, color) => (COLORS[color] ? `${COLORS[color]}${text}${COLORS.reset}` : text);
  const colorize = (s) => options.colorize ?? s.isTTY;

  // ---- 轮转 ----
  function archiveName(filePath, date) {
    let n = 0, p;
    do { p = join(dirname(filePath), `${date}${n === 0 ? '' : `-${n}`}.log.gz`); n++; }
    while (existsSync(p));
    return p;
  }

  function rotateIfOversize(filePath) {
    if (!existsSync(filePath)) return;
    if (statSync(filePath).size < maxFileSize) return;
    writeFileSync(archiveName(filePath, formatDate()), gzipSync(readFileSync(filePath)));
    rmSync(filePath);
  }

  // ---- 核心：发日志 ----
  /** @param {Date} [timestamp=new Date()] */
  function emit(type = getType('other'), level, timestamp = new Date(), ...msgs) {
    if (!type) type = getType('other');
    const time = formatTime(timestamp);
    const tag  = LEVELS[level];
    // 控制台与文件统一复用同一套 short/toText 截断逻辑
    const body = toText(msgs);
    const prefix = `[${time} | ${tag} | ${type.name}]`;
    const line = `${prefix} ${body}`;

    // ---- 控制台 ----
    const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : level === 'debug' ? 'debug' : 'log';
    if (_isDebug) {
      // 调试模式：强制走原生 console（无颜色）
      _beforeWrite?.();
      native[method](line);
      _afterWrite?.();
    } else if (type.console) {
      // 正常模式：仅级别标签着色，正文与文件一致
      _beforeWrite?.();
      const coloredPrefix = colorize(level === 'error' ? process.stderr : process.stdout)
        ? `[${time} | ${wrap(tag, levelColors[level])} | ${type.name}]`
        : prefix;
      native[method](`${coloredPrefix} ${body}`);
      _afterWrite?.();
    }

    // ---- 文件：所有类型共用一个日志文件 ----
    if (type.file) {
      const fp = join(logDir, 'latest.log');
      if (Date.now() - fileChecker.last > ROTATE_CHECK_MS) {
        fileChecker.last = Date.now();
        rotateIfOversize(fp);
      }
      appendFileSync(fp, `${line}\n`, 'utf8');
    }
  }

  // ---- console 劫持 ----
  const REDIRECT_CALL = 'other';
  injectLog4js(emit);

  function makeRedirect(level) {
    return (...args) => {
      const t = getType(REDIRECT_CALL);
      if (!t) return;
      emit(t, level, new Date(), ...args);
    };
  }

  function redirectConsole(on = true) {
    if (on) {
      _target.debug = makeRedirect('debug');
      _target.log   = makeRedirect('info');
      _target.info  = makeRedirect('info');
      _target.warn  = makeRedirect('warn');
      _target.error = makeRedirect('error');
    } else {
      _target = { debug: _orig.debug, log: _orig.log, info: _orig.info, warn: _orig.warn, error: _orig.error };
    }
  }

  // ---- 类型实例 + checker ----
  const cache = new Map();

  function instance(type) {
    return {
      debug: (...a) => emit(type, 'debug', new Date(), ...a),
      info:  (...a) => emit(type, 'info', new Date(), ...a),
      warn:  (...a) => emit(type, 'warn', new Date(), ...a),
      error: (...a) => emit(type, 'error', new Date(), ...a),
      checker: fileChecker,
    };
  }

  // ---- 写崩溃报告 ----
  function writeCrashReport(err) {
    const d = new Date();
    const ts = `${formatDate(d)}-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}-${String(d.getMilliseconds()).padStart(4, '0')}`;
    const dir = join(logDir, 'crashes');
    mkdirSync(dir, { recursive: true });
    const rpt = [
      `Crash Report — ${ts}`,
      `PID: ${process.pid}`,
      `Node: ${process.version}`,
      `OS: ${process.platform} ${process.release}`,
      `Type: ${err?.name ?? 'Error'}`,
      `Message: ${err?.message ?? String(err)}`,
      err?.stack ? `\nStack:\n${err.stack}` : '',
    ].join('\n');
    writeFileSync(join(dir, `${ts}.log`), rpt, 'utf8');
  }

  // ---- Proxy ----
  return new Proxy({}, {
    get(_, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop === 'log')               return (...a) => emit(getType(REDIRECT_CALL), 'info', new Date(), ...a);
      if (prop === 'redirectConsole')   return redirectConsole;
      if (prop === 'writeCrashReport')  return writeCrashReport;

      const t = getType(prop);
      if (t) {
        if (!cache.has(prop)) cache.set(prop, instance(t));
        return cache.get(prop);
      }

      if (LEVELS[prop]) {
        const ot = getType(REDIRECT_CALL);
        return (...a) => emit(ot, prop, new Date(), ...a);
      }

      return undefined;
    },
  });
}

import log4js from 'log4js';
import { putEmit } from './log4js_inject.js';
/** 注入 Log4js @param {Function} emit */
function injectLog4js(emit) {
  putEmit(emit);
  log4js.configure({
    appenders: {
      // 使用自定义 appender
      cliForward: {
        type: join(ROOT_PATH, 'src', 'system', 'logger', 'log4js_inject.js')
      }
    },
    categories: {
      default: { appenders: ['cliForward'], level: 'all' },
    }
  });
}

/**
 * 获取日志器（首次调用时创建）。
 *
 * @returns {Logger} 共享日志器实例
 */
export function getLogger() {
  if (!_logger) {
    _logger = createLogger({ logDir: './logs', maxFileSize: getConfig(CONFIG_PATHS.main).getInt('maxLogFileSize', 1048576) });
  }
  return _logger;
}