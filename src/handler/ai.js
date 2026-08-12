/**
 * handler/ai.js — AI 交互模块（Vercel AI SDK）
 *
 * 保留 askAI(userMessage, AIlist) 接口，内部全面使用 Vercel AI SDK：
 *   - createOpenAI 构建 provider，通过 fetch 中间件严格遵循用户配置的完整 address
 *     （不做 baseURL 自动拼接端点）
 *   - responseAPI 仅决定请求体格式（responses API vs chat completions）
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
import JSON5 from 'json5';

import { CONFIG_PATHS, getConfig } from '../system/conf.js';
import { getLogger, parseString } from '../system/logger/logger.js';
import { COMMAND_ENUMS, registerCommand } from './commandServer.js';
import { clearPermission, checkPermission, parseDuration, setPermission, setTempPermission } from './permissionServer.js';

// 本模块自算项目根路径，避免与 entry.js 形成循环依赖
// ai.js 位于 <根>/src/handler/，故向上 2 层为项目根
const ROOT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** 封禁用户使用 AI 的权限名 */
const AI_BAN_PERMISSION = 'neonaic.toolcall.ai';

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
 * @returns {boolean} true 注册成功；false 冲突（已存在同名工具）
 */
export function registerAITool(namespace, name, definition) {
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

  const def = {
    namespace, name,
    description: definition.description ?? '',
    inputSchema: definition.inputSchema,
    execute: definition.execute,
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

  // 严格遵循用户配置的完整 address，不依赖 SDK 的 baseURL 自动拼接端点。
  // 通过 fetch 中间件，将 SDK 拼接出的 URL 统一替换为用户配置的完整地址。
  const client = createOpenAI({
    apiKey: provider.token,
    name: provider.name,
    fetch: (url, init) => globalThis.fetch(provider.address, init),
  });

  // responseAPI 仅决定请求体格式（responses API vs chat completions），端点由 address 指定
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
 * 检查调用者是否被禁止使用 AI。
 * @param {string|string[]|null|undefined} caller 调用者标识（执行者链）
 * @returns {boolean} true = 已被封禁
 */
export function isAIBanned(caller) {
  if (caller == null) return false;
  // 权限被明确设置为 false 视为封禁；未设置（null）默认允许
  return checkPermission(caller, AI_BAN_PERMISSION) === false;
}

/**
 * @param {string} userMessage
 * @param {string|string[]} AIlist 允许的 AI Profile 列表，"*" 表示全部
 * @param {string|string[]|null|undefined} [caller] 调用者标识（执行者链），用于封禁检查
 * @returns {Promise<string>} AI 回复文本
 * @throws 调用者被封禁 / 无可用 Profile / 所有 Profile 请求失败
 */
export async function askAI(userMessage, AIlist, caller) {
  if (isAIBanned(caller)) {
    throw new Error('你已被禁止使用 AI 功能');
  }

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

// ---- 命令辅助 ----

/**
 * 查找工具定义。
 * @param {string} ref 工具引用：fqn（ns:name）或 name（模糊匹配）
 * @returns {AIToolDef|null}
 */
function findTool(ref) {
  if (!ref) return null;
  if (_toolFqn.has(ref)) return _toolFqn.get(ref);
  return _allTools.find((t) => t.name === ref) ?? null;
}

/**
 * 查找 AI Profile。
 * @param {string} name Profile 名
 * @returns {object|null}
 */
function findProvider(name) {
  return getConfig(CONFIG_PATHS.secret).getList('oai').find((p) => p?.name === name) ?? null;
}

// ---- ai 命令 ----

registerCommand('neonaic', 'ai', async function (sub, ...args) {
  /** @type {import('./commandServer.js').CommandContext} */
  const ctx = this;

  switch (sub) {
    case 'tool':
      return aiTool(ctx, ...args);
    case 'profile':
      return aiProfile(ctx, ...args);
    case 'ban':
      return aiBan(ctx, ...args);
    case 'pardon':
      return aiPardon(ctx, ...args);
    default:
      return `用法: ${cmdAIUsage()}`;
  }
}, {
  permissions: [[COMMAND_ENUMS.PERM_SUPERADMIN, "neonaic.command.ai"]],
  description: "AI 工具与 Profile 管理",
  usage: "ai <tool|profile|ban|pardon> ...",
  alias: ['askai'],
});

/** ai 命令用法文本 */
function cmdAIUsage() {
  return "ai tool list | ai tool test <tool> <json5> | ai profile list | ai profile <enable|disable> <profile> | ai profile test <profile> <msg> | ai ban <user> [time] | ai pardon <user>";
}

/**
 * ai tool 子命令。
 * @param {import('./commandServer.js').CommandContext} ctx
 * @param {...string} args
 */
async function aiTool(ctx, ...args) {
  const op = args[0];
  switch (op) {
    case 'list': {
      const tools = getAITools();
      if (!tools.length) return '暂无已注册的 AI 工具';
      return tools.map((t) => {
        const alias = t.aliases.length ? ` [别名: ${t.aliases.join(', ')}]` : '';
        return `${t.namespace}:${t.name}${alias}${t.description ? ` - ${t.description}` : ''}`;
      }).join('\n');
    }
    case 'test': {
      const toolRef = args[1];
      if (!toolRef) return '用法: ai tool test <tool> <json5>';
      const def = findTool(toolRef);
      if (!def) return `未找到 AI 工具: ${toolRef}`;
      const argsJson = args.slice(2).join(' ');
      let input;
      try {
        input = JSON5.parse(argsJson || '{}');
      } catch (err) {
        return `参数 JSON5 解析失败: ${err.message}`;
      }
      try {
        const result = await def.execute(input);
        return parseString(result);
      } catch (err) {
        return `工具执行失败: ${err.message}`;
      }
    }
    default:
      return '用法: ai tool list | ai tool test <tool> <json5>';
  }
}

/**
 * ai profile 子命令。
 * @param {import('./commandServer.js').CommandContext} ctx
 * @param {...string} args
 */
async function aiProfile(ctx, ...args) {
  const op = args[0];
  switch (op) {
    case 'list': {
      const list = getConfig(CONFIG_PATHS.secret).getList('oai');
      if (!list.length) return '暂无 AI Profile';
      return list.map((p) => `${p.name} (${p.model})${p.available === false ? ' [禁用]' : ''}`).join('\n');
    }
    case 'enable':
    case 'disable': {
      const profileName = args[1];
      if (!profileName) return '用法: ai profile <enable|disable> <profile>';
      const want = op === 'enable';
      const cfg = getConfig(CONFIG_PATHS.secret);
      const list = cfg.getList('oai');
      const target = list.find((p) => p?.name === profileName);
      if (!target) return `未找到 AI Profile: ${profileName}`;
      if ((target.available !== false) === want) return `Profile ${profileName} 已${want ? '启用' : '禁用'}`;
      target.available = want;
      cfg.set('oai', list);
      cfg.save();
      return `已${want ? '启用' : '禁用'} Profile ${profileName}`;
    }
    case 'test': {
      const profileName = args[1];
      const msg = args.slice(2).join(' ');
      if (!profileName || !msg) return '用法: ai profile test <profile> <msg>';
      const target = findProvider(profileName);
      if (!target) return `未找到 AI Profile: ${profileName}`;
      try {
        return await callProvider(target, msg);
      } catch (err) {
        return `测试失败: ${err.message}`;
      }
    }
    default:
      return '用法: ai profile list | ai profile <enable|disable> <profile> | ai profile test <profile> <msg>';
  }
}

/**
 * ai ban 子命令：封禁用户使用 AI。
 * @param {import('./commandServer.js').CommandContext} ctx
 * @param {string} user
 * @param {string} [time] 持续时间（如 '1h'、'2d'、'1y2M3d4h5m6s'），存在则设临时封禁
 */
function aiBan(ctx, user, time) {
  if (!user) return '用法: ai ban <user> [time]';

  if (time !== undefined) {
    // 临时封禁：解析持续时间 → 过期时间 = 当前 + 持续
    const ms = parseDuration(time);
    if (ms == null) return `无法解析持续时间: "${time}"（如 '1h'、'2d'、'1y2M3d4h5m6s'）`;
    const until = Date.now() + ms;
    setTempPermission(user, AI_BAN_PERMISSION, false, until);
    return `已临时封禁 ${user} 使用 AI 功能，持续 ${time}，过期 ${new Date(until).toLocaleString()}`;
  }

  setPermission(user, AI_BAN_PERMISSION, false);
  return `已封禁 ${user} 使用 AI 功能`;
}

/**
 * ai pardon 子命令：解封用户。
 * @param {import('./commandServer.js').CommandContext} ctx
 * @param {string} user
 */
function aiPardon(ctx, user) {
  if (!user) return '用法: ai pardon <user>';
  clearPermission(user, AI_BAN_PERMISSION);
  return `已解封 ${user}`;
}
