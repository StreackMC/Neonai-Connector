/**
 * ai/callProvider.js — 单个 AI Profile 的一次调用
 *
 * 负责把「本地工具 / Provider 托管工具 / 注入工具」拼成一张 SDK 工具表，
 * 然后按 Profile 的 responseAPI / stream 选择端点与生成方式。
 */

import { createOpenAI } from '@ai-sdk/openai';
import { generateText, stepCountIs, streamText, tool } from 'ai';
import z from 'zod';

import { NeonaicCommandContext } from '#src/command/commandServer.js';
import { getLogger } from '#src/logger/Logger.js';
import { neonaicConfManager } from '#src/system/confManager.js';
import { parseString } from '#src/utils/chore.js';
import { NeonaicNewable } from '#src/utils/NeonaicNewableClass.js';
import { NeonaicIllegalArgumentError } from '#src/utils/NeonaicNewableError.js';
import { neonaicAIMultimodal } from './multimodal.js';
import { neonaicAIPrompt } from './prompt.js';
import { neonaicAIProviderTools } from './providerTools.js';
import { neonaicAIToolPattern } from './toolPattern.js';
import { neonaicAIToolRegistry } from './toolRegistry.js';

// ---- 调用 ----

/**
 * 将工具定义转换为 Vercel AI 的 tools 对象。
 *
 * `execute` 在这里**按调用包装**：把本轮的命令上下文与用户文本作为 `options.neonaic` /
 * `options.userInput` 交给工具。这样全局注册的拓展工具（定义在注册时就固定了）也能拿到本轮上下文，
 * 不需要依赖 SDK 的 `contextSchema` / `toolsContext` —— 那条路会按 schema 重建对象，
 * 类实例会被剥成普通对象，getter 与方法全部丢失。
 *
 * @param {(import('./toolRegistry.js').NeonaicTAIToolDef|null|undefined)[]} toolList 工具定义列表
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

/**
 * 调用单个 AI Profile 获取回复。
 * @param {object} provider oai 配置项
 * @param {string|Array<object>} userMessage 纯文本，或 AI SDK 消息内容片段数组
 * @param {(import('./toolRegistry.js').NeonaicTAIToolDef|null|undefined)[]} [overrideAITool] 要叠加的 AI 工具，将临时覆写已有 AI 工具
 * @param {String|null} overridePrompt 要覆写提示词吗
 * @param {NeonaicCommandContext} ctx 
 * @returns {Promise<string>}
 * @internalApi
 */
async function callProvider(provider, userMessage, overrideAITool = [], overridePrompt = null, ctx = new NeonaicCommandContext()) {
  const systemPrompt = (typeof overridePrompt === 'string' && overridePrompt)
    ? overridePrompt
    : neonaicAIPrompt.loadSystemPrompt(provider.prompt);
  const SESSION_ID = `#${NeonaicNewable.getUniqueId()}`;

  // 请求体注入项（第三方平台的自定义工具类型）要在建 client 之前解析好：它决定要不要装 fetch 中间件
  const injectedTools = neonaicAIProviderTools.resolveExtraTools(provider.extraTools);

  // address 是 base URL，端点（/chat/completions、/responses）由 SDK 追加。
  const client = createOpenAI({
    apiKey: provider.token,
    name: provider.name,
    baseURL: provider.address,
    // 只有配了注入项才装中间件，其余 Profile 走的还是原生 fetch（不改变既有行为）
    ...(injectedTools.length ? { fetch: neonaicAIProviderTools.createExtraToolsFetch(injectedTools, provider.name) } : {}),
  });

  // responseAPI 仅决定请求体格式（responses API vs chat completions），端点由 SDK 按 base URL 拼接
  const model = provider.responseAPI
    ? client.responses(provider.model)
    : client.chat(provider.model);

  /** 本 Profile 声明的多模态能力，下文多处复用 */
  const caps = neonaicAIMultimodal.resolveMultimodal(provider);

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
  const toolList = neonaicAIToolPattern.resolveToolList(provider.tools).map((v) => {
    const t = neonaicAIToolRegistry.getAIToolByFqn(v);
    return t ? t : null;
  });

  // Provider 托管工具（由 Provider 服务端执行，与 provider.tools 的本地工具相互独立）。
  // ⚠️ 只有 Responses API 会把这些工具写进请求体：Chat Completions 的 tools 只接受 function，
  // `prepareChatTools` 遇到 provider 类型只会 push 一条 unsupported warning 然后**静默丢弃**。
  // 这种「配置看起来生效了、其实一个都没送出去」的故障最难查，所以这里直接判死。
  const providerToolSet = neonaicAIProviderTools.resolveProviderTools(provider.providerTools, client.tools);
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
  /** 临时工具（overrideAITool）过滤后的列表 */
  const overrideTools = Array.isArray(overrideAITool) ? overrideAITool.filter(Boolean) : [];
  // 临时工具排在后面：同名时后写入的覆盖前者，即临时工具优先
  const tools = {
    ...providerToolSet,
    ...buildToolSet([...toolList, ...overrideTools], ctx, userInput),
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
  const extraCount = overrideTools.length;
  const providerCount = providerToolNames.length;
  const injectedCount = injectedTools.length;
  const mediaCount = Array.isArray(userMessage) ? userMessage.filter((p) => p?.type === 'file').length : 0;
  getLogger().tool.info(
    `${SESSION_ID} → ${provider.name}: ${provider.address}#${provider.model} (${endpoint}${provider.stream ? ', stream' : ''}, ${toolNames.length} tools${providerCount ? ` 含 provider ${providerCount}` : ''}${extraCount ? ` 含临时 ${extraCount}` : ''}${injectedCount ? ` + 注入 ${injectedCount}` : ''}, maxToolcall=${maxToolcall}${mediaCount ? `, ${mediaCount} media` : ''})`,
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

export const neonaicAICallProvider = {
  buildToolSet,
  plainTextOf,
  callProvider,
};
