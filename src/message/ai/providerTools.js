/**
 * ai/providerTools.js — 交给 Provider 的工具
 *
 * 两条互不相干的路：
 *   - `providerTools`：OpenAI 官方内置工具（SDK 原生通道，仅 Responses API）
 *   - `extraTools`：请求体里原样追加的自定义工具类型（第三方兼容平台，任意端点）
 */

import { getLogger } from '#src/logger/Logger.js';
import { NeonaicIllegalArgumentError } from '#src/utils/NeonaicNewableError.js';

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
      + `可用工具：${Object.values(PROVIDER_TOOL_FACTORIES).join(', ')}。`,
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
      + `可用工具：${Object.values(PROVIDER_TOOL_FACTORIES).join(', ')}（大小写与下划线不敏感）。`
      + '仅支持由 Provider 服务端执行的工具；applyPatch/computer/shell/localShell/customTool 需要应用侧回传结果，本项目不支持。'
      + '第三方兼容平台的自定义工具类型（如 deepseek 的 deepseek_web_search）请写进 extraTools。',
    );
  }
  return table;
}

// ---- 请求体工具注入 ----

/**
 * 解析 `oai[].extraTools` 配置，得到要**原样追加**到请求体 `tools` 数组的条目。
 *
 * 这一路是给「兼容 OpenAI 协议、但有自己内置工具类型」的第三方平台用的（如 deepseek 的
 * `deepseek_web_search`）。它们既不是本地的 function 工具，也不是 OpenAI 的官方内置工具，
 * AI SDK 里**没有任何通道**能把它们送出去（见 {@link createExtraToolsFetch}）。
 *
 * 写法（键 = 条目的 `type`，值 = 该条目的其余字段）：
 *   - `{ "deepseek_web_search": true }` → `{ "type": "deepseek_web_search" }`
 *   - `{ "deepseek_web_search": { "mode": "fast" } }` → `{ "type": "deepseek_web_search", "mode": "fast" }`
 *   - 值写数组 → 注入多条同 type 条目；值写 `false` / `null` → 跳过
 *
 * @param {object|undefined} config 配置值
 * @param {string} [label='extraTools'] 报错信息里使用的配置项名
 * @returns {object[]} 请求体里的 tools 条目（已含 `type`）
 * @throws {NeonaicIllegalArgumentError} 配置类型不对、条目不是对象、与键冲突地写了别的 type
 */
function resolveExtraTools(config, label = 'extraTools') {
  if (config == null || config === false) return [];
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new NeonaicIllegalArgumentError(
      `${label} 必须是「type → 其余字段」的对象，实际是 ${Array.isArray(config) ? 'array' : typeof config}：${JSON.stringify(config)}。`,
    );
  }

  const entries = [];
  for (const [rawType, rawValue] of Object.entries(config)) {
    const type = String(rawType).trim();
    if (!type) continue;
    // 同一 type 可写成数组以注入多条；单条则退化为只有一项
    const optionList = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const rawOptions of optionList) {
      if (rawOptions === false || rawOptions === null) continue;
      const options = (rawOptions === true || rawOptions === undefined) ? {} : rawOptions;
      if (typeof options !== 'object' || Array.isArray(options)) {
        throw new NeonaicIllegalArgumentError(
          `${label}.${rawType} 的字段必须是对象、true 或它们的数组，实际是 ${JSON.stringify(rawOptions)}。`,
        );
      }
      // type 由键给出；值里再写一个不同的 type 属于自相矛盾，直接判错而不是静默覆盖
      if (options.type != null && options.type !== type) {
        throw new NeonaicIllegalArgumentError(
          `${label}.${rawType} 的字段里不能再写 type（type 由键名决定），却写成了 ${JSON.stringify(options.type)}。`,
        );
      }
      entries.push({ ...options, type });
    }
  }
  return entries;
}

/**
 * 构造一个「只往请求体 `tools` 数组里塞条目」的 fetch，交给 `createOpenAI({ fetch })`。
 *
 * 为什么必须在传输层做：`@ai-sdk/openai` 里没有透传自定义工具类型的通道 ——
 *   - Chat Completions：`prepareChatTools` 的 `switch (tool.type)` **只认 `function`**，
 *     其余类型只 push 一条 `unsupported` warning 就被丢弃；
 *   - Responses：`prepareResponsesTools` 的 `switch (tool.id)` **连 default 都没有**，
 *     未知的 provider 工具 id 被静默忽略（连 warning 都没有）。
 * 所以平台自定义的工具类型只能在请求体序列化之后补进去。
 *
 * ⚠️ 注入的工具 AI SDK 并不认识：如果平台要求**客户端**执行它（响应里返回 tool_call），
 * 会抛 `NoSuchToolError`。只适用于「服务端执行、直接把结果写进回复」这类工具。
 *
 * @param {object[]} entries 要注入的条目
 * @param {string} providerName Profile 名（日志用）
 * @returns {(url: string, init: object) => Promise<Response>}
 */
function createExtraToolsFetch(entries, providerName) {
  return async (url, init) => {
    let body = init?.body;
    if (typeof body === 'string' && body) {
      try {
        const parsed = JSON.parse(body);
        const existing = Array.isArray(parsed?.tools) ? parsed.tools : [];
        // 幂等：同 type 的条目只补一次（SDK 已经写进去的不再重复）
        const added = entries.filter((t) => !existing.some((e) => e?.type === t.type));
        if (added.length) {
          parsed.tools = [...existing, ...added];
          body = JSON.stringify(parsed);
        }
      } catch (err) {
        // 注入失败不该顺带把请求搞坏：原样发出去，问题留给服务端与日志
        getLogger().tool.warn(`${providerName}: 无法向请求体注入 extraTools（body 不是合法 JSON），已原样发送`, err);
      }
    }
    // ⚠️ 必须在这里才取 `globalThis.fetch`：自检脚本与中间件都会打桩它，
    //    在 createExtraToolsFetch 阶段提前捕获会把桩打在空气上。
    return globalThis.fetch(url, { ...init, body });
  };
}

export const neonaicAIProviderTools = {
  PROVIDER_TOOL_FACTORIES,
  resolveProviderTools,
  resolveExtraTools,
  createExtraToolsFetch,
};
