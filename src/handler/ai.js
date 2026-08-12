/**
 * handler/ai.js — AI 交互模块（Vercel AI SDK）
 *
 * 保留 askAI(userMessage, AIlist) 接口，内部全面使用 Vercel AI SDK：
 *   - createOpenAI 构建 provider，可选 chat / responses 端点（responseAPI）
 *   - generateText / streamText 生成回复（stream 可选流式）
 *   - registerAITool 注册 AI 工具，由 profile 的 tools 配置决定是否暴露给模型
 *
 * 系统提示词按 provider 名加载：config/prompts/${oai[x].name}.md
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateText, streamText, tool } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

import { CONFIG_PATHS, getConfig } from '../system/conf.js';
import { getLogger, parseString } from '../system/logger/logger.js';

// 本模块自算项目根路径，避免与 entry.js 形成循环依赖
// ai.js 位于 <根>/src/handler/，故向上 2 层为项目根
const ROOT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// ---- 提示词加载 ----

/** 文件提示词缓存 @type {Map<string, string>} */
const _promptCache = new Map();

function loadSystemPrompt(providerName) {
  if (_promptCache.has(providerName)) return _promptCache.get(providerName);
  let prompt;
  try {
    prompt = readFileSync(resolve(ROOT_PATH, `config/prompts/${providerName}.md`), 'utf8').trim();
  } catch (e) {
    prompt = '你是一个有用的 AI 助手。';
    getLogger().tool.debug(`无法加载提示词 config/prompts/${providerName}.md：`, e);
  }
  _promptCache.set(providerName, prompt);
  return prompt;
}

// ---- AI 工具注册 ----

/**
 * 已注册的 AI 工具。
 * @typedef {object} AIToolDef
 * @property {string} namespace 命名空间（'' 表示全局）
 * @property {string} name 工具名
 * @property {string} description 工具描述
 * @property {*} inputSchema 输入 schema（zod schema 或 JSON schema）
 * @property {Function} execute 执行函数
 * @property {string[]} aliases 别名列表
 */

/** 全部工具（按注册顺序，去重） @type {AIToolDef[]} */
const _allTools = [];
/** fqn（namespace:name / namespace:alias）→ 工具定义 @type {Map<string, AIToolDef>} */
const _toolFqn = new Map();

/**
 * 注册一个 AI 工具。
 *
 * 冲突规则（参考命令注册）：同名（含命名空间限定）已存在则不注册。
 *
 * @param {string} namespace 命名空间（'' 表示全局）
 * @param {string} name 工具名
 * @param {object} definition 工具定义
 * @param {string} [definition.description] 工具描述（会发送给模型）
 * @param {*} definition.inputSchema 输入 schema（zod schema）
 * @param {Function} definition.execute 执行函数，接收模型生成的输入
 * @param {object} [opts] 附加信息
 * @param {string|string[]} [opts.alias] 别名
 * @returns {boolean} true 注册成功；false 冲突（已存在同名工具）
 */
export function registerAITool(namespace, name, definition, opts = {}) {
  if (!namespace || !name) {
    getLogger().tool.warn(`AI 工具注册失败：无效的命名空间或名称 (ns=${namespace}, name=${name})`);
    return false;
  }
  if (!definition || typeof definition.execute !== 'function') {
    getLogger().tool.warn(`AI 工具注册失败：无效的定义或 execute (${namespace}:${name})`);
    return false;
  }

  const fqn = `${namespace}:${name}`;
  if (_toolFqn.has(fqn)) {
    getLogger().tool.warn(`AI 工具 "${fqn}" 已被注册`);
    return false;
  }

  const aliases = opts.alias ? (Array.isArray(opts.alias) ? opts.alias : [opts.alias]) : [];
  const def = {
    namespace, name,
    description: definition.description ?? '',
    inputSchema: definition.inputSchema,
    execute: definition.execute,
    aliases: [...aliases],
  };

  _toolFqn.set(fqn, def);
  _allTools.push(def);
  for (const a of aliases) {
    if (!a || a === name) continue;
    const afqn = `${namespace}:${a}`;
    if (!_toolFqn.has(afqn)) _toolFqn.set(afqn, def);
  }
  return true;
}

/** 获取所有已注册的 AI 工具（按注册顺序） */
export function getAITools() { return _allTools; }

// ---- 工具过滤 ----

/**
 * 匹配工具模式。带命名空间（含 ':'）精确匹配 fqn；不带则模糊匹配 name。
 * @param {string} pattern
 * @returns {string[]} 匹配到的 fqn 列表
 */
function matchToolPattern(pattern) {
  const hasNs = pattern.includes(':');
  const hits = [];
  for (const t of _allTools) {
    if (hasNs) {
      if (`${t.namespace}:${t.name}` === pattern) hits.push(`${t.namespace}:${t.name}`);
    } else {
      if (t.name === pattern) hits.push(`${t.namespace}:${t.name}`);
    }
  }
  return hits;
}

/**
 * 解析 profile.tools 配置，返回该 Profile 可用工具的 fqn 列表。
 *
 * 规则：
 *   - 空 / 未设置 → 不得调用任何工具
 *   - "*" → 全部可用
 *   - "!tool" → 屏蔽（含模糊匹配）
 *   - 其余 → 白名单（含模糊匹配）
 *
 * @param {string|string[]|undefined} toolsConfig
 * @returns {string[]} 可用工具的 fqn 列表
 */
export function resolveToolList(toolsConfig) {
  if (toolsConfig == null) return [];
  const rules = Array.isArray(toolsConfig) ? toolsConfig : [toolsConfig];
  if (!rules.length) return [];

  const allFqns = _allTools.map((t) => `${t.namespace}:${t.name}`);
  let allowAll = false;
  const allowed = new Set();
  const blocked = new Set();

  for (const raw of rules) {
    if (typeof raw !== 'string' || !raw) continue;
    const isNegate = raw.startsWith('!');
    const pattern = isNegate ? raw.slice(1) : raw;

    if (pattern === '*') {
      if (isNegate) blocked.add('*');
      else allowAll = true;
      continue;
    }

    const hits = matchToolPattern(pattern);
    if (isNegate) {
      for (const h of hits) blocked.add(h);
    } else {
      for (const h of hits) allowed.add(h);
    }
  }

  if (blocked.has('*')) return []; // "!*" 屏蔽全部

  const source = allowAll ? allFqns : [...allowed];
  return source.filter((f) => !blocked.has(f));
}

// ---- 调用 ----

/**
 * 将工具定义转换为 Vercel AI 的 tools 对象。
 * @param {string[]} toolList 可用工具的 fqn 列表
 */
function buildToolSet(toolList) {
  const tools = {};
  for (const fqn of toolList) {
    const def = _toolFqn.get(fqn);
    if (!def) continue;
    // OpenAI 工具名仅允许 [a-zA-Z0-9_-]，将 fqn 的 ':' 替换为 '_' 作为模型可见名
    const modelName = fqn.replace(/:/g, '_');
    tools[modelName] = tool({
      description: def.description || undefined,
      inputSchema: def.inputSchema,
      execute: def.execute,
    });
  }
  return tools;
}

/**
 * 调用单个 AI Profile 获取回复。
 * @param {object} provider oai 配置项
 * @param {string} userMessage
 * @returns {Promise<string>}
 */
async function callProvider(provider, userMessage) {
  const systemPrompt = loadSystemPrompt(provider.name);

  const client = createOpenAI({
    baseURL: provider.address,
    apiKey: provider.token,
    name: provider.name,
  });

  // 选择端点：responseAPI → responses，否则 chat completions
  const model = provider.responseAPI
    ? client.responses(provider.model)
    : client.chat(provider.model);

  // 按 tools 配置过滤可用工具
  const toolList = resolveToolList(provider.tools);
  const tools = buildToolSet(toolList);

  const messages = [
    { role: 'user', content: userMessage },
  ];

  const endpoint = provider.responseAPI ? 'responses' : 'chat';
  getLogger().tool.debug(
    `→ ${provider.name}: ${provider.address}#${provider.model} (${endpoint}${provider.stream ? ', stream' : ''}, ${toolList.length} tools)`,
  );

  const common = {
    model,
    system: systemPrompt,
    messages,
    ...(Object.keys(tools).length ? { tools } : {}),
    temperature: 0.25,
    topP: 0.9,
  };

  const result = provider.stream
    ? await streamText(common)
    : await generateText(common);

  const reply = result.text ?? '';
  getLogger().tool.debug(`← ${provider.name}: ${reply.length} 字符`);
  return reply;
}

// ---- 外部 API ----

/**
 * @param {string} userMessage
 * @param {string|string[]} AIlist 允许的 AI Profile 列表，"*" 表示全部
 * @returns {Promise<string>} AI 回复文本
 */
export async function askAI(userMessage, AIlist) {
  if (!Array.isArray(AIlist)) AIlist = [AIlist];
  AIlist = AIlist.map((v) => (typeof v === 'string' ? v.trim() : parseString(v, false).trim()));

  const isAll = AIlist.includes('*');
  const oaiList = getConfig(CONFIG_PATHS.secret).getList('oai').filter((v) => {
    if (v?.available === false) return false;
    if (isAll) return true;
    return AIlist.includes(v?.name);
  });
  if (!oaiList.length) throw new Error('未找到可用的 AI Profile');

  const errors = new Map();
  for (const provider of oaiList) {
    try {
      return await callProvider(provider, userMessage);
    } catch (err) {
      getLogger().tool.debug(`× ${provider.name}: ${err.message}`);
      errors.set(provider.name, err.message);
    }
  }

  let detail = '所有 AI Profile 请求失败: ';
  errors.forEach((v, k) => { detail += `${k}: "${String(v).replace(/\n/g, '\\n')}"; `; });
  throw new Error(detail);
}
