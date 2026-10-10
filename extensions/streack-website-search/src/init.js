import z from 'zod';

import { neonaicCommandServer } from '../../../src/command/commandServer.js';
import { neonaicAI } from '../../../src/message/ai.js';
import { getLogger } from '../../../src/logger/Logger.js';
import { parseString } from '../../../src/utils/chore.js';
import { getSearchSource, searchThat, WEBSITE_ROOT } from './search.js';

/** 单次最多列出的结果条数，避免刷屏 */
const MAX_LISTED = 10;

/**
 * 宽容地把任意值转成去空白的文本（undefined / null 视为空串）。
 * @param {*} value
 * @returns {string}
 */
function text(value) {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  return parseString(value).trim();
}

/**
 * 把搜索源里的站内相对路径补全为完整 URL。
 * @param {*} link
 * @returns {string}
 */
function toAbsoluteUrl(link) {
  const raw = text(link);
  if (!raw) return WEBSITE_ROOT;
  if (/^https?:\/\//i.test(raw)) return raw;
  try {
    return new URL(raw, `${WEBSITE_ROOT}/`).href;
  } catch {
    return `${WEBSITE_ROOT}/${raw.replace(/^\/+/, '')}`;
  }
}

/**
 * 执行一次关键词搜索，并把引擎返回结果渲染为可读文本。
 * @param {string} keyword
 * @param {number} [maxlisted=MAX_LISTED] 最大列出条数
 * @returns {Promise<string>}
 */
async function runSearch(keyword, maxlisted = MAX_LISTED) {
  if (!(await getSearchSource())) {
    return '搜索数据获取失败（网络异常或站点不可用），请稍后再试。';
  }

  const items = await searchThat(keyword);
  if (items.length === 0) return `未找到与“${keyword}”相关的页面。`;

  const listed = items.slice(0, maxlisted);
  const lines = [
    items.length > listed.length
      ? `共 ${items.length} 条结果，仅列出前 ${listed.length} 条：`
      : `共 ${items.length} 条结果：`,
  ];

  listed.forEach((item, index) => {
    lines.push(`${index + 1}. ${text(item?.title) || '(无标题)'}`);
    lines.push(`   链接：${toAbsoluteUrl(item?.link)}`);
    const summary = text(item?.summary);
    if (summary) lines.push(`   摘要：${summary}`);
  });

  return lines.join('\n');
}

/**
 * 扩展入口：注册 /streack <keyword> 命令与同名 AI 工具。
 * @param {{ manifest: object, pwd: string, ext_item_id: number, ext_item_timestamp: number }} [ctx] 拓展上下文
 */
export function onEnable(ctx) {
  const conflicts = neonaicCommandServer.registerCommand('streackwebsitesearch', 'streack', async function (...args) {
    const keyword = args.map((arg) => text(arg)).join(' ').trim();
    if (!keyword) return '用法: /streack <keyword>';
    return await runSearch(keyword, MAX_LISTED);
  }, {
    description: '搜索 Streack 网站内容',
    usage: 'streack <keyword>',
    alias: ['streacksearch'],
    permissions: ['streackwebsitesearch.command.streack'],
    permissionDefault: true,
  });
  if (conflicts) {
    getLogger().ext.warn(`[streack-website-search] 命令“streack”注册失败，与已有命令冲突：`, conflicts);
  }

  const registered = neonaicAI.registerAITool('streackwebsitesearch', 'search', {
    description: '根据关键词搜索 Streack 网站，返回匹配页面的标题、链接与摘要',
    inputSchema: z.object({
      keyword: z.string().describe('搜索关键词'),
    }),
    outputSchema: z.string().describe('搜索结果'),
    execute: async ({ keyword }) => runSearch(text(keyword, Number.MAX_SAFE_INTEGER)),
  });
  if (!registered) {
    getLogger().ext.warn(`[streack-website-search] AI 工具“streack:search”注册失败，已存在同名工具`);
  }
}

export function onDisable() { }