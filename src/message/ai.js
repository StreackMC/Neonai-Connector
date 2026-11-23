/**
 * ai.js — AI 交互模块（Vercel AI SDK）
 *
 * 保留 askAI(userMessage, AIlist) 接口，内部全面使用 Vercel AI SDK：
 *   - createOpenAI 构建 provider，`address` 是 **base URL**（如 https://api.deepseek.com/v1），
 *     SDK 会在其后追加 /chat/completions 或 /responses，不再要求用户手写完整端点
 *   - responseAPI 仅决定请求体格式（responses API vs chat completions）
 *   - generateText / streamText 生成回复（stream 可选流式）
 *   - registerAITool 注册 AI 工具，由 profile 的 tools 配置决定是否暴露给模型
 *
 * 系统提示词按 provider 名加载：config/prompts/${oai[x].name}.md
 */

import { readFileSync } from 'node:fs';

import { createOpenAI } from '@ai-sdk/openai';
import { generateText, stepCountIs, streamText, tool } from 'ai';
import JSON5 from 'json5';
import z from 'zod';

import { neonaicCommandInterface } from '#src/command/commandInterface.js';
import { NeonaicCommandContext, neonaicCommandServer } from '#src/command/commandServer.js';
import { neonaicPermissionServer } from '#src/command/permissionServer.js';
import { getLogger } from '#src/logger/Logger.js';
import { NeonaicMediaMsgFrag, NeonaicMessage, NeonaicMessageFragment } from '#src/message/messageFragment.js';
import { neonaicUserDirectory } from '#src/message/userDirectory.js';
import { neonaicConfManager } from '#src/system/confManager.js';
import { neonaicChore, parseString } from '#src/utils/chore.js';
import { neonaicFileSystem } from '#src/utils/io.js';
import { NeonaicNewable } from '#src/utils/NeonaicNewableClass.js';
import { NeonaicIllegalArgumentError, NeonaicIllegalStateError, NeonaicNetworkError } from '#src/utils/NeonaicNewableError.js';

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

// ---- 工具过滤 ----

/**
 * 把 glob 片段转成正则源码：只有 `*` 是元字符，其余字符一律转义。
 * @param {string} glob
 * @param {string} starSrc `*` 对应的正则源码
 * @returns {string}
 */
function globToRegExpSource(glob, starSrc) {
  return glob
    .split('*')
    .map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join(starSrc);
}

/**
 * 匹配工具模式。`*` 是通配符，命名空间段与工具名段都可以写：
 *   - `"ns:name"` → 精确匹配该 fqn
 *   - `"ns:*"`    → 该命名空间下的全部工具
 *   - `"*:name"`  → 任意命名空间下名为 name 的工具（等价于省略命名空间的 `"name"`）
 *   - `"name"`    → 同上：省略命名空间即等价于 `"*:name"`
 *   - `"*"`       → 全部工具
 *
 * 命名空间与工具名在注册时都被规整为 `[a-zA-Z0-9_]`，段内不可能出现 ':'，
 * 因此按**第一个** ':' 切分命名空间与工具名是无歧义的。
 * @param {string} pattern
 * @returns {string[]} 匹配到的 fqn 列表
 */
function matchToolPattern(pattern) {
  if (typeof pattern !== 'string' || !pattern) return [];
  const sep = pattern.indexOf(':');
  // 省略命名空间时等价于 `*:name`，保持「不带前缀即跨命名空间」的既有语义
  const nsGlob = sep >= 0 ? pattern.slice(0, sep) : '*';
  const nameGlob = sep >= 0 ? pattern.slice(sep + 1) : pattern;
  // 命名空间段里的 '*' 不跨越 ':'；工具名段已在尾部，'*' 匹配剩余全部字符
  const nsRe = new RegExp(`^${globToRegExpSource(nsGlob, '[^:]*')}$`);
  const nameRe = new RegExp(`^${globToRegExpSource(nameGlob, '.*')}$`);
  const hits = [];
  for (const t of _allTools) {
    if (nsRe.test(t.namespace) && nameRe.test(t.name)) hits.push(`${t.namespace}:${t.name}`);
  }
  return hits;
}

/**
 * 精确匹配模式：候选名完全相等才算命中。
 * @param {string[]} candidates
 * @returns {(pattern: string) => string[]}
 */
function exactMatch(candidates) {
  const set = new Set(candidates);
  return (pattern) => (set.has(pattern) ? [pattern] : []);
}

/**
 * 把「模式列表」求值为一组具体名字。
 *
 * 规则（`tools` 与 `AIlist` **共用同一套**，避免两处语义各自漂移）：
 *   - `"*"`     → 纳入全部候选
 *   - `"!name"` → 排除；**排除优先于纳入**
 *   - `"!*"`    → 排除全部
 *   - 其余      → 纳入
 *
 * 单个模式能匹配到什么由调用方传入的 `match` 决定：`AIlist` 按候选名精确匹配，
 * `tools` 则支持 `*` 通配符（见 {@link matchToolPattern}）。
 *
 * @param {string|string[]|undefined} patterns 模式列表
 * @param {string[]} candidates 候选全集
 * @param {object} [options]
 * @param {(pattern: string) => string[]} [options.match] 单模式匹配函数，默认按候选名精确匹配
 * @param {boolean} [options.requireInclusion=false] 「没有任何纳入项」是否视为配置错误
 * @param {string} [options.label='模式列表'] 报错信息里使用的名称
 * @returns {string[]} 求值结果；顺序保持原有语义（全选时按候选顺序，否则按模式的书写顺序）
 * @throws {NeonaicIllegalArgumentError} 声明了 requireInclusion 且没有任何纳入项
 */
function resolvePatternList(patterns, candidates, options = {}) {
  const {
    match = exactMatch(candidates),
    requireInclusion = false,
    label = '模式列表',
  } = options;

  if (patterns == null) return [];
  const rules = Array.isArray(patterns) ? patterns : [patterns];
  if (!rules.length) return [];

  let allowAll = false;
  let hasInclusion = false;
  const allowed = new Set();
  const blocked = new Set();
  /** 没有匹配到任何候选的模式，用于提示拼写错误 */
  const unmatched = [];

  for (const raw of rules) {
    if (typeof raw !== 'string' || !raw) continue;
    const isNegate = raw.startsWith('!');
    const pattern = isNegate ? raw.slice(1) : raw;
    if (!pattern) continue;

    if (pattern === '*') {
      if (isNegate) blocked.add('*');
      else { allowAll = true; hasInclusion = true; }
      continue;
    }

    const hits = match(pattern);
    if (!hits.length) {
      unmatched.push(raw);
      continue;
    }
    if (!isNegate) hasInclusion = true;
    for (const h of hits) (isNegate ? blocked : allowed).add(h);
  }

  // 只写排除项时「究竟想选什么」是不明确的（是笔误，还是想表达「除它之外全部」？）。
  // 与其静默猜一个，不如直接报错 —— 「配置看起来生效了、其实一个都没选」是最难查的那类故障。
  if (requireInclusion && !hasInclusion) {
    throw new NeonaicIllegalArgumentError(
      `${label} 没有任何纳入项：${JSON.stringify(rules)}。`
      + `请显式写出要纳入的范围，例如 ["*", "!x"]`
      + (unmatched.length ? `；另外，以下模式未匹配到任何候选（可能拼写有误）：${unmatched.join(', ')}` : '')
      + '。',
    );
  }

  if (blocked.has('*')) return []; // "!*" 排除全部

  const source = allowAll ? candidates : [...allowed];
  return source.filter((c) => !blocked.has(c));
}

/**
 * 解析 profile.tools 配置，返回该 Profile 可用工具的 fqn 列表。
 *
 * 规则见 {@link resolvePatternList}，工具模式支持 `*` 通配符：`"*"` 全部、`"ns:*"` 整个命名空间、
 * `"*:name"` 或 `"name"` 跨命名空间按名匹配、`"!ns:*"` 屏蔽整个命名空间。
 * 空 / 未设置 → 不得调用任何工具。
 * @apiNote 这里刻意**不启用** requireInclusion：`tools: ["!x"]` 的既有语义是「一个都不给」，
 *          改成报错属于行为变更，留给显式决策（`AIlist` 走的是严格模式）。
 *
 * @param {string|string[]|undefined} toolsConfig
 * @returns {string[]} 可用工具的 fqn 列表
 */
function resolveToolList(toolsConfig) {
  return resolvePatternList(toolsConfig, _allTools.map((t) => `${t.namespace}:${t.name}`), {
    match: matchToolPattern,
    label: 'tools',
  });
}

// ---- Provider 托管工具 ----

/**
 * 可用作 Provider 托管工具的**归一化键名** → `client.tools` 上的 factory 方法名。
 *
 * 只收录「由 Provider 服务端执行」（`isProviderExecuted: true`）的内置工具：
 * 它们不需要本地 `execute`，模型调用后由服务端直接给出结果。
 * 像 `applyPatch` / `computer` / `shell` / `localShell` / `customTool` 这类
 * 「要应用侧执行并回传」的 provider 工具**刻意排除**——本项目没有对应的执行链路，
 * 放进来只会在模型调用的那一刻报「没有 execute」。
 *
 * @type {Record<string, string>}
 */
const PROVIDER_TOOL_FACTORIES = {
  codeinterpreter: 'codeInterpreter',
  filesearch: 'fileSearch',
  imagegeneration: 'imageGeneration',
  mcp: 'mcp',
  websearch: 'webSearch',
  websearchpreview: 'webSearchPreview',
};

/**
 * 归一化配置里写的 Provider 工具名：忽略大小写与 `_` / `-` / 空格，
 * 于是 `webSearch`、`web_search`、`web-search` 都指向同一个工具。
 * @param {string} key
 * @returns {string}
 */
function normalizeProviderToolKey(key) {
  return String(key).toLowerCase().replace(/[\s_-]/g, '');
}

/**
 * 解析 `oai[].providerTools` 配置，构造 Provider 托管工具表。
 *
 * 配置写法（`providerTools` 与 `tools` **相互独立**，不受其过滤）：
 *   - 对象：`{ "webSearch": true, "codeInterpreter": { "container": "auto" } }`
 *     值 `true` / 未写参数 → 用默认参数；写对象 → 原样透传给该工具的 factory；
 *     值 `false` / `null` → 显式关闭（便于临时停用而不删配置）
 *   - 数组简写：`["webSearch", "codeInterpreter"]` ≡ `{ webSearch: true, codeInterpreter: true }`
 *   - 数组值：同一工具构造多实例（典型是挂多个 MCP server），模型名依次为 `mcp`、`mcp_2`…
 *
 * @apiNote ⚠️ 必须传 `{}` 而不是 `undefined`：多数 factory 会解构 options 参数
 *          （`webSearchPreview()` 直接抛 `Cannot destructure property 'onInputStart'`），
 *          所以「用默认参数」也要显式给一个空对象。
 *
 * @param {object|string[]|undefined} config 配置值
 * @param {import('@ai-sdk/openai').OpenAIProvider['tools']} factories provider 提供的工具 factory 表
 * @param {string} [label='providerTools'] 报错信息里使用的配置项名
 * @returns {Record<string, object>} 模型可见名 → Provider 托管工具
 * @throws {NeonaicIllegalArgumentError} 配置类型不对、键名不认识、选项不是对象、构造失败
 */
function resolveProviderTools(config, factories, label = 'providerTools') {
  const table = {};
  if (config == null || config === false) return table;

  let entries;
  if (Array.isArray(config)) entries = config.map((key) => [key, true]);
  else if (typeof config === 'object') entries = Object.entries(config);
  else {
    throw new NeonaicIllegalArgumentError(
      `${label} 必须是对象或工具名数组，实际是 ${typeof config}：${JSON.stringify(config)}。`
      + `可用工具：${Object.keys(PROVIDER_TOOL_FACTORIES).join(', ')}。`,
    );
  }

  const unknown = [];
  for (const [rawKey, rawValue] of entries) {
    const factoryName = PROVIDER_TOOL_FACTORIES[normalizeProviderToolKey(rawKey)];
    if (!factoryName) {
      unknown.push(rawKey);
      continue;
    }
    // 同一工具可写成数组以构造多实例；单实例则退化为只有一项
    const optionList = Array.isArray(rawValue) ? rawValue : [rawValue];
    let instance = 0;
    for (const rawOptions of optionList) {
      if (rawOptions === false || rawOptions === null) continue;
      const options = (rawOptions === true || rawOptions === undefined) ? {} : rawOptions;
      if (typeof options !== 'object' || Array.isArray(options)) {
        throw new NeonaicIllegalArgumentError(
          `${label}.${rawKey} 的选项必须是对象、true 或它们的数组，实际是 ${JSON.stringify(rawOptions)}。`,
        );
      }
      let def;
      try {
        def = factories[factoryName](options);
      } catch (err) {
        throw new NeonaicIllegalArgumentError(
          `${label}.${rawKey} 构造失败：${err?.message ?? err}（选项：${JSON.stringify(options)}）。`, err,
        );
      }
      // 模型可见名取 provider 自己的工具名（openai.web_search → web_search），多实例加序号后缀
      const base = String(def?.id ?? '').split('.').pop() || factoryName;
      table[instance ? `${base}_${instance + 1}` : base] = def;
      instance += 1;
    }
  }

  if (unknown.length) {
    throw new NeonaicIllegalArgumentError(
      `${label} 中有不支持的 Provider 工具：${unknown.join(', ')}。`
      + `可用工具：${Object.keys(PROVIDER_TOOL_FACTORIES).join(', ')}（大小写与下划线不敏感）。`
      + '仅支持由 Provider 服务端执行的工具；applyPatch/computer/shell/localShell/customTool 需要应用侧回传结果，本项目不支持。',
    );
  }
  return table;
}

// ---- 调用 ----

/**
 * 将工具定义转换为 Vercel AI 的 tools 对象。
 *
 * `execute` 在这里**按调用包装**：把本轮的命令上下文与用户文本作为 `options.neonaic` /
 * `options.userInput` 交给工具。这样全局注册的拓展工具（定义在注册时就固定了）也能拿到本轮上下文，
 * 不需要依赖 SDK 的 `contextSchema` / `toolsContext` —— 那条路会按 schema 重建对象，
 * 类实例会被剥成普通对象，getter 与方法全部丢失。
 *
 * @param {(NeonaicTAIToolDef|null|undefined)[]} toolList 工具定义列表
 * @param {NeonaicCommandContext} ctx 本轮命令上下文
 * @param {string} userInput 本轮用户文本
 * @returns {Record<string, object>} 模型可见名 → 工具
 */
function buildToolSet(toolList, ctx, userInput) {
  const tools = {};
  for (const def of toolList) {
    if (!def) continue;
    const fqn = `${def.namespace}:${def.name}`;
    // OpenAI 工具名仅允许 [a-zA-Z0-9_-]，将 fqn 的 ':' 替换为 '-' 作为模型可见名
    const modelName = fqn.replace(/:/g, '-');
    tools[modelName] = tool({
      description: def.description || undefined,
      // 少数临时工具没有声明 schema，补一个空对象，避免 SDK 序列化时拿到 undefined
      inputSchema: def.inputSchema ?? z.object({}),
      execute: (input, options) => def.execute(input, {
        ...options,
        neonaic: ctx,
        userInput,
      }),
    });
  }
  return tools;
}

/**
 * 从本轮发送给模型的内容里取出纯文本。
 * 多模态消息的 content 是片段数组，工具只关心其中的文本部分。
 * @param {string|Array<{type?: string, text?: string}>} content
 * @returns {string}
 */
function plainTextOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

// ---- 多模态 ----

/** MIME 别名（配置里常见 image/jpg、audio/mp3 这类不规范的写法） */
const MIME_ALIASES = Object.freeze({
  'image/jpg': 'image/jpeg',
  'image/x-png': 'image/png',
  'audio/mp3': 'audio/mpeg',
  'audio/wave': 'audio/wav',
  'audio/x-wav': 'audio/wav',
  'video/x-m4v': 'video/mp4',
});

/** 媒体种类的中文名，用于降级时的占位文本 */
const MEDIA_LABELS = Object.freeze({ image: '图片', audio: '音频', video: '视频' });

/**
 * 规范化 MIME：小写、去空白、折叠常见别名。
 * @param {string} mime
 * @returns {string}
 */
function normalizeMime(mime) {
  const lower = parseString(mime).trim().toLowerCase();
  return MIME_ALIASES[lower] ?? lower;
}

/**
 * 读取 Profile 声明的多模态能力。
 *
 * 同时接受正字 `multimodal` 与历史拼写 `mutimodal`（正字优先）；
 * 每种模态的值为 `true`（等价于 `["*"]`）、单个 MIME 或 MIME 数组。
 * 数组为空 / 缺省表示**不支持**该模态。
 *
 * @param {object} provider oai 配置项
 * @returns {{image: string[], audio: string[], video: string[]}} 规范化后的 MIME 列表
 */
function resolveMultimodal(provider) {
  const raw = provider?.multimodal ?? provider?.mutimodal;
  const caps = { image: [], audio: [], video: [] };
  if (!raw || typeof raw !== 'object') return caps;
  for (const kind of Object.keys(caps)) {
    const value = raw[kind];
    if (value === true) { caps[kind] = ['*']; continue; }
    if (!value) continue;
    const list = Array.isArray(value) ? value : [value];
    caps[kind] = list
      .filter((v) => typeof v === 'string' && v.trim())
      .map(normalizeMime);
  }
  return caps;
}

/**
 * Profile 是否能理解指定媒体。
 * @param {{image: string[], audio: string[], video: string[]}} caps
 * @param {'image'|'audio'|'video'} kind 媒体种类
 * @param {string|null} mime
 * @returns {boolean}
 * @apiNote MIME 未知时**放行**：由于非异步问题，远程媒体无法获取 MIME。
 */
function supportsMedia(caps, kind, mime) {
  const list = caps[kind] ?? [];
  if (!mime) return true;
  if (!list.length) return false;
  if (list.includes('*') || list.includes(kind) || list.includes(`${kind}/*`)) return true;
  return list.includes(normalizeMime(mime));
}

/**
 * 是否是可被远端模型取到的地址。
 * 只有 http(s) 算数：data: 是内联数据（只能作为 data 片段发送，不能写进 markdown），
 * blob:/file: 是本地资源，模型取不到。
 * @param {string} uri
 * @returns {boolean}
 */
function isRemoteMediaUrl(uri) {
  return /^https?:\/\//i.test(parseString(uri).trim());
}

/**
 * 把媒体片段降级成占位文本（来源不是可公开访问的 URL 时使用）。
 * @param {'image'|'audio'|'video'} kind
 * @returns {string}
 */
function mediaPlaceholder(kind) {
  return `about:block/media?type=${kind}&label=${MEDIA_LABELS[kind] ?? '媒体'}`;
}

/**
 * 把消息渲染成**纯文本** markdown：媒体保留 URL 链接，base64 / 本地地址降级为占位。
 * 用于提示词优化（优化器只吃文本）与「该 Profile 不支持该模态」的兜底。
 * @param {NeonaicMessage} message
 * @returns {string}
 */
function renderTextOnly(message) {
  let out = '';
  message.forEachFrag((frag) => {
    if (frag instanceof NeonaicMediaMsgFrag && !isRemoteMediaUrl(frag.uri)) {
      out += mediaPlaceholder(frag.TYPE);
      return;
    }
    out += frag.markdown;
  });
  return out;
}

/**
 * 把单个媒体片段转成 AI SDK 的内容片段。
 * @param {NeonaicMediaMsgFrag} frag 媒体片段
 * @param {{image: string[], audio: string[], video: string[]}} caps 多模态能力
 * @param {object} provider oai 配置项
 * @returns {{type: 'file', mediaType: string, data: {type: 'url'|'data', url?: string, data?: string}}|null} 不支持/不可上传时为 null
 * @apiNote 模态**已开启**时，URL 与 base64 都会发出去：base64 走 `data` 片段，URL 走 `url` 片段。
 *          「只允许 URL、不允许 base64」只约束**降级到 markdown** 的那条路。
 * @apiNote 传输限制（`@ai-sdk/openai`）：
 *          - Chat Completions 支持图片（URL/data）与 wav/mp3 音频（仅 data），不支持视频，
 *            音频 URL 也会被 SDK 拒绝；
 *          - Responses API 支持非图片文件的 URL（`input_file.file_url`），内联非图片文件需要
 *            `passThroughUnsupportedFiles`（`callProvider` 已按 Profile 声明打开）。
 */
function buildMediaPart(frag, caps, provider) {
  const kind = frag.TYPE;
  if (kind !== 'image' && kind !== 'audio' && kind !== 'video') return null;
  if (!supportsMedia(caps, kind, frag.mime)) return null;

  const uri = parseString(frag.uri).trim();
  if (!uri) return null;

  // 已开启的模态：base64 直接内联（只有降级 markdown 时才禁止 base64）
  if (frag.isBase64 || /^data:/i.test(uri)) {
    const comma = uri.indexOf(',');
    if (comma < 0) return null;
    const header = uri.slice(5, comma);
    // 非 base64 的 data URL（如 data:text/plain,xxx）不能作为 file data 传递
    if (!/;base64$/i.test(header)) return null;
    const mediaType = normalizeMime(header.slice(0, -';base64'.length)) || frag.mime || kind;
    // Chat 只支持图片与 wav/mp3 音频的内联；视频任何接口都不接受内联
    if (kind === 'video' && !provider?.responseAPI) return null;
    if (kind === 'audio' && !provider?.responseAPI && mediaType !== 'audio/wav' && mediaType !== 'audio/mpeg') {
      return null;
    }
    return { type: 'file', mediaType, data: { type: 'data', data: uri.slice(comma + 1) } };
  }

  if (!isRemoteMediaUrl(uri)) return null;
  // Chat Completions 传不了音频/视频的 URL
  if (!provider?.responseAPI && kind !== 'image') return null;
  return {
    type: 'file',
    mediaType: frag.mime ? normalizeMime(frag.mime) : kind,
    data: { type: 'url', url: uri },
  };
}

/**
 * 按 Profile 的多模态能力构建消息内容。
 *
 * - 支持的媒体 → AI SDK 的 `file` 内容片段；
 * - 不支持的媒体 → 降级为 markdown（URL），base64 / 本地地址换成占位文本；
 * - 全程没有媒体片段时返回字符串，保持与旧实现完全一致的请求体。
 *
 * @param {NeonaicMessage} message 消息
 * @param {object} provider oai 配置项
 * @param {string|null} [optimizedText=null] 提示词优化后的文本；给出时用它替换文本部分
 * @returns {string|Array<object>} 字符串或 AI SDK 内容片段数组
 */
function buildUserContent(message, provider, optimizedText = null) {
  const caps = resolveMultimodal(provider);
  const parts = [];
  let text = '';

  message.forEachFrag((frag) => {
    if (!(frag instanceof NeonaicMediaMsgFrag)) {
      text += frag.markdown;
      return;
    }
    const part = buildMediaPart(frag, caps, provider);
    if (part) {
      parts.push(part);
      return;
    }
    // 未开启该模态或格式不在白名单：降级为 markdown，但只允许 URL
    text += isRemoteMediaUrl(frag.uri) ? frag.markdown : mediaPlaceholder(frag.TYPE);
  });

  const finalText = optimizedText ?? text;
  if (!parts.length) return finalText;
  // 纯媒体消息没有文本时不要塞一个空 text 片段
  return finalText ? [{ type: 'text', text: finalText }, ...parts] : parts;
}

/**
 * 调用单个 AI Profile 获取回复。
 * @param {object} provider oai 配置项
 * @param {string|Array<object>} userMessage 纯文本，或 AI SDK 消息内容片段数组
 * @param {(NeonaicTAIToolDef|null|undefined)[]} [overrideAITool] 要叠加的 AI 工具，将临时覆写已有 AI 工具
 * @param {String|null} overridePrompt 要覆写提示词吗
 * @param {NeonaicCommandContext} ctx 
 * @returns {Promise<string>}
 * @internalApi
 */
async function callProvider(provider, userMessage, overrideAITool = [], overridePrompt = null, ctx = new NeonaicCommandContext()) {
  const systemPrompt = (typeof overridePrompt === 'string' && overridePrompt)
    ? overridePrompt
    : loadSystemPrompt(provider.prompt);
  const SESSION_ID = `#${NeonaicNewable.getUniqueId()}`;

  // address 是 base URL，端点（/chat/completions、/responses）由 SDK 追加。
  const client = createOpenAI({
    apiKey: provider.token,
    name: provider.name,
    baseURL: provider.address,
  });

  // responseAPI 仅决定请求体格式（responses API vs chat completions），端点由 SDK 按 base URL 拼接
  const model = provider.responseAPI
    ? client.responses(provider.model)
    : client.chat(provider.model);

  /** 本 Profile 声明的多模态能力，下文多处复用 */
  const caps = resolveMultimodal(provider);

  // AI SDK 只会原样透传 `model.supportedUrls` 里声明的 URL，其余文件 URL 会先被**下载**再以内联
  // base64 发送（见 ai 包的 downloadAssets）。对音频/视频来说这既会改变「只允许 URL」的行为，
  // 也会把整个视频拉进内存。Profile 既然声明了能理解这些模态，就补上 URL 支持，
  // 让 Responses API 直接收到 `input_file.file_url`。
  if (provider.responseAPI) {
    const extraUrls = {};
    if (caps.audio.length) extraUrls['audio/*'] = [/^https?:\/\/.*$/];
    if (caps.video.length) extraUrls['video/*'] = [/^https?:\/\/.*$/];
    if (Object.keys(extraUrls).length) {
      model.supportedUrls = { ...model.supportedUrls, ...extraUrls };
    }
  }

  // 按 tools 配置过滤可用工具
  const toolList = resolveToolList(provider.tools).map((v) => {
    const t = _toolFqn.get(v);
    return t ? t : null;
  });

  // Provider 托管工具（由 Provider 服务端执行，与 provider.tools 的本地工具相互独立）。
  // ⚠️ 只有 Responses API 会把这些工具写进请求体：Chat Completions 的 tools 只接受 function，
  // `prepareChatTools` 遇到 provider 类型只会 push 一条 unsupported warning 然后**静默丢弃**。
  // 这种「配置看起来生效了、其实一个都没送出去」的故障最难查，所以这里直接判死。
  const providerToolSet = resolveProviderTools(provider.providerTools, client.tools);
  const providerToolNames = Object.keys(providerToolSet);
  if (providerToolNames.length && !provider.responseAPI) {
    throw new NeonaicIllegalArgumentError(
      `Profile "${provider.name}" 配置了 providerTools（${providerToolNames.join(', ')}），但 responseAPI=false；`
      + 'Provider 托管工具只在 Responses API 下可用，Chat Completions 端点会被 SDK 静默丢弃。'
      + '请改为 responseAPI: true，或移除 providerTools。',
    );
  }

  // 先合并再判断是否为空。
  // 原写法是在 `provider.tools` 解析结果非空时才把 overrideAITool 一起送出，
  // 于是「Profile 没有启用任何工具」时，临时叠加的工具会被**静默丢弃**
  // （例如只有 tools: [] 的 Profile 上，身份工具会凭空消失）。
  //
  // ⚠️ 用一次 buildToolSet 构建，不要对两个「工具表」再套 joinObject：
  // 那会把 `{tools, toolsContext}` 当成两层结构做浅合并，后者会把前者的整个 `tools` 键覆盖掉。
  const userInput = plainTextOf(userMessage);
  const extraTools = Array.isArray(overrideAITool) ? overrideAITool.filter(Boolean) : [];
  // 临时工具排在后面：同名时后写入的覆盖前者，即临时工具优先
  const tools = {
    ...providerToolSet,
    ...buildToolSet([...toolList, ...extraTools], ctx, userInput),
  };
  const toolNames = Object.keys(tools);

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
  const extraCount = extraTools.length;
  const providerCount = providerToolNames.length;
  const mediaCount = Array.isArray(userMessage) ? userMessage.filter((p) => p?.type === 'file').length : 0;
  getLogger().tool.info(
    `${SESSION_ID} → ${provider.name}: ${provider.address}#${provider.model} (${endpoint}${provider.stream ? ', stream' : ''}, ${toolNames.length} tools${providerCount ? ` 含 provider ${providerCount}` : ''}${extraCount ? ` 含临时 ${extraCount}` : ''}, maxToolcall=${maxToolcall}${mediaCount ? `, ${mediaCount} media` : ''})`,
  );

  const common = {
    model,
    system: systemPrompt,
    messages,
    // ⚠️ 必须包成 `{ tools }`：`tools` 是「模型名 → 工具」的表，
    // 直接展开会把每个工具名变成顶层参数（请求体里会出现 `probe-ctx: {...}`），SDK 认不出。
    ...(toolNames.length ? { tools } : {}),
    // Responses API 默认拒绝「非图片、非 PDF」的内联文件（音频/视频 data 片段会被 SDK 拦下）。
    // Profile 声明了这些模态时打开透传，让它们以 input_file/file_data 发出去。
    // ⚠️ 选项名固定是 `openai`（azure 端点用 `azure`），与 Profile 的 name 无关。
    ...(provider.responseAPI && (caps.audio.length || caps.video.length)
      ? { providerOptions: { [String(provider.name).includes('azure') ? 'azure' : 'openai']: { passThroughUnsupportedFiles: true } } }
      : {}),
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
      .map((t) => `${t.toolName.replace(/* "-"被用于分隔命名空间和工具名，且在定义工具时已经转义，所以这里就换回来 *//-/, ':')}(${JSON.stringify(t.input ?? {})})`)
      .join('; ');
    getLogger().tool.info(`${SESSION_ID} ◉ ${provider.name} 调用工具: ${summary.replace(/\n/g, "\\n")}`);
    const toolResults = await (result.toolResults ?? []);
    for (const tr of toolResults) {
      const out = typeof tr.output === 'string' ? tr.output : JSON.stringify(tr.output);
      getLogger().tool.info(`${SESSION_ID}  ↳ ${tr.toolName} → ${out.replace(/\n/g, "\\n").slice(0, 200)}`);
    }
  }

  const reply = (await result.text) ?? '';
  getLogger().tool.info(`${SESSION_ID} ← ${provider.name}: ${reply.length} 字符`);
  return (reply.length == 0) ? `“（${neonaicConfManager.getBotName()}”点了点头，并没有说什么）` : reply;
}

// ---- 外部 API ----

/**
 * 检查调用者是否被禁止使用 AI。
 * @param {string|string[]|null|undefined} caller 调用者标识（执行者链）
 * @returns {{banned: boolean, until?: Date}}
 */
function isAIBanned(caller) {
  if (!Array.isArray(caller)) caller = caller ? [parseString(caller)] : [neonaicCommandInterface.COMMAND_ENUMS.FROM_UNKNOW];

  // 对每一层校验
  for (let index = 0; index < caller.length; index++) {
    const user = caller[index];
    const result = neonaicPermissionServer.getSinglePermissionStatus(user, AI_BAN_PERMISSION);
    // 如果权限没有显式拒绝则跳过
    if (result.status !== 'false') continue;
    // 被拒绝后判断是不是临时拒绝
    if (result.permanent) {
      return { banned: true };
    } else {
      return {
        banned: true,
        until: result.until
      };
    }
  }
  // 每一层都没有拒绝
  return { banned: false };
}

/**
 * 把 `speaker` 选项解析成一段可读描述。
 *
 * @param {string|object|null|undefined} speaker
 *   - `undefined` → 用 `caller` 查用户名录（默认行为）
 *   - `string`    → 直接采用（平台已自行解析好，最灵活）
 *   - `object`    → 结构化 `{ name, pronoun, note }`；场景部分仍由 `caller` 查名录补齐
 *   - `null`      → 明确不投递身份（如提示词优化这类非对话轮次）
 * @param {string|string[]|undefined} caller 执行者链，用于查名录
 * @returns {string} 可读描述；空串表示无可读身份信息
 */
function resolveSpeaker(speaker, caller) {
  if (speaker === null || speaker === false) return '';
  if (typeof speaker === 'string') return speaker.trim();
  if (speaker && typeof speaker === 'object' && !Array.isArray(speaker)) {
    const entry = neonaicUserDirectory.normalizeEntry(speaker);
    if (!entry) return '';
    // caller[0] 就是说话者本人，不要再当作场景渲染一遍
    return neonaicUserDirectory.composeSentence(entry, Array.isArray(caller) ? caller.slice(1) : []);
  }
  return neonaicUserDirectory.describe(caller);
}

/** `caller` 弃用提示只记一次：它可能被每轮对话触发，重复刷屏没有意义 */
let _callerDeprecationWarned = false;

/** 提示 `askAI` 的 `caller` 选项已弃用（每个进程只提示一次） */
function warnCallerDeprecatedOnce() {
  if (_callerDeprecationWarned) return;
  _callerDeprecationWarned = true;
  getLogger().tool.warn(
    '[ai] askAI 的 options.caller 已弃用，请改用 options.context'
    + '（NeonaicCommandContext 或其普通对象形式）；兼容垫片会把 privateExecutor 视为 false。',
  );
}

/**
 * 把 {@link askAI} 的 `context` / 兼容用的 `caller` 归一化为命令上下文。
 *
 * - 普通对象会被 `new NeonaicCommandContext(...)` 包一层（平台侧通常只提供 `{ executor, privateExecutor }`）；
 * - 一律返回**副本**，工具改动不会污染调用方；
 * - 强制 `internalCall = false`：`checkPermissionFromContext` 对 internalCall 直接放行，AI 层不能继承；
 * - 清空 `this`：工具是按全局语义注册的，平台对象不应经此泄漏，也避免指代不明。
 *
 * @param {NeonaicCommandContext|{executor?: string|string[], privateExecutor?: boolean}} [input]
 * @returns {NeonaicCommandContext}
 */
function toCommandContext(input) {
  let ctx;
  if (input instanceof NeonaicCommandContext) {
    ctx = input.clone();
  } else {
    const source = input ?? {};
    // 显式补 []：构造函数会把缺省的 executor 记成 $unknown，而「没传 caller」应当是空链
    ctx = new NeonaicCommandContext({ ...source, executor: source.executor ?? [] });
  }
  ctx.internalCall = false;
  ctx.this = undefined;
  return ctx;
}

/**
 * @param {string|NeonaicMessage|NeonaicMessageFragment|NeonaicMessageFragment[]|string[]} userMessage 用户传入消息或输入提示词
 * @param {object} options 选项
 * @param {string|string[]} [options.AIlist] 允许的 AI Profile 列表：`"*"` 全部、`"!name"` 排除（排除优先）
 * @param {NeonaicCommandContext|{executor?: string|string[], privateExecutor?: boolean}} [options.context] 本轮命令上下文；与 `caller` 互斥
 * @param {string|string[]|null|undefined} [options.caller] 调用者标识（执行者链），用于封禁检查与身份解析
 * @deprecated `options.caller` 已弃用，请改用 `options.context`；仅在未提供 `context` 时作为兼容垫片，`privateExecutor` 固定为 false
 * @param {string|object|null} [options.speaker] 向模型描述「当前对话者是谁」的方式，见 {@link resolveSpeaker}
 * @param {boolean} [options.preprocessWilling] 是否接受优化提示词，是否生效取决于用户配置
 * @param {NeonaicTAIToolDef[]|NeonaicTAIToolDef} [options.overrideAITool] 要叠加的 AI 工具，将临时覆写已有 AI 工具
 * @param {String} [options.overridePrompt] 存在此字符串将覆写 AI Profile 的提示词
 * @returns {Promise<string>|string} AI 回复文本
 * @throws {NeonaicIllegalStateError} 无权访问
 * @throws {NeonaicIllegalArgumentError} 参数互斥 / 无可用 Profile / 所有 Profile 请求失败
 */
async function askAI(userMessage, options) {
  const rawOptions = options ?? {};
  if (rawOptions.caller != null && rawOptions.context != null) {
    throw new NeonaicIllegalArgumentError('options.caller 与 options.context 互斥，只能提供其中一个');
  }
  if (rawOptions.caller != null) warnCallerDeprecatedOnce();

  // 初始化配置
  const conf = neonaicChore.joinObject({
    AIlist: ['*'],
    speaker: undefined,
    preprocessWilling: false,
    overrideAITool: [],
    overridePrompt: undefined,
  }, rawOptions);
  // context 优先；只给 caller 时用兼容垫片（privateExecutor 缺省 false）
  const ctx = toCommandContext(rawOptions.context ?? { executor: rawOptions.caller ?? [] });
  if (neonaicAI.isAIBanned(ctx.executor).banned) throw new NeonaicIllegalStateError('对“智能回复”的访问被拒绝');

  // 对 AIlist 做标准化处理：字符串 → 数组，去除空值，trim
  if (!Array.isArray(conf.AIlist)) conf.AIlist = [conf.AIlist];
  conf.AIlist = conf.AIlist.map((v) => (typeof v === 'string' ? v.trim() : parseString(v, false).trim()));

  // 对覆写 tool 处理
  if (!Array.isArray(conf.overrideAITool)) conf.overrideAITool = [conf.overrideAITool];
  conf.overrideAITool = conf.overrideAITool.map((/** @type {NeonaicTAIToolDef|null} */v) => {
    return (v?.namespace && v?.name && typeof v?.execute === 'function')
      ? {
        namespace: parseString(v.namespace),
        name: parseString(v.name),
        description: (v?.description) ? parseString(v?.description) : "",
        inputSchema: v?.inputSchema,
        execute: v.execute
      }
      : null;
  });

  // 身份投递：把「当前对话者是谁」注册成一个**临时 AI 工具**，由模型按需调用。
  //
  // 为什么走工具而不是拼进提示词：
  //   1. 不污染 system prompt，不影响提示词缓存（前缀稳定 ⇒ 计费与命中都更友好）；
  //   2. 复用既有的 overrideAITool 通道，不新增参数管线；
  //   3. 职责清晰 —— 身份是「可查询的事实」，而不是每轮都必须塞给模型的上下文。
  // 代价：模型不问就不知道。若某些场景希望「不用说也知道」，调用方改传 `speaker: '…'`
  // 并自行拼进消息，或后续再加一个显式的注入开关。
  const speakerText = resolveSpeaker(conf.speaker, ctx.executor);
  if (speakerText) {
    conf.overrideAITool.push({
      namespace: 'neonaic',
      name: 'speaker',
      description: '查询当前与你对话的人是谁。'
        + '返回本地名录中登记的可读身份（昵称、称呼偏好等）；名录未登记时会如实说明。',
      inputSchema: z.object({}),
      execute: async () => speakerText,
    });
  }

  // 搜索可用的 AI Profile
  // AIlist 与 tools 共用同一套模式规则：'*' 全选、'!name' 排除（排除优先）、'!*' 全排除。
  // 刻意启用严格模式：只写排除项会被判为配置错误，而不是静默选出一个空集。
  const allProfiles = neonaicConfManager.getConfig(neonaicConfManager.CONFIG_PATHS.secret).getList('oai');
  const allProfileNames = allProfiles
    .map((p) => p?.name)
    .filter((n) => typeof n === 'string' && n);
  const chosen = new Set(resolvePatternList(conf.AIlist, allProfileNames, {
    requireInclusion: true,
    label: 'AIlist',
  }));

  // available: false 是独立的可用性闸门，不受 AIlist 的排除语义影响
  const oaiList = allProfiles.filter((v) => v?.available !== false && chosen.has(v?.name));

  if (!oaiList.length) {
    throw new NeonaicIllegalArgumentError(
      chosen.size === 0
        ? '未找到可用的 AI Profile（AIlist 把全部 Profile 都排除了）'
        : '未找到可用的 AI Profile（可能都被 available:false 禁用，或不在 AIlist 内）',
    );
  }

  // 归一化消息：字符串 / 单个片段 / 片段数组都装成 NeonaicMessage（构造函数负责）
  const message = (userMessage instanceof NeonaicMessage) ? userMessage : new NeonaicMessage(userMessage);

  // 尝试优化提示词。优化器只吃文本，因此媒体按 URL 渲染、base64 与本地地址降级成占位文本。
  /** @type {string|null} */
  let optimizedText = null;
  if (neonaicConfManager.getConfig(neonaicConfManager.CONFIG_PATHS.main).getBoolean('ai.acceptOptimizingPrompt', true) && conf.preprocessWilling) {
    try {
      optimizedText = await neonaicAI.askAI(renderTextOnly(message), {
        AIlist: neonaicConfManager.getConfig(neonaicConfManager.CONFIG_PATHS.main).getList('ai.model2Optimize', true),
        context: ctx,
        // 提示词优化不是对话轮次，明确不投递身份（否则会白挂一个 speaker 工具）
        speaker: null,
        preprocessWilling: false, // 避免无限递归
        overridePrompt: `请将用户输入优化为更适合 LLM AI 理解的提示词，可以少量增删词语，但不得改变原意。`,
      });
    } catch (e) {
      getLogger().tool.warn("无法进行提示词优化:", e);
    }
  }

  // 生成回复。每个 Profile 的多模态能力不同，内容要按 Profile 逐个构建
  const errors = new Map();
  for (const provider of oaiList) {
    try {
      return await callProvider(
        provider,
        buildUserContent(message, provider, optimizedText),
        conf.overrideAITool,
        conf.overridePrompt,
        ctx
      );
    } catch (err) {
      const reason = err?.message || (err?.statusCode ?? parseString(err));
      getLogger().tool.debug(`× ${provider.name}: ${reason}`);
      errors.set(provider.name, reason);
    }
  }

  let detail = '所有 AI Profile 请求失败: ';
  errors.forEach((v, k) => { detail += `${k}: "${String(v).replace(/\n/g, '\\n')}"; `; });
  throw new NeonaicNetworkError(detail);
}

// ---- 命令辅助 ----

/**
 * 查找工具定义。
 * @param {string} ref 工具引用：fqn（ns:name），支持 `*` 通配符（如 `ns:*`）；省略命名空间时按名跨命名空间匹配
 * @returns {NeonaicTAIToolDef[]}
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

// ---- ai 命令 ----

neonaicCommandServer.registerCommand('neonaic', 'ai', async function (sub, ...args) {
  /** @type {import('#src/command/commandServer.js').NeonaicCommandContext} */
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
    case 'whois':
      return aiWhois(ctx, ...args);
    default:
      return `用法: ${cmdAIUsage()}`;
  }
}, {
  permissions: [[neonaicCommandInterface.COMMAND_ENUMS.PERM_SUPERADMIN, "neonaic.command.ai"]],
  description: "AI 工具与 Profile 管理",
  usage: "ai <tool|profile|ban|pardon|whois> ...",
  alias: ['askai'],
});

/** ai 命令用法文本 */
function cmdAIUsage() {
  return "ai tool list | ai tool test <tool> <json5> | ai profile list | ai profile <enable|disable> <profile> | ai profile test <profile> <msg> | ai ban <user> [time] | ai pardon <user> | ai whois <list|get|set|unset|show> ...";
}

/**
 * ai whois 子命令：维护「内部代号 → 可读身份」的用户名录。
 *
 * 用途：让模型知道「当前对话者是谁」，而不是收到一串无意义的 openid。
 * 名录由 `askAI` 在每次调用时按需投递成一个临时 AI 工具（`neonaic:speaker`）。
 *
 * 用法：
 *   whois list                          列出全部登记
 *   whois get <code>                    查看单条原始记录
 *   whois set <code> <名字> [称呼偏好]   新增/更新；名字后的剩余参数合并为称呼偏好
 *   whois unset <code>                  删除
 *   whois show <code...>                预览模型会看到的描述（第一个是说话者，其余是场景）
 *
 * `<code>` 就是执行者链里的标识（与 `config/saves/permissions.json` 的键一致），
 * 如 `USR#3f2a…`（私聊/群成员）、`GRP#7E6B…`（群）。
 * @apiNote 条目还支持 `note` 字段（补充说明），仅可手工编辑 `config/saves/identities.json` 添加。
 *
 * @param {import('#src/command/commandServer.js').NeonaicCommandContext} ctx
 * @param {...string} args
 */
function aiWhois(ctx, ...args) {
  const op = args[0];
  /** 名录改动与权限设置同属敏感操作，与 `permission` 命令保持一致：要求私密上下文 */
  if (!ctx.privateExecutor) return `“${neonaicConfManager.getBotName()}”未能完成操作，因为当前上下文不是私密的。`;

  switch (op) {
    case 'list': {
      const rows = neonaicUserDirectory.list();
      if (!rows.length) {
        return `用户名录为空。可用 “ai whois set <code> <名字>” 添加，或直接编辑 ${neonaicUserDirectory.FILE}`;
      }
      return [`用户名录（${rows.length} 条）：`, ...rows.map((r) => `${r.code} → ${neonaicUserDirectory.renderEntry(r.entry)}`)].join('\n');
    }
    case 'get': {
      const code = args[1];
      if (!code) return '用法: ai whois get <code>';
      const entry = neonaicUserDirectory.get(code);
      return entry ? `${code} → ${JSON.stringify(entry)}` : `用户名录中没有 ${code}`;
    }
    case 'set': {
      const [code, name] = [args[1], args[2]];
      if (!code || !name) return '用法: ai whois set <code> <名字> [称呼偏好]';
      const pronoun = args.slice(3).join(' ').trim();
      const entry = neonaicUserDirectory.set(code, pronoun ? { name, pronoun } : { name });
      return `已登记 ${code} → ${neonaicUserDirectory.renderEntry(entry)}（名录共 ${neonaicUserDirectory.size()} 条）`;
    }
    case 'unset': {
      const code = args[1];
      if (!code) return '用法: ai whois unset <code>';
      return neonaicUserDirectory.remove(code)
        ? `已从用户名录删除 ${code}`
        : `用户名录中没有 ${code}`;
    }
    case 'show': {
      const codes = args.slice(1);
      if (!codes.length) return '用法: ai whois show <code...>（第一个是说话者，其余是场景）';
      const text = neonaicUserDirectory.describe(codes);
      return text || '（这些代号均未登记，模型将看不到任何身份信息）';
    }
    default:
      return '用法: ai whois <list|get|set|unset|show> ...';
  }
}

/**
 * ai tool 子命令。
 * @param {import('#src/command/commandServer.js').NeonaicCommandContext} ctx
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
      // 引用支持 `*` 通配符，可能一次命中多个；随机挑第一个执行等于「静默跑错工具」，直接要求写精确
      if (def.length > 1) {
        return `工具引用 "${toolRef}" 匹配到 ${def.length} 个工具，请写得更精确：\n`
          + def.map((d) => `${d.namespace}:${d.name}`).join('\n');
      }
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
 * @param {import('#src/command/commandServer.js').NeonaicCommandContext} ctx
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
      if (profileName.trim() == '*') {
        // 执行全量测试
        return await askAI(msg, { AIlist: ['*'], context: ctx, preprocessWilling: false });
      }

      // 非全量测试
      const target = findProvider(profileName);
      if (!target) return `未找到 AI Profile: ${profileName}`;
      try {
        const overrideAITool = [];
        const speakerText = resolveSpeaker(undefined, ctx.executor);
        if (speakerText) {
          overrideAITool.push({
            namespace: 'neonaic',
            name: 'speaker',
            description: '查询当前与你对话的人是谁。'
              + '返回本地名录中登记的可读身份（昵称、称呼偏好等）；名录未登记时会如实说明。',
            inputSchema: z.object({}),
            execute: async () => speakerText,
          });
        }
        return await callProvider(target, msg, overrideAITool, null, toCommandContext(ctx));
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
 * @param {import('#src/command/commandServer.js').NeonaicCommandContext} ctx
 * @param {string} user
 * @param {string} [time] 持续时间（如 '1h'、'2d'、'1y2M3d4h5m6s'），存在则设临时封禁
 */
function aiBan(ctx, user, time) {
  if (!user) return '用法: ai ban <user> [time]';

  if (time !== undefined) {
    // 临时封禁：解析持续时间 → 过期时间 = 当前 + 持续
    const ms = neonaicChore.parseDuration(time);
    if (ms == null) return `无法解析持续时间: "${time}"（如 '1h'、'2d'、'1y2M3d4h5m6s'）`;
    const until = Date.now() + ms;
    neonaicPermissionServer.setTempPermission(user, AI_BAN_PERMISSION, false, until);
    return `已临时封禁 ${user} 使用 AI 功能，持续 ${time}，过期 ${neonaicChore.parseCnDatetime(new Date(until))}`;
  }

  neonaicPermissionServer.setPermission(user, AI_BAN_PERMISSION, false);
  return `已封禁 ${user} 使用 AI 功能`;
}

/**
 * ai pardon 子命令：解封用户。
 * @param {import('#src/command/commandServer.js').NeonaicCommandContext} ctx
 * @param {string} user
 */
function aiPardon(ctx, user) {
  if (!user) return '用法: ai pardon <user>';
  neonaicPermissionServer.clearPermission(user, AI_BAN_PERMISSION);
  return `已解封 ${user}`;
}

export const neonaicAI = {
  defineAITool,
  registerAITool,
  unregisterAITool,
  getAITools,
  resolveToolList,
  resolveProviderTools,
  isAIBanned,
  askAI,
  findTool,
  findProvider,
};