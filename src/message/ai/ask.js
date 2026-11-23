/**
 * ai/ask.js — 对外主入口 `askAI`
 *
 * 只做编排：选 Profile（AIlist）、按需优化提示词、逐个尝试并汇总失败原因。
 * 具体一次请求怎么发在 `callProvider.js`，消息怎么构建在 `multimodal.js`。
 */

import z from 'zod';

import { getLogger } from '#src/logger/Logger.js';
import { NeonaicMessage } from '#src/message/messageFragment.js';
import { neonaicConfManager } from '#src/system/confManager.js';
import { neonaicChore, parseString } from '#src/utils/chore.js';
import { NeonaicIllegalArgumentError, NeonaicIllegalStateError, NeonaicNetworkError } from '#src/utils/NeonaicNewableError.js';
import { neonaicAICallProvider } from './callProvider.js';
import { neonaicAICaller } from './caller.js';
import { neonaicAIMultimodal } from './multimodal.js';
import { neonaicAIToolPattern } from './toolPattern.js';

/**
 * @param {string|NeonaicMessage|NeonaicMessageFragment|NeonaicMessageFragment[]|string[]} userMessage 用户传入消息或输入提示词
 * @param {object} options 选项
 * @param {string|string[]} [options.AIlist] 允许的 AI Profile 列表：`"*"` 全部、`"!name"` 排除（排除优先）
 * @param {NeonaicCommandContext|{executor?: string|string[], privateExecutor?: boolean}} [options.context] 本轮命令上下文；与 `caller` 互斥
 * @param {string|string[]|null|undefined} [options.caller] 调用者标识（执行者链），用于封禁检查与身份解析
 * @deprecated `options.caller` 已弃用，请改用 `options.context`；仅在未提供 `context` 时作为兼容垫片，`privateExecutor` 固定为 false
 * @param {string|object|null} [options.speaker] 向模型描述「当前对话者是谁」的方式，见 {@link resolveSpeaker}
 * @param {boolean} [options.preprocessWilling] 是否接受优化提示词，是否生效取决于用户配置
 * @param {import('./toolRegistry.js').NeonaicTAIToolDef[]|import('./toolRegistry.js').NeonaicTAIToolDef} [options.overrideAITool] 要叠加的 AI 工具，将临时覆写已有 AI 工具
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
  if (rawOptions.caller != null) neonaicAICaller.warnCallerDeprecatedOnce();

  // 初始化配置
  const conf = neonaicChore.joinObject({
    AIlist: ['*'],
    speaker: undefined,
    preprocessWilling: false,
    overrideAITool: [],
    overridePrompt: undefined,
  }, rawOptions);
  // context 优先；只给 caller 时用兼容垫片（privateExecutor 缺省 false）
  const ctx = neonaicAICaller.toCommandContext(rawOptions.context ?? { executor: rawOptions.caller ?? [] });
  if (neonaicAICaller.isAIBanned(ctx.executor).banned) throw new NeonaicIllegalStateError('对“智能回复”的访问被拒绝');

  // 对 AIlist 做标准化处理：字符串 → 数组，去除空值，trim
  if (!Array.isArray(conf.AIlist)) conf.AIlist = [conf.AIlist];
  conf.AIlist = conf.AIlist.map((v) => (typeof v === 'string' ? v.trim() : parseString(v, false).trim()));

  // 对覆写 tool 处理
  if (!Array.isArray(conf.overrideAITool)) conf.overrideAITool = [conf.overrideAITool];
  conf.overrideAITool = conf.overrideAITool.map((/** @type {import('./toolRegistry.js').NeonaicTAIToolDef|null} */v) => {
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
  const speakerText = neonaicAICaller.resolveSpeaker(conf.speaker, ctx.executor);
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
  const chosen = new Set(neonaicAIToolPattern.resolvePatternList(conf.AIlist, allProfileNames, {
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
      optimizedText = await askAI(neonaicAIMultimodal.renderTextOnly(message), {
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
      return await neonaicAICallProvider.callProvider(
        provider,
        neonaicAIMultimodal.buildUserContent(message, provider, optimizedText),
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

export const neonaicAIAsk = {
  askAI,
};
