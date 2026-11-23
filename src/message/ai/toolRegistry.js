/**
 * ai/toolRegistry.js — AI 工具的注册表
 *
 * 只负责「谁注册了什么工具」这一件事，不掺任何过滤/调用逻辑：
 * 过滤在 `toolPattern.js`，转成 SDK 工具表在 `callProvider.js`。
 */

import { getLogger } from '#src/logger/Logger.js';
import { parseString } from '#src/utils/chore.js';
import { NeonaicIllegalArgumentError } from '#src/utils/NeonaicNewableError.js';

// ---- AI 工具注册 ----

/**
 * AI 工具执行时拿到的上下文。
 *
 * `neonaic` 由 {@link buildToolSet} 在**每次调用时**注入（同一轮的所有工具共享同一个实例），
 * 因此全局注册的拓展工具也能拿到本轮的命令上下文，不需要在注册时捕获。
 * @typedef {object} NeonaicTAIToolExecutionContext
 * @property {NeonaicCommandContext} neonaic 本轮的命令上下文
 * @property {string} userInput 本轮发送给模型的用户文本（多模态时只含文本部分）
 * @property {string} toolCallId 本次工具调用的 ID
 * @property {Array<object>} messages 触发本次调用的消息列表（不含 system）
 */

/**
 * 已注册的 AI 工具。
 * @typedef {object} NeonaicTAIToolDef
 * @property {string} namespace 命名空间（'' 表示全局）
 * @property {string} name 工具名
 * @property {string} description 工具描述
 * @property {*} inputSchema 输入 schema（zod schema 或 JSON schema）
 * @property {(input: Object, options: NeonaicTAIToolExecutionContext) => unknown|Promise<unknown>} execute 执行函数
 */

/** 全部工具（按注册顺序，去重） @type {NeonaicTAIToolDef[]} */
const _allTools = [];
/** fqn（namespace:name / namespace:alias）→ 工具定义 @type {Map<string, NeonaicTAIToolDef>} */
const _toolFqn = new Map();

/**
 * 定义一个 AI 工具。
 * @param {string} namespace 命名空间（'' 表示全局），仅允许 [a-zA-Z0-9_]，会被自动替换掉其他字符
 * @param {string} name 工具名，仅允许 [a-zA-Z0-9_]，会被自动替换掉其他字符
 * @param {object} definition 工具定义
 * @param {string} [definition.description] 工具描述（会发送给模型）
 * @param {*} definition.inputSchema 输入 schema（zod schema）
 * @param {(input: Object, options: NeonaicTAIToolExecutionContext) => unknown|Promise<unknown>} definition.execute 执行函数，接收模型生成的输入与本轮上下文
 * @returns {[string|null, NeonaicTAIToolDef|null]} [fqn, def] 定义成功的工具全名称与定义；如果定义失败则为 null
 */
function defineAITool(namespace, name, definition) {
  if (!namespace || !name || !definition || typeof definition?.execute !== 'function') {
    return [null, null];
  }
  const def = {
    namespace: parseString(namespace).replace(/[^a-zA-Z0-9_]/g, '_'),
    name: parseString(name).replace(/[^a-zA-Z0-9_]/g, '_'),
    description: definition.description ?? '',
    inputSchema: definition.inputSchema,
    execute: definition.execute,
  };
  return [`${def.namespace}:${def.name}`, def];
}

/**
 * 注册一个 AI 工具。
 *
 * 冲突规则（参考命令注册）：同名（含命名空间限定）已存在则不注册。
 *
 * @param {string} namespace 命名空间（'' 表示全局）
 * @param {string} name 工具名
 * @param {object} definition 工具定义
 * @param {string} [definition.description] 工具描述（会发送给模型）
 * @param {unknown} definition.inputSchema 输入 schema（zod schema）
 * @param {(input: Object, options: NeonaicTAIToolExecutionContext) => unknown|Promise<unknown>} definition.execute 执行函数，接收模型生成的输入
 * @returns {boolean} true 注册成功；false 冲突（已存在同名工具）
 * @throws {NeonaicIllegalArgumentError} 无效的 AI 工具参数
 */
function registerAITool(namespace, name, definition) {
  const [fqn, def] = defineAITool(namespace, name, definition);
  if (!fqn || !def) throw new NeonaicIllegalArgumentError('无效的 AI 工具参数');
  if (_toolFqn.has(fqn)) {
    getLogger().tool.warn(`AI 工具 "${fqn}" 已被注册`);
    return false;
  }
  _toolFqn.set(fqn, def);
  _allTools.push(def);
  return true;
}

/**
 * 注销一个 AI 工具。
 *
 * 供拓展在 `onDisable` 里回收自己注册的工具：只 abort 任务而不注销工具，
 * 会让「已停用」的工具继续可被模型调用（还能重新拉起子进程）。
 *
 * @param {string} namespace 命名空间
 * @param {string} name 工具名
 * @returns {boolean} true 表示确实移除了一个工具；false 表示未找到
 */
function unregisterAITool(namespace, name) {
  const fqn = `${parseString(namespace).replace(/[^a-zA-Z0-9_]/g, '_')}:${parseString(name).replace(/[^a-zA-Z0-9_]/g, '_')}`;
  const def = _toolFqn.get(fqn);
  if (!def) return false;
  // 同一定义可能挂在多个键下（fqn / 历史别名），按值一并清掉
  for (const [key, value] of _toolFqn) {
    if (value === def) _toolFqn.delete(key);
  }
  const index = _allTools.indexOf(def);
  if (index >= 0) _allTools.splice(index, 1);
  return true;
}

/** 获取所有已注册的 AI 工具（按注册顺序） */
function getAITools() { return _allTools; }

/** 按 fqn（namespace:name）取工具定义，未注册返回 null */
function getAIToolByFqn(fqn) { return _toolFqn.get(fqn) ?? null; }

export const neonaicAIToolRegistry = {
  defineAITool,
  registerAITool,
  unregisterAITool,
  getAITools,
  getAIToolByFqn,
};
