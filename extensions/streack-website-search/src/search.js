import JSON5 from 'json5';
import { getLogger } from '../../../src/logger/Logger.js';
import { NeonaicNetworkError } from '../../../src/utils/NeonaicNewableError.js';
import { neonaicNetwork } from '../../../src/utils/io.js';

/** Streack 站点根地址（不含结尾斜杠） */
export const WEBSITE_ROOT = "https://streack.top";
const SEARCH_SOURCE_URL = `${WEBSITE_ROOT}/assets/search-suggestion.json`;
const SEARCH_SOURCE_UPDATE_INTERVAL = 1000 * 60 * 60 * 1; // 1小时
const SEARCH_SOURCE_RETRY_INTERVAL = 1000 * 60 * 1; // 拉取失败后 1 分钟内不重复请求

/**
 * @typedef {Object} SearchSourceItem
 * @property {string} link 相对网站根路径的目标页面路径
 * @property {string[]} keywords 页面的关键词
 * @property {string} title 页面的标题
 * @property {string} summary 页面的摘要
 */

/**
 * @typedef {Object} MatchedSearchSourceItem
 * @property {SearchSourceItem} item 匹配到的搜索源项
 * @property {number} score 匹配得分，0~100，得分越高表示匹配度越高
 */

/** @type {SearchSourceItem[]|null} */
let searchSource = null;
let searchSourceTimestamp = 0;
/** 上次拉取是否失败（用于失败缓存，避免连续重试打爆对方站点） */
let searchSourceFailed = false;

/**
 * 惰性 + 缓存地获取搜索数据库。
 * @apiNote 拉取失败时保留上一次可用数据（stale-while-error）；
 *          若从未成功过则返回 null，并在 {@link SEARCH_SOURCE_RETRY_INTERVAL} 内不再重试。
 * @returns {Promise<SearchSourceItem[]|null>}
 */
export async function getSearchSource() {
  const age = Date.now() - searchSourceTimestamp;

  // 缓存仍新鲜
  if (searchSource && age <= SEARCH_SOURCE_UPDATE_INTERVAL) return searchSource;
  // 刚刚失败过：短时间内不重复请求
  if (searchSourceFailed && age <= SEARCH_SOURCE_RETRY_INTERVAL) return searchSource;

  try {
    const rsp = await neonaicNetwork.fetch(SEARCH_SOURCE_URL, 10000);
    if (!rsp.ok) throw new NeonaicNetworkError(`远程返回了HTTP-${rsp.status}:${rsp.statusText}`, rsp);
    const parsed = JSON5.parse(await rsp.text());
    if (!Array.isArray(parsed)) throw new NeonaicNetworkError(`远程返回的搜索数据库格式不正确（期望数组）`, rsp);
    searchSource = parsed;
    searchSourceFailed = false;
    searchSourceTimestamp = Date.now();
  } catch (error) {
    // 保留旧数据，仅记录失败状态，避免旧缓存被无谓清空
    searchSourceFailed = true;
    searchSourceTimestamp = Date.now();
    getLogger().ext.error(`[streack-website-search] 获取搜索数据库失败：`, error);
  }
  return searchSource;
}

/**
 * 根据输入查询对建议数据进行匹配和排序
 * 匹配优先级：关键词完全匹配(100) > 关键词前缀匹配(50) > 关键词包含(20) > 摘要包含(14) > 标题包含(10) > 链接包含(8)
 * @param {string} query - 用户输入的查询文本
 * @impleNote 内部使用每 16ms 避让，降低计算密集型任务压力
 * @returns {Promise<SearchSourceItem[]>} 按相关度降序排列的匹配项（传入空查询时返回全量副本）
 */
export async function searchThat(query = '') {
  const source = await getSearchSource();
  if (!Array.isArray(source) || source.length === 0) return [];

  if (!query) return source.slice();

  const q = query.toLowerCase();
  const scored = [];

  let lastYield = Date.now();

  for (let i = 0; i < source.length; i++) {
    const item = source[i];
    let score = 0;

    const keywords = Array.isArray(item?.keywords) ? item.keywords : [];
    for (const raw of keywords) {
      if (typeof raw !== 'string') continue;
      const kwLower = raw.toLowerCase();
      if (kwLower === q) {
        score += 100;
      } else if (kwLower.startsWith(q)) {
        score += 50;
      } else if (kwLower.includes(q)) {
        score += 20;
      }
    }

    if (String(item?.summary ?? '').toLowerCase().includes(q)) score += 14;
    if (String(item?.title ?? '').toLowerCase().includes(q)) score += 10;
    if (String(item?.link ?? '').toLowerCase().includes(q)) score += 8;

    if (score > 0) scored.push({ item, score });

    // 每 16ms 让出一次
    if (Date.now() - lastYield >= 16) {
      await new Promise((resolve) => setImmediate(resolve));
      lastYield = Date.now();
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}