/**
 * aiRoute.js — 按上下文为 qqbot 选择 AI Profile
 *
 * 设计约束（这决定了本模块为什么只有这么点代码）：
 *   内核的 `neonaicAI.askAI(msg, { AIlist })` **本来就是一个「允许用哪些 AI Profile」的参数**，
 *   并且已经内置两层「可用性」处理：
 *     1. `available === false` 的 Profile 直接跳过；
 *     2. 列表内逐个尝试，某个请求失败就自动换下一个。
 *   所以「按上下文选可用的 Profile」不需要任何内核改动 —— 只要在这里把 `AIlist` 算出来。
 *
 * 与平台白名单的关系：
 *   `use: "*"` 的含义是**沿用平台的 `allowedAI`**，而不是「全部 Profile」。
 *   路由因此永远无法越过 `allowedAI` 这道白名单，最坏情况只是把范围收窄。
 *   `use` 里也可以写排除项 `"!x"`（如 `["*", "!dev"]`），语义与 `tools` / `AIlist` 一致、
 *   由 `askAI` 统一求值；**只写排除项不写纳入项会被判为配置错误**。
 *
 * ⚠️ 已知限制（不是 bug，是内核语义）：
 *   `AIlist` 只做过滤、**不决定尝试顺序** —— `askAI` 里是 `getList('oai').filter(...)`，
 *   filter 保持源数组顺序，因此实际尝试顺序恒等于 `secret.json.oai` 的**声明顺序**。
 *   也就是说：`use: ["dev"]` 能表达「只用 dev」，但 `use: ["dev","deepseek"]`
 *   **不能**表达「dev 优先、失败退到 deepseek」。
 *   本模块仍按规则里的书写顺序返回列表（为内核将来支持按 AIlist 排序留出前向兼容），
 *   但在当前内核下该顺序对结果无影响。
 */

import { neonaicPermissionServer } from '../../../src/command/permissionServer.js';
import { getLogger } from '../../../src/logger/Logger.js';
import { parseString } from '../../../src/utils/chore.js';

/** 规则里代表「沿用平台白名单」的写法 */
const INHERIT = '*';

/** 排除项前缀；含义与 `tools` / `AIlist` 一致：排除优先于纳入 */
const NEGATE = '!';

/** 文本正则的默认 flags */
const DEFAULT_REGEX_FLAGS = 'i';

/**
 * 路由上下文。
 * @typedef {object} RouteContext
 * @property {string} scene 场景：`'private'` 或 `'group'`
 * @property {string} profile 平台 Profile 名（如 `'qb'`）
 * @property {string} user 用户标识（如 `'USR#123'`）
 * @property {string} group 群标识（如 `'GRP#456'`）；私聊为空串
 * @property {string[]} executor 执行者链，权限判定用（群聊为 `[USR#, GRP#]`）
 * @property {string} text 用于正则匹配的文本（已转成 markdown 的消息）
 */

/**
 * 按上下文挑出可用的 AI Profile 列表。
 *
 * 规则自上而下匹配，**首条命中即用**；无命中或未配置路由时返回 `fallback`。
 *
 * @param {Array<{when?: object, use?: string|string[]}>|undefined} routing 平台 Profile 的 `aiRouting`
 * @param {string|string[]} fallback 平台白名单（`allowedAI`）
 * @param {RouteContext} ctx 上下文
 * @returns {string[]} 供 `resolveReply` 的 `AIlist` 使用
 */
export function pickAIList(routing, fallback, ctx) {
  const base = normalizeList(fallback);
  const rules = Array.isArray(routing) ? routing : [];

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (!rule || typeof rule !== 'object') continue;
    if (!matchesRule(rule.when, ctx)) continue;

    const list = expandUse(rule.use, base);
    getLogger().platP.debug(
      `[qqbot] AI 路由命中第 ${i + 1} 条规则`,
      { when: rule.when, use: list },
      `（平台 ${ctx.profile}，场景 ${ctx.scene}）`,
    );
    return list.length ? list : base;
  }

  return base;
}

/**
 * 判断单条规则的 `when` 是否匹配上下文。
 *
 * 各字段之间为 **AND**；字段内的数组为 **OR**（`permission` 例外，见下）。
 * @apiNote 未出现的字段视为不约束（即匹配）。
 * @param {object|undefined} when 规则条件
 * @param {RouteContext} ctx 上下文
 * @returns {boolean}
 */
function matchesRule(when, ctx) {
  if (!when || typeof when !== 'object') return true;

  // 场景 / 群 / 用户：字段内 OR
  if (!inList(when.scene, ctx.scene)) return false;
  if (!inList(when.group, ctx.group)) return false;
  if (!inList(when.user, ctx.user)) return false;

  // 权限：字段内 AND（列出的每个权限都必须具备），用整条执行者链判定，使群级授权同样生效
  if (when.permission !== undefined && when.permission !== null) {
    for (const perm of normalizeList(when.permission)) {
      if (!neonaicPermissionServer.checkPermission(ctx.executor, perm)) return false;
    }
  }

  // 文本正则
  if (when.match !== undefined && when.match !== null) {
    let pattern;
    try {
      pattern = new RegExp(
        parseString(when.match),
        when.flags ? parseString(when.flags) : DEFAULT_REGEX_FLAGS,
      );
    } catch (e) {
      // 正则写错只让该条规则失效，不能带崩整条消息链路
      getLogger().platP.warn(`[qqbot] AI 路由规则的正则非法，已跳过该条：${parseString(when.match)}`, e);
      return false;
    }
    if (!pattern.test(ctx.text ?? '')) return false;
  }

  return true;
}

/**
 * 展开规则的 `use`：`"*"` 替换为平台白名单，`"!x"` 原样透传，其余按名保留并去重。
 *
 * `"!x"` 是**指令**而不是名字，因此不在这里求值 —— 交给 `askAI` 统一处理，
 * 保证全项目只有一份「`!` 排除」实现（`ai.js` 的 `resolvePatternList`，`tools` 与 `AIlist` 共用）。
 * 只写排除项（如 `use: ["!dev"]`）会被 `askAI` 判为配置错误，提示作者补上纳入项。
 *
 * @param {string|string[]|undefined} use
 * @param {string[]} base 平台白名单
 * @returns {string[]}
 */
function expandUse(use, base) {
  if (use === INHERIT) return [...base];

  const names = normalizeList(use);
  if (!names.length) return [...base];

  const out = [];
  for (const name of names) {
    if (name.startsWith(NEGATE)) {
      if (!out.includes(name)) out.push(name);
      continue;
    }
    if (name === INHERIT) {
      for (const b of base) if (!out.includes(b)) out.push(b);
      continue;
    }
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * 字段内的 OR 判定。字段缺省（undefined/null）视为不约束。
 * @param {*} value 规则字段值
 * @param {string} target 上下文中对应值
 * @returns {boolean}
 */
function inList(value, target) {
  if (value === undefined || value === null) return true;
  return normalizeList(value).includes(target);
}

/**
 * 归一化为去空白的字符串数组。
 * @apiNote 逐个元素调用 `parseString`（字符串入参原样返回）；
 *          不可把整个数组交给 `parseString`，那样默认会截断到前 3 项。
 * @param {*} value
 * @returns {string[]}
 */
function normalizeList(value) {
  const arr = Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value]);
  return arr.map((v) => parseString(v).trim()).filter(Boolean);
}

export const qqbotAIRoute = Object.freeze({
  INHERIT,
  NEGATE,
  pickAIList,
});
