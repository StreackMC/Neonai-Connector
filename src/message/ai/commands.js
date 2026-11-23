/**
 * ai/commands.js — `ai` 命令及其子命令
 *
 * 命令在 import 时自注册（与项目其余命令一致），由 `index.js` 导入以触发。
 */

import JSON5 from 'json5';
import z from 'zod';

import { neonaicCommandInterface } from '#src/command/commandInterface.js';
import { neonaicCommandServer } from '#src/command/commandServer.js';
import { neonaicPermissionServer } from '#src/command/permissionServer.js';
import { neonaicUserDirectory } from '#src/message/userDirectory.js';
import { neonaicConfManager } from '#src/system/confManager.js';
import { neonaicChore, parseString } from '#src/utils/chore.js';
import { neonaicAIAsk } from './ask.js';
import { neonaicAICallProvider } from './callProvider.js';
import { neonaicAICaller } from './caller.js';
import { neonaicAIToolPattern } from './toolPattern.js';
import { neonaicAIToolRegistry } from './toolRegistry.js';

// ---- 命令辅助 ----

/**
 * 查找工具定义。
 * @param {string} ref 工具引用：fqn（ns:name），支持 `*` 通配符（如 `ns:*`）；省略命名空间时按名跨命名空间匹配
 * @returns {import('./toolRegistry.js').NeonaicTAIToolDef[]}
 */
function findTool(ref) {
  if (!ref) return null;
  const fqn = neonaicAIToolPattern.matchToolPattern(ref);
  return fqn.map((name) => neonaicAIToolRegistry.getAIToolByFqn(name));
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
      const tools = neonaicAIToolRegistry.getAITools();
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
        return await neonaicAIAsk.askAI(msg, { AIlist: ['*'], context: ctx, preprocessWilling: false });
      }

      // 非全量测试
      const target = findProvider(profileName);
      if (!target) return `未找到 AI Profile: ${profileName}`;
      try {
        const overrideAITool = [];
        const speakerText = neonaicAICaller.resolveSpeaker(undefined, ctx.executor);
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
        return await neonaicAICallProvider.callProvider(target, msg, overrideAITool, null, neonaicAICaller.toCommandContext(ctx));
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
    neonaicPermissionServer.setTempPermission(user, neonaicAICaller.AI_BAN_PERMISSION, false, until);
    return `已临时封禁 ${user} 使用 AI 功能，持续 ${time}，过期 ${neonaicChore.parseCnDatetime(new Date(until))}`;
  }

  neonaicPermissionServer.setPermission(user, neonaicAICaller.AI_BAN_PERMISSION, false);
  return `已封禁 ${user} 使用 AI 功能`;
}

/**
 * ai pardon 子命令：解封用户。
 * @param {import('#src/command/commandServer.js').NeonaicCommandContext} ctx
 * @param {string} user
 */
function aiPardon(ctx, user) {
  if (!user) return '用法: ai pardon <user>';
  neonaicPermissionServer.clearPermission(user, neonaicAICaller.AI_BAN_PERMISSION);
  return `已解封 ${user}`;
}

export const neonaicAICommands = {
  findTool,
  findProvider,
};
