/**
 * ai.js — AI 交互模块（Vercel AI SDK）
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
import { dirname, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateText, streamText, tool, stepCountIs } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import JSON5 from 'json5';
import z from 'zod';

import { neonaicConfManager } from '../system/confManager.js';
import { getLogger } from '../logger/Logger.js';
import { parseString } from '../utils/chore.js';
import { neonaicCommandServer } from '../command/commandServer.js';
import { neonaicCommandInterface } from '../command/commandInterface.js';
import { neonaicPermissionServer } from '../command/permissionServer.js';
import { NeonaicIllegalArgumentError, NeonaicIllegalStateError, NeonaicNetworkError } from '../utils/NeonaicNewableError.js';
import { neonaicFileSystem, neonaicNetwork } from '../utils/io.js';
import { NeonaicUriMeta } from '../utils/NeonaicUriMeta.js';
import { neonaicMath } from '../utils/math.js';

/** 封禁用户使用 AI 的权限名 */
const AI_BAN_PERMISSION = 'neonaic.toolcall.ai';

// ---- 提示词加载 ----

/** 文件提示词缓存 @type {Map<string, string>} */
const _promptCache = new Map();

function loadSystemPrompt(promptFilename) {
  if (_promptCache.has(promptFilename)) return _promptCache.get(promptFilename);
  let prompt;
  try {
    const path = neonaicFileSystem.resolveStrict('config/prompts', promptFilename);
    prompt = readFileSync(path, 'utf8').trim();
  } catch (e) {
    getLogger().tool.debug(`无法加载提示词 ${promptFilename}`, e);
    throw new NeonaicIllegalStateError(`无法加载提示词：${e?.message ?? '未知原因'}`, e);
  }
  _promptCache.set(promptFilename, prompt);
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
function registerAITool(namespace, name, definition) {
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
  return true;
}

/** 获取所有已注册的 AI 工具（按注册顺序） */
function getAITools() { return _allTools; }

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
function resolveToolList(toolsConfig) {
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
  const systemPrompt = loadSystemPrompt(provider.prompt);

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
  // AI 工具调用最大轮次（来自本 Profile 的 maxToolcall，默认 5）。
  // Vercel AI SDK 默认 stopWhen = isStepCount(1)，模型首次返回 tool_call 后直接停止，
  // 工具结果无法回读、最终文本为空；设为多步以形成「调用工具 → 取回数据 → 生成作答」闭环。
  // 下限钳制为 1，避免配置为 0/负数导致 stepCountIs 失效。
  const rawMax = Number(provider.maxToolcall);
  const maxToolcall = Math.max(1, Number.isFinite(rawMax) ? rawMax : 5);
  getLogger().tool.debug(
    `→ ${provider.name}: ${provider.address}#${provider.model} (${endpoint}${provider.stream ? ', stream' : ''}, ${toolList.length} tools, maxToolcall=${maxToolcall})`,
  );

  const common = {
    model,
    system: systemPrompt,
    messages,
    ...(Object.keys(tools).length ? { tools } : {}),
    stopWhen: stepCountIs(maxToolcall),
    temperature: 0.25,
    topP: 0.9,
  };

  const result = provider.stream
    ? await streamText(common)
    : await generateText(common);

  // 工具调用可见性：明确记录 AI 是否、调用了哪些工具，便于排查「AI 到底有没有调工具」。
  // toolCalls / toolResults 在 streamText 下为 Promise，在 generateText 下为数组，统一 await 兼容两种模式。
  const toolCalls = await (result.toolCalls ?? []);
  if (toolCalls.length) {
    const summary = toolCalls
      .map((t) => `${t.toolName}(${JSON.stringify(t.input ?? {})})`)
      .join('; ');
    const toolResults = await (result.toolResults ?? []);
    getLogger().tool.debug(`◉ ${provider.name} 调用工具: ${summary.replace(/\n/g, "\\n")}`);
    for (const tr of toolResults) {
      const out = typeof tr.output === 'string' ? tr.output : JSON.stringify(tr.output);
      getLogger().tool.debug(`  ↳ ${tr.toolName} → ${out.replace(/\n/g, "\\n").slice(0, 200)}`);
    }
  }

  const reply = (await result.text) ?? '';
  getLogger().tool.debug(`← ${provider.name}: ${reply.length} 字符`);
  return reply;
}

// ---- 外部 API ----

/**
 * 检查调用者是否被禁止使用 AI。
 * @param {string|string[]|null|undefined} caller 调用者标识（执行者链）
 * @returns {boolean} true = 已被封禁
 */
function isAIBanned(caller) {
  if (caller == null) return false;
  // 权限被明确设置为 false 视为封禁；未设置（null）默认允许
  return neonaicPermissionServer.checkPermission(caller, AI_BAN_PERMISSION) === false;
}

/**
 * @param {string} userMessage
 * @param {string|string[]} AIlist 允许的 AI Profile 列表，"*" 表示全部
 * @param {string|string[]|null|undefined} [caller] 调用者标识（执行者链），用于封禁检查
 * @returns {Promise<string>} AI 回复文本
 * @throws 调用者被封禁 / 无可用 Profile / 所有 Profile 请求失败
 */
async function askAI(userMessage, AIlist, caller) {
  if (isAIBanned(caller)) return `（${neonaicConfManager.getBotName()}静静地看着别处，并未言语）`;

  if (!Array.isArray(AIlist)) AIlist = [AIlist];
  AIlist = AIlist.map((v) => (typeof v === 'string' ? v.trim() : parseString(v, false).trim()));

  const isAll = AIlist.includes('*');
  const oaiList = neonaicConfManager.getConfig(neonaicConfManager.CONFIG_PATHS.secret).getList('oai').filter((v) => {
    if (v?.available === false) return false;
    if (isAll) return true;
    return AIlist.includes(v?.name);
  });
  if (!oaiList.length) throw new NeonaicIllegalArgumentError('未找到可用的 AI Profile');

  const errors = new Map();
  for (const provider of oaiList) {
    try {
      return await callProvider(provider, userMessage);
    } catch (err) {
      const msg = err?.message || (err?.statusCode ?? parseString(err));
      getLogger().tool.debug(`× ${provider.name}: ${msg}`);
      errors.set(provider.name, msg);
    }
  }

  let detail = '所有 AI Profile 请求失败: ';
  errors.forEach((v, k) => { detail += `${k}: "${String(v).replace(/\n/g, '\\n')}"; `; });
  throw new NeonaicNetworkError(detail);
}

// ---- 命令辅助 ----

/**
 * 查找工具定义。
 * @param {string} ref 工具引用：fqn（ns:name）或 name（模糊匹配）
 * @returns {AIToolDef[]}
 */
function findTool(ref) {
  if (!ref) return null;
  const fqn = matchToolPattern(ref);
  return fqn.map((name) => _toolFqn.get(name));
}

/**
 * 查找 AI Profile。
 * @param {string} name Profile 名
 * @returns {object|null}
 */
function findProvider(name) {
  return neonaicConfManager.getConfig(neonaicConfManager.CONFIG_PATHS.secret).getList('oai').find((p) => p?.name === name) ?? null;
}

// ---- ai 基础工具 ----

registerAITool('neonaic', 'webfetch', {
  description: "从指定地址获取Web内容",
  inputSchema: z.object({
    address: z.string().describe("目标 URI，协议头缺失时视作http。"),
    timeout: z.int().describe("可接受的超时时间，不得超过5000ms，默认5000ms。"),
  }),
  execute: async ({ address, timeout }) => {
    try {
      // 请求
      const result = await neonaicNetwork.fetch(
        await NeonaicUriMeta.resolve(address, {}),
        neonaicMath.clamp(neonaicMath.assertNoNaNOrElse(neonaicMath.toNumber(timeout), 5000), 1, 5000),
        { allow_lan: false }
      );

      // 判断内置阻止
      const neonaicTag = result.headers.get("x-neonaic-status");
      if (neonaicTag == 'aborted:intranet') throw new NeonaicNetworkError("试图访问内网", result);
      if (neonaicTag == 'aborted:filter') throw new NeonaicNetworkError("安全原因不得访问该地址", result);

      // 处理结果
      if (result.ok) {
        return `<${result.type.toString()}>${result.text}</>`;
      } else {
        throw new NeonaicNetworkError(`远程返回HTTP代码${result.status}`, result);
      }
    } catch (error) {
      return `未能获取目标地址内容：${error?.message || "未知原因"}`;
    }
  },
});

// ---- ai 命令 ----

neonaicCommandServer.registerCommand('neonaic', 'ai', async function (sub, ...args) {
  /** @type {import('../command/commandServer.js').NeonaicCommandContext} */
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
    case 'moderate':
      return aiModerate(ctx, ...args);
    default:
      return `用法: ${cmdAIUsage()}`;
  }
}, {
  permissions: [[neonaicCommandInterface.COMMAND_ENUMS.PERM_SUPERADMIN, "neonaic.command.ai"]],
  description: "AI 工具与 Profile 管理",
  usage: "ai <tool|profile|ban|pardon|moderate> ...",
  alias: ['askai'],
});

/** ai 命令用法文本 */
function cmdAIUsage() {
  return "ai tool list | ai tool test <tool> <json5> | ai profile list | ai profile <enable|disable> <profile> | ai profile test <profile> <msg> | ai ban <user> [time] | ai pardon <user>";
}

/**
 * ai moderate 子命令。
 * @param {NeonaicCommandContext} ctx
 * @param {string} text
 */
async function aiModerate(ctx, text) {
  if (!text || typeof text !== 'string' || !text.trim()) return "请求为空";
  const result = await isModerate(text);
  if (!result.available) return "内容审核已禁用";
  return `得分=${result.score}, 模型=${result.resolver}, 拒绝=${result.refusal}, 安全=${result.safe}, 不安全=${result.unsafe}, 命中规则=${result.category}`;
}

/**
 * ai tool 子命令。
 * @param {import('../command/commandServer.js').NeonaicCommandContext} ctx
 * @param {...string} args
 */
async function aiTool(ctx, ...args) {
  const op = args[0];
  switch (op) {
    case 'list': {
      const tools = getAITools();
      if (!tools.length) return '暂无已注册的 AI 工具';
      return tools.map((t) => {
        return `${t.namespace}:${t.name}${t.description ? ` - ${t.description}` : ''}`;
      }).join('\n');
    }
    case 'test': {
      const toolRef = args[1];
      if (!toolRef) return '用法: ai tool test <tool> <json5>';
      const def = findTool(toolRef);
      if (def.length <= 0) return `未找到 AI 工具: ${toolRef}`;
      const argsJson = args.slice(2).join(' ');
      let input;
      try {
        input = JSON5.parse(argsJson || '{}');
      } catch (err) {
        return `参数 JSON5 解析失败: ${err.message}`;
      }
      try {
        const result = await def[0].execute(input);
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
 * @param {import('../command/commandServer.js').NeonaicCommandContext} ctx
 * @param {...string} args
 */
async function aiProfile(ctx, ...args) {
  const op = args[0];
  switch (op) {
    case 'list': {
      const list = neonaicConfManager.getConfig(neonaicConfManager.CONFIG_PATHS.secret).getList('oai');
      if (!list.length) return '暂无 AI Profile';
      return list.map((p) => `${p.name} (${p.model})${p.available === false ? ' [禁用]' : ''}`).join('\n');
    }
    case 'enable':
    case 'disable': {
      const profileName = args[1];
      if (!profileName) return '用法: ai profile <enable|disable> <profile>';
      const want = op === 'enable';
      const cfg = neonaicConfManager.getConfig(neonaicConfManager.CONFIG_PATHS.secret);
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
        return `测试失败: ${err?.message || (err?.statusCode ?? parseString(err))}`;
      }
    }
    default:
      return '用法: ai profile list | ai profile <enable|disable> <profile> | ai profile test <profile> <msg>';
  }
}

/**
 * ai ban 子命令：封禁用户使用 AI。
 * @param {import('../command/commandServer.js').NeonaicCommandContext} ctx
 * @param {string} user
 * @param {string} [time] 持续时间（如 '1h'、'2d'、'1y2M3d4h5m6s'），存在则设临时封禁
 */
function aiBan(ctx, user, time) {
  if (!user) return '用法: ai ban <user> [time]';

  if (time !== undefined) {
    // 临时封禁：解析持续时间 → 过期时间 = 当前 + 持续
    const ms = neonaicPermissionServer.parseDuration(time);
    if (ms == null) return `无法解析持续时间: "${time}"（如 '1h'、'2d'、'1y2M3d4h5m6s'）`;
    const until = Date.now() + ms;
    neonaicPermissionServer.setTempPermission(user, AI_BAN_PERMISSION, false, until);
    return `已临时封禁 ${user} 使用 AI 功能，持续 ${time}，过期 ${new Date(until).toLocaleString()}`;
  }

  neonaicPermissionServer.setPermission(user, AI_BAN_PERMISSION, false);
  return `已封禁 ${user} 使用 AI 功能`;
}

/**
 * ai pardon 子命令：解封用户。
 * @param {import('../command/commandServer.js').NeonaicCommandContext} ctx
 * @param {string} user
 */
function aiPardon(ctx, user) {
  if (!user) return '用法: ai pardon <user>';
  neonaicPermissionServer.clearPermission(user, AI_BAN_PERMISSION);
  return `已解封 ${user}`;
}

export const neonaicAI = {
  registerAITool,
  getAITools,
  resolveToolList,
  isAIBanned,
  askAI,
  findTool,
  findProvider,
};