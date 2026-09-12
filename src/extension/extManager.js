/**
 * extManager.js — 拓展管理器
 *
 * 职责：
 *   1. 扫描 `extensions/` 下的子目录，把每个子目录识别为一个拓展（{@link NeonaicExtItem}）
 *   2. 维护「运行期」（load / unload，即 import 入口并调用 onEnable / onDisable）
 *   3. 维护「持久化开关」（enable / disable，写回 config/saves/ext.json）
 *   4. 提供 `neonaic:extension`（别名 ext / plugin / extensions / plugins）命令
 *
 * 两套语义刻意正交：
 *   - `load` / `unload`   只动运行期，不碰配置；unload 有内存泄漏风险（见 extLoader 注释）
 *   - `enable` / `disable` 只动配置里的开关，**默认不影响正在运行的拓展**
 *   `enable()` 会检查该开关，因此 `disable` 之后的拓展无法 `load`。
 *   需要「停掉且以后不再自动加载」时，两步一起做即可（`extension disable x && extension unload x`）。
 *
 * 返回值形状由 {@link NeonaicExtOperateStatusPayload} / {@link NeonaicExtOperateStatus} 定义：
 *   - operation：`load` / `unload` / `enabled` / `disabled`
 *   - status：`successfully` / `notfound` / `failed` / `disabled`（`disabled` 只在 operation=load 时出现）
 *   - 批量结果按 succeed / notfound / disabled / failed 四类分桶
 *   运行状态（是否已加载）**不在**返回结构里，需要时用 {@link listExt} 查询。
 *
 * @since 0.1.0
 */

import { opendir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NeonaicConfig } from '../utils/NeonaicConfig.js';
import { NeonaicExtItem } from './extLoader.js';
import { getLogger } from '../logger/Logger.js';
import { neonaicConfManager } from '../system/confManager.js';
import { NeonaicExtensionError, NeonaicIllegalArgumentError } from '../utils/NeonaicNewableError.js';
import { parseString } from '../utils/text.js';
import { NeonaicCommandContext, neonaicCommandServer } from '../command/commandServer.js';
import { neonaicCommandInterface } from '../command/commandInterface.js';

// ---- 颜色 ----
const CYAN   = '\x1b[36m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const DIM    = '\x1b[2m';
const R      = '\x1b[0m';

/** 拓展默认根目录：<项目根>/extensions */
const EXT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'extensions');
/** 拓展启用状态的持久化载体（默认 AUTOSAVE，赋值即写盘） */
const EXT_SAVE = new NeonaicConfig('./config/saves/ext.json');
/** 已识别拓展：id → NeonaicExtItem @type {Map<String, NeonaicExtItem>} */
const EXT_MAP = new Map();

/**
 * @typedef {Object} NeonaicExtOperateStatusPayload 单个拓展加载与卸载状态
 * @property {'load'|'unload'|'enabled'|'disabled'} operation 操作类型
 * @property {'notfound'|'successfully'|'failed'|'disabled'} status 状态，其中"disabled"只能在{@link NeonaicExtOperateStatusPayload.operation}="load"时出现
 * @property {NeonaicExtensionError|null} error 错误信息（若有）
 * @property {String} id 拓展标识符
 */

/**
 * @typedef {Object} NeonaicExtOperateStatus 批量加载与卸载拓展状态
 * @property {'load'|'unload'|'enabled'|'disabled'} operation 操作类型
 * @property {NeonaicExtOperateStatusPayload[]} succeed 加载与卸载成功的拓展
 * @property {NeonaicExtOperateStatusPayload[]} notfound 未找到的拓展
 * @property {NeonaicExtOperateStatusPayload[]} disabled 找到但被禁用的拓展
 * @property {NeonaicExtOperateStatusPayload[]} failed 加载与卸载失败的拓展
 */

// ---- 内部工具 ----

/** 取机器人的名字，用于组装面向用户的文案 */
const botName = () => neonaicConfManager.getBotName();

/**
 * 规范化拓展标识符。
 * @param {*} id
 * @returns {String|null} 非字符串或空白时返回 null
 */
function normalizeId(id) {
  if (typeof id === 'string') return id.trim() || null;
  if (id === null || id === undefined) return null;
  const text = parseString(id).trim();
  return text || null;
}

/** 拓展是否处于「已加载」状态 @apiNote extLoader 未暴露 running，用 export 是否为 null 判断 */
const isRunning = (ext) => ext.export !== null;

/** 全部已识别拓展的标识符 */
const allIds = () => [...EXT_MAP.keys()];

/** 把任意错误包成 NeonaicExtensionError */
const toExtensionError = (error) =>
  error instanceof NeonaicExtensionError ? error : new NeonaicExtensionError(parseString(error), error);

/**
 * 组装单个操作结果，字段严格按 {@link NeonaicExtOperateStatusPayload}。
 * @param {'load'|'unload'|'enabled'|'disabled'} operation 操作类型
 * @param {'notfound'|'successfully'|'failed'|'disabled'} status 状态
 * @param {String} id 拓展标识符
 * @param {NeonaicExtensionError|null} [error=null] 错误信息（若有）
 * @returns {NeonaicExtOperateStatusPayload}
 */
function resultOf(operation, status, id, error = null) {
  return { operation, status, error, id };
}

// ---- 扫描与识别 ----

/**
 * 扫描并识别指定目录下的拓展。
 *
 * 行为：对目录下的每个一级子目录构造 {@link NeonaicExtItem}，单个拓展识别失败只记警告、
 * 不影响其它拓展。本方法**幂等**：已识别的 id 会复用原实例（保留其运行期状态），
 * 目录中已消失的拓展会从映射表移除。
 *
 * @param {String} [root=EXT_ROOT] 扫描根目录
 * @returns {Promise<Map<String, NeonaicExtItem>>} 识别结果（即内部映射表本身）
 */
async function readAllExt(root = EXT_ROOT) {
  if (typeof root !== 'string' || !root) {
    throw new NeonaicIllegalArgumentError(`拓展扫描根目录无效：${parseString(root)}`);
  }

  /** 本轮扫描到的拓展 @type {Map<String, NeonaicExtItem>} */
  const found = new Map();
  let checked = 0;
  let skipped = 0;

  try {
    const dir = await opendir(root);
    for await (const entry of dir) {
      if (!entry.isDirectory()) {
        skipped++;
        getLogger().ext.debug(`指定内容不是文件夹，已跳过：`, entry.name);
        continue;
      }
      checked++;
      try {
        // 注意：entry 是 Dirent，取路径必须用 entry.name
        const item = new NeonaicExtItem(resolve(root, entry.name), EXT_SAVE);
        const existed = found.get(item.id);
        if (existed) {
          throw new NeonaicExtensionError(`拓展“${item.fullname}”与“${existed.fullname}”声明了相同的标识符。当前正在使用：${existed.entry_path}`);
        }
        found.set(item.id, item);
      } catch (error) {
        getLogger().ext.warn(`“${botName()}”无法识别拓展“${entry.name}”，因为：`, error);
      }
    }
  } catch (error) {
    getLogger().ext.error(`“${botName()}”无法扫描拓展目录“${root}”，因为：`, error);
    return EXT_MAP;
  }

  // 重建映射表：已识别过的 id 复用原实例，避免丢掉运行期状态
  const previous = new Map(EXT_MAP);
  EXT_MAP.clear();
  for (const [id, item] of found) {
    EXT_MAP.set(id, previous.get(id) ?? item);
  }
  getLogger().ext.info(`拓展扫描完成：识别 ${EXT_MAP.size} 个（检查 ${checked} 个目录，跳过 ${skipped} 个非目录项）`);
  return EXT_MAP;
}

// ---- 查询 ----

/**
 * 按标识符取拓展。
 * @param {String} id
 * @returns {NeonaicExtItem|null}
 */
function findExt(id) {
  const key = normalizeId(id);
  return key === null ? null : (EXT_MAP.get(key) ?? null);
}

/**
 * 列出已识别拓展的摘要信息。
 * @returns {Array<{id: String, name: String, fullname: String, version: String, enabled: boolean, running: boolean, entry: String}>}
 */
function listExt() {
  return [...EXT_MAP.values()].map((ext) => ({
    id: ext.id,
    name: ext.name,
    fullname: ext.fullname,
    version: ext.manifest.getList('meta.version', []).slice(1).join('.'),
    enabled: ext.enabled,
    running: isRunning(ext),
    entry: ext.entry_path,
  }));
}

// ---- 运行期：加载与卸载 ----

/**
 * 加载（运行）一个拓展。
 *
 * @apiNote 目标拓展被禁用时不会抛错，而是返回 `status: 'disabled'`
 *          （见 {@link NeonaicExtOperateStatusPayload} 对 status 的说明）。
 * @param {String} id 拓展标识符
 * @returns {Promise<NeonaicExtOperateStatusPayload>}
 */
async function loadExt(id) {
  const key = normalizeId(id);
  if (key === null || !EXT_MAP.has(key)) return resultOf('load', 'notfound', key ?? parseString(id));
  const ext = EXT_MAP.get(key);
  if (!ext.enabled) return resultOf('load', 'disabled', ext.id);
  try {
    await ext.enable();
    return resultOf('load', 'successfully', ext.id);
  } catch (error) {
    return resultOf('load', 'failed', ext.id, toExtensionError(error));
  }
}

/**
 * 卸载（停止）一个拓展。
 * @param {String} id 拓展标识符
 * @returns {Promise<NeonaicExtOperateStatusPayload>}
 * @deprecated 潜在内存泄漏风险，不推荐使用。
 */
async function unloadExt(id) {
  const key = normalizeId(id);
  if (key === null || !EXT_MAP.has(key)) return resultOf('unload', 'notfound', key ?? parseString(id));
  const ext = EXT_MAP.get(key);
  try {
    await ext.disable();
    return resultOf('unload', 'successfully', ext.id);
  } catch (error) {
    return resultOf('unload', 'failed', ext.id, toExtensionError(error));
  }
}

// ---- 持久化开关：启用与禁用 ----

/**
 * 启用一个拓展：把持久化开关置真（默认 AUTOSAVE，立即写回 config/saves/ext.json）。
 *
 * @apiNote 默认**不会**加载该拓展（与 {@link NeonaicExtItem} 里 enabled 的语义一致：
 *          「不会影响插件的现行状态」）。需要立即跑起来就传 `{ load: true }`，
 *          或再调一次 {@link loadExt}。
 * @param {String} id 拓展标识符
 * @param {Object} [options]
 * @param {boolean} [options.load=false] 置真后是否顺带加载
 * @returns {Promise<NeonaicExtOperateStatusPayload>}
 */
async function enableExt(id, options = {}) {
  const key = normalizeId(id);
  if (key === null || !EXT_MAP.has(key)) return resultOf('enabled', 'notfound', key ?? parseString(id));
  const ext = EXT_MAP.get(key);
  try {
    ext.enabled = true;
    if (options.load === true) {
      const loaded = await loadExt(ext.id);
      if (loaded.status !== 'successfully') {
        return { ...loaded, operation: 'enabled' };
      }
    }
    return resultOf('enabled', 'successfully', ext.id);
  } catch (error) {
    return resultOf('enabled', 'failed', ext.id, toExtensionError(error));
  }
}

/**
 * 禁用一个拓展：把持久化开关置假（立即写回 config/saves/ext.json）。
 *
 * @apiNote 默认**不会**卸载正在运行的拓展（unload 已被标注内存泄漏风险，不应作为默认行为），
 *          禁用只改配置开关，运行状态请用 {@link listExt} 或 {@link isRunning} 另行查询；
 *          需要一并停掉就传 `{ unload: true }`，或再调一次 {@link unloadExt}。
 *          禁用后该拓展无法再被 {@link loadExt} 加载（会返回 `status: 'disabled'`）。
 * @param {String} id 拓展标识符
 * @param {Object} [options]
 * @param {boolean} [options.unload=false] 是否顺带卸载正在运行的拓展
 * @returns {Promise<NeonaicExtOperateStatusPayload>}
 */
async function disableExt(id, options = {}) {
  const key = normalizeId(id);
  if (key === null || !EXT_MAP.has(key)) return resultOf('disabled', 'notfound', key ?? parseString(id));
  const ext = EXT_MAP.get(key);
  try {
    if (options.unload === true && isRunning(ext)) {
      const unloaded = await unloadExt(ext.id);
      if (unloaded.status !== 'successfully') {
        return { ...unloaded, operation: 'disabled' };
      }
    }
    ext.enabled = false;
    return resultOf('disabled', 'successfully', ext.id);
  } catch (error) {
    return resultOf('disabled', 'failed', ext.id, toExtensionError(error));
  }
}

// ---- 批量操作 ----

/**
 * 对一批拓展依次执行同一操作。
 * @param {String[]} list 拓展标识符列表
 * @param {'load'|'unload'|'enabled'|'disabled'} operation 操作类型
 * @param {(id: String) => Promise<NeonaicExtOperateStatusPayload>} single 单项操作
 * @returns {Promise<NeonaicExtOperateStatus>}
 * @throws {NeonaicIllegalArgumentError} list 不是数组
 */
async function operateListed(list, operation, single) {
  if (!Array.isArray(list)) {
    throw new NeonaicIllegalArgumentError(`批量${operation}的拓展列表应该是一个数组：${parseString(list)}`);
  }
  const [succeed, notfound, disabled, failed] = [[], [], [], []];
  // 串行执行：同一时刻只操作一个拓展，避免并发写同一个配置文件
  for (const raw of list) {
    const result = await single(raw);
    if (result.status === 'failed') failed.push(result);
    else if (result.status === 'notfound') notfound.push(result);
    else if (result.status === 'disabled') disabled.push(result);
    else succeed.push(result);
  }
  return { operation, succeed, notfound, disabled, failed };
}

/**
 * 批量加载拓展。
 * @param {String[]} [list=[...EXT_MAP.keys()]] 拓展列表，默认全部
 * @returns {Promise<NeonaicExtOperateStatus>}
 */
async function loadListedExt(list = allIds()) {
  return operateListed(list, 'load', loadExt);
}

/**
 * 批量卸载拓展。
 * @param {String[]} [list=[...EXT_MAP.keys()]] 拓展列表，默认全部
 * @returns {Promise<NeonaicExtOperateStatus>}
 * @deprecated 潜在内存泄漏风险，不推荐使用。
 */
async function unloadListedExt(list = allIds()) {
  return operateListed(list, 'unload', unloadExt);
}

/**
 * 批量启用拓展。
 * @param {String[]} [list=[...EXT_MAP.keys()]] 拓展列表，默认全部
 * @param {Object} [options] 透传给 {@link enableExt}
 * @returns {Promise<NeonaicExtOperateStatus>}
 */
async function enableListedExt(list = allIds(), options = {}) {
  return operateListed(list, 'enabled', (id) => enableExt(id, options));
}

/**
 * 批量禁用拓展。
 * @param {String[]} [list=[...EXT_MAP.keys()]] 拓展列表，默认全部
 * @param {Object} [options] 透传给 {@link disableExt}
 * @returns {Promise<NeonaicExtOperateStatus>}
 */
async function disableListedExt(list = allIds(), options = {}) {
  return operateListed(list, 'disabled', (id) => disableExt(id, options));
}

// ---- 文案渲染 ----

/**
 * 把批量操作结果渲染为可读文本。
 * @param {NeonaicExtOperateStatus} status
 * @returns {String}
 */
function renderStatus(status) {
  const verb = { load: '加载', unload: '卸载', enabled: '启用', disabled: '禁用' }[status.operation] ?? status.operation;
  const lines = [`${DIM}${verb}完成：成功 ${status.succeed.length} 个，失败 ${status.failed.length} 个，未识别 ${status.notfound.length} 个，被禁用 ${status.disabled.length} 个${R}`];

  for (const item of status.succeed) {
    // 运行状态不属于 payload，按 id 回查（见 NeonaicExtOperateStatusPayload 的字段约定）
    const ext = EXT_MAP.get(item.id);
    const running = ext && isRunning(ext) ? `${GREEN}运行中${R}` : `${DIM}未运行${R}`;
    const enabled = ext && ext.enabled ? `${DIM}已启用${R}` : `${YELLOW}已禁用${R}`;
    lines.push(`  ${GREEN}✓${R} ${CYAN}${item.id}${R}  ${running} / ${enabled}`);
  }
  for (const item of status.notfound) {
    lines.push(`  ${YELLOW}?${R} ${item.id} ${DIM}未识别的拓展${R}`);
  }
  for (const item of status.disabled) {
    lines.push(`  ${YELLOW}⊘${R} ${CYAN}${item.id}${R} ${DIM}已被禁用，需先 ${CYAN}extension enable ${item.id}${R}`);
  }
  for (const item of status.failed) {
    lines.push(`  ${RED}✗${R} ${CYAN}${item.id}${R} ${RED}${item.error?.message ?? '未知原因'}${R}`);
  }

  // 禁用后仍在运行的情况需要明确提示，否则用户会以为已经停掉了
  if (status.operation === 'disabled') {
    const stillRunning = status.succeed
      .map((item) => item.id)
      .filter((id) => { const ext = EXT_MAP.get(id); return ext ? isRunning(ext) : false; });
    if (stillRunning.length) {
      lines.push(`${YELLOW}提示：${stillRunning.join('、')} 仍在运行中，禁用只改配置开关；如需立即停止请执行 ${CYAN}extension unload ${stillRunning.join(' ')}${R}`);
    }
  }
  return lines.join('\n');
}

/**
 * 渲染拓展列表。
 * @returns {String}
 */
function renderList() {
  if (EXT_MAP.size === 0) return `${DIM}暂无已识别的拓展${R}`;
  const lines = [...EXT_MAP.values()].map((ext) => {
    const version = ext.manifest.getList('meta.version', []).slice(1).join('.');
    const running = isRunning(ext) ? `${GREEN}运行中${R}` : `${DIM}未运行${R}`;
    const enabled = ext.enabled ? `${DIM}已启用${R}` : `${YELLOW}已禁用${R}`;
    return `  ${CYAN}${ext.id}${R} ${DIM}v${version}${R}  ${running} / ${enabled}  ${DIM}${ext.fullname}${R}`;
  });
  return `${DIM}共 ${EXT_MAP.size} 个拓展${R}\n${lines.join('\n')}`;
}

/**
 * 渲染单个拓展的详细信息。
 * @param {NeonaicExtItem} ext
 * @returns {String}
 */
function renderInfo(ext) {
  const m = ext.manifest;
  const version = m.getList('meta.version', []).slice(1).join('.');
  return [
    `${CYAN}${ext.fullname}${R}`,
    `  ${DIM}标识符${R}   ${ext.id}`,
    `  ${DIM}版本${R}     ${version || '未声明'}`,
    `  ${DIM}作者${R}     ${m.getList('particulars.author', []).join('、') || '未声明'}`,
    `  ${DIM}描述${R}     ${m.getString('particulars.description', '未声明')}`,
    `  ${DIM}许可${R}     ${m.getString('particulars.license', '未声明')}`,
    `  ${DIM}主页${R}     ${m.getString('particulars.url', '未声明')}`,
    `  ${DIM}入口${R}     ${ext.entry_path}`,
    `  ${DIM}依赖${R}     ${parseString(m.getRawData().depends ?? {})}`,
    `  ${DIM}状态${R}     ${isRunning(ext) ? `${GREEN}运行中${R}` : `${DIM}未运行${R}`} / ${ext.enabled ? `${DIM}已启用${R}` : `${YELLOW}已禁用${R}`}`,
  ].join('\n');
}

// ---- 命令 ----

/** 命令用法文本（保持单行纯文本，供命令系统与帮助列表复用） */
const EXT_USAGE = "extension <list|scan|info|load|unload|enable|disable> [...exts]";

/** 更详细的用法提示（仅用于面向用户的回复，可带颜色） */
const EXT_USAGE_HINT =
  `${DIM}用法:${R} ${EXT_USAGE}\n` +
  `${DIM}  · list / 无参数：列出已识别拓展${R}\n` +
  `${DIM}  · scan [dir]：重新扫描（缺省 ${EXT_ROOT}）${R}\n` +
  `${DIM}  · info <ext>：查看单个拓展详情${R}\n` +
  `${DIM}  · load / unload [...exts]：加载 / 卸载（只影响运行期）${R}\n` +
  `${DIM}  · enable / disable [...exts]：写回启用开关（不改运行状态，省略即全部）${R}`;
/**
 * `neonaic:extension` 命令处理器。
 * @this {NeonaicCommandContext}
 * @param {String} action 子命令
 * @param {...String} exts 目标拓展标识符（load/unload/enable/disable 支持多个，省略即全部；
 *                          scan 只取第一个参数作为扫描目录）
 * @returns {Promise<String>|String}
 */
async function extensionCommand(action, ...exts) {
  /** @type {NeonaicCommandContext} */
  const ctx = this;
  getLogger().ext.debug(`[ext] ${ctx?.executor?.[0] ?? neonaicCommandInterface.COMMAND_ENUMS.FROM_CONSOLE} 请求执行：extension ${parseString(action ?? '<无子命令>')} ${parseString(exts)}`);

  // 首次使用时自动扫描，避免用户必须先跑一次 scan
  if (EXT_MAP.size === 0) await readAllExt();

  switch (normalizeId(action)) {
    case 'list':
      return renderList();

    case 'scan':
      // 可选指定扫描目录，缺省为 <项目根>/extensions
      await readAllExt(normalizeId(exts[0]) ?? EXT_ROOT);
      return renderList();

    case 'info': {
      const target = findExt(exts[0]);
      if (!target) return `${RED}未识别的拓展：${parseString(exts[0])}${R}\n${EXT_USAGE_HINT}`;
      return renderInfo(target);
    }

    case 'load':
      return renderStatus(await loadListedExt(exts.length ? exts : allIds()));

    case 'unload':
      return renderStatus(await unloadListedExt(exts.length ? exts : allIds()));

    case 'enable':
      return renderStatus(await enableListedExt(exts.length ? exts : allIds()));

    case 'disable':
      return renderStatus(await disableListedExt(exts.length ? exts : allIds()));

    default:
      return normalizeId(action) === null
        ? renderList()
        : `${RED}未知子命令：${parseString(action)}${R}\n${EXT_USAGE_HINT}`;
  }
}

// ---- 导出 API 与命令 ----

export const neonaicExtensionManager = {
  /** 扫描根目录 */
  get root() { return EXT_ROOT; },
  /** 已识别拓展数量 */
  get size() { return EXT_MAP.size; },
  /** 已识别拓展的标识符列表 */
  get ids() { return allIds(); },

  scan: readAllExt,
  list: listExt,
  find: findExt,

  /** 运行期：加载 / 卸载 */
  load: loadExt,
  unload: unloadExt,
  loadAll: loadListedExt,
  unloadAll: unloadListedExt,

  /** 持久化开关：启用 / 禁用 */
  enable: enableExt,
  disable: disableExt,
  enableAll: enableListedExt,
  disableAll: disableListedExt,
};

neonaicCommandServer.registerCommand('neonaic', 'extension', extensionCommand, {
  alias: ['ext', 'plugin', 'extensions', 'plugins'],
  permissions: [[neonaicCommandInterface.COMMAND_ENUMS.PERM_SUPERADMIN, 'neonaic.command.extension']],
  description: "管理 Neonaic 加载的插件",
  usage: EXT_USAGE,
});
