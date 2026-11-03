import z from 'zod';

import { neonaicAI } from '#src/message/ai.js';
import { neonaicPermissionServer } from '#src/command/permissionServer.js';
import { getLogger } from '#src/logger/Logger.js';

import { aicodeConfig } from './config.js';
import { aicodePool } from './sandboxmgr.js';

const TOOL_NAMESPACE = 'aicode';
const TOOL_NAME = 'evaljs';

/** 当前配置；`onEnable` 时读一次，改配置需重启拓展（与通道类拓展一致）。 */
let config = null;

/**
 * 拓展启用钩子。
 *
 * @this {import('#src/extension/extLoader.js').NeonaicExtItem}
 * @param {{ manifest: Object, pwd: String, ext_item_id: String, ext_item_timestamp: Number }} _extCtx
 */
export async function onEnable(_extCtx) {
  config = aicodeConfig.load();
  for (const issue of config.issues) {
    getLogger().tool.warn(`[aicode] 配置问题：${issue}`);
  }

  aicodePool.configure(config);

  const registered = neonaicAI.registerAITool(TOOL_NAMESPACE, TOOL_NAME, {
    description: '在隔离沙箱中执行一段 JavaScript（独立子进程 + QuickJS）。'
      + '用 return 返回结果，console.log 的输出会被收集到 logs。'
      + '禁止访问 fs 与 fetch，单次执行受时间/内存/栈限制；系统繁忙时返回 ok:false 且 code 为 busy。'
      + '代码按 async 函数体执行，不能使用 export。',
    inputSchema: z.object({
      code: z.string().max(config.limits.maxCodeBytes).describe('要执行的 JavaScript 代码；用 return 返回结果'),
    }),
    execute: async (input, options) => {
      const cfg = config;
      if (!cfg) {
        return JSON.stringify({ ok: false, code: 'not_ready', message: '代码执行器未启用' });
      }
      const ctx = options?.neonaic;
      if (!ctx) {
        return JSON.stringify({ ok: false, code: 'no_context', message: '缺少执行上下文，无法校验权限' });
      }

      // 刻意不用 checkPermissionFromContext：它对 internalCall 直接放行，
      // 而「能执行代码」这件事不应该因为调用来自内部就免检。
      if (cfg.permission && !neonaicPermissionServer.checkPermission(ctx.executor, cfg.permission)) {
        return JSON.stringify({
          ok: false,
          code: 'permission_denied',
          message: `缺少权限 ${cfg.permission}`,
        });
      }

      try {
        return JSON.stringify(await aicodePool.run(input.code, ctx));
      } catch (error) {
        getLogger().tool.error(`[aicode] 工具执行异常：${error?.stack ?? error}`);
        return JSON.stringify({
          ok: false,
          code: 'internal_error',
          message: String(error?.message ?? error),
        });
      }
    },
  });

  if (!registered) {
    getLogger().tool.warn('[aicode] 工具 aicode:evaljs 已存在，本次未重复注册');
  }
  getLogger().tool.info(
    `[aicode] 已启用：最多 ${config.pool.maxChildren} 个子进程，`
    + `空闲 ${config.pool.idleMinutes} 分钟回收，单任务 ${config.limits.executionTimeoutMs}ms/`
    + `${config.limits.memoryLimitMB}MB`
    + (config.permission ? `；调用需权限 ${config.permission}` : '；未启用权限校验'),
  );
}

/**
 * 拓展卸载钩子。
 *
 * 必须注销工具：只杀子进程而不摘工具，会让「已停用」的工具继续被模型调用并重新拉起进程。
 *
 * @this {import('#src/extension/extLoader.js').NeonaicExtItem}
 */
export async function onDisable() {
  neonaicAI.unregisterAITool(TOOL_NAMESPACE, TOOL_NAME);
  await aicodePool.shutdown();
  config = null;
}
