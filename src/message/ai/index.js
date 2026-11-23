/**
 * ai/index.js — AI 交互模块的汇总入口（Vercel AI SDK）
 *
 * 对外只暴露一个命名空间对象 `neonaicAI`，内部按职责拆开：
 *   - `prompt.js`        系统提示词加载与缓存
 *   - `toolRegistry.js`  AI 工具注册表（谁注册了什么）
 *   - `toolPattern.js`   `tools` / `AIlist` 的模式求值
 *   - `providerTools.js` 交给 Provider 的工具（providerTools / extraTools 注入）
 *   - `multimodal.js`    多模态能力判定与消息内容构建
 *   - `callProvider.js`  单个 Profile 的一次调用
 *   - `caller.js`        执行者：封禁检查、身份解析、上下文归一化
 *   - `ask.js`           主入口 `askAI`（选 Profile、优化提示词、逐个回退）
 *   - `commands.js`      `ai` 命令与子命令（import 时自注册）
 *
 * 依赖方向是单向的：commands → ask → callProvider → {prompt, toolPattern, providerTools, multimodal}；
 * `toolPattern` 只反向依赖注册表，不存在环。
 */

import { neonaicAIAsk } from './ask.js';
// ⚠️ 这个 import 有副作用：命令在模块加载时自注册，删掉它会让 `ai` 命令从命令表里消失
import { neonaicAICommands } from './commands.js';
import { neonaicAICaller } from './caller.js';
import { neonaicAIProviderTools } from './providerTools.js';
import { neonaicAIToolPattern } from './toolPattern.js';
import { neonaicAIToolRegistry } from './toolRegistry.js';

export const neonaicAI = {
  defineAITool: neonaicAIToolRegistry.defineAITool,
  registerAITool: neonaicAIToolRegistry.registerAITool,
  unregisterAITool: neonaicAIToolRegistry.unregisterAITool,
  getAITools: neonaicAIToolRegistry.getAITools,
  resolveToolList: neonaicAIToolPattern.resolveToolList,
  resolveProviderTools: neonaicAIProviderTools.resolveProviderTools,
  resolveExtraTools: neonaicAIProviderTools.resolveExtraTools,
  isAIBanned: neonaicAICaller.isAIBanned,
  askAI: neonaicAIAsk.askAI,
  findTool: neonaicAICommands.findTool,
  findProvider: neonaicAICommands.findProvider,
};
