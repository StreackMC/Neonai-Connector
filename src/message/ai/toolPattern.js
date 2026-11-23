/**
 * ai/toolPattern.js — 「模式列表」求值
 *
 * `oai[].tools` 与 `oai[].AIlist` 共用这里的 `resolvePatternList`，避免两处语义各自漂移；
 * 单模式能匹配到什么由调用方传入的 `match` 决定（`tools` 走通配，`AIlist` 精确）。
 */

import { NeonaicIllegalArgumentError } from '#src/utils/NeonaicNewableError.js';
import { neonaicAIToolRegistry } from './toolRegistry.js';

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
  for (const t of neonaicAIToolRegistry.getAITools()) {
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
  return resolvePatternList(toolsConfig, neonaicAIToolRegistry.getAITools().map((t) => `${t.namespace}:${t.name}`), {
    match: matchToolPattern,
    label: 'tools',
  });
}

export const neonaicAIToolPattern = {
  globToRegExpSource,
  matchToolPattern,
  exactMatch,
  resolvePatternList,
  resolveToolList,
};
