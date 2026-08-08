/**
 * extensions/handler/ai — AI 交互模块
 *
 * 使用 OpenAI 兼容 API 格式，系统提示词按 provider 名加载：
 *   config/prompts/${oai[x].name}.md
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

import { CONFIG_PATHS, getConfig } from '../../../src/system/conf.js';
import { getLogger, parseString } from '../../../src/system/logger/logger.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** @type {Map<string, string>} */
const _promptCache = new Map();

function loadSystemPrompt(providerName) {
  if (_promptCache.has(providerName)) return _promptCache.get(providerName);
  let prompt;
  try {
    prompt = readFileSync(resolve(ROOT, `config/prompts/${providerName}.md`), 'utf8').trim();
  } catch {
    prompt = '你是一个有用的 AI 助手。';
    getLogger().toolAi.debug(`未找到提示词文件: config/prompts/${providerName}.md，使用默认`);
  }
  _promptCache.set(providerName, prompt);
  return prompt;
}

/**
 * @param {string} userMessage
 * @param {string|string[]} AIlist 允许的 AI Profile 列表，"*" 表示全部
 * @returns {Promise<string>}
 */
export async function askAI(userMessage, AIlist) {
  if (!Array.isArray(AIlist)) AIlist = [AIlist];
  AIlist = AIlist.map((v) => (typeof v === 'string' ? v.trim() : parseString(v, false).trim()));

  const isAll = AIlist.includes('*');
  const oaiList = getConfig(CONFIG_PATHS.secret).getList('oai').filter((v) => {
    if (v?.available === false) return false;
    if (isAll) return true;
    return AIlist.includes(v?.name);
  });
  if (!oaiList.length) throw new Error('未找到可用的 AI Profile');

  const errors = new Map();
  for (const provider of oaiList) {
    if (!provider.address) {
      getLogger().toolAi.debug(`× ${provider.name}: 无有效地址`);
      errors.set(provider.name, '无有效地址');
      continue;
    }

    const systemPrompt = loadSystemPrompt(provider.name);
    const body = {
      model: provider.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.25,
      top_p: 0.9,
    };

    getLogger().toolAi.debug(`→ ${provider.name}: ${provider.address}#${provider.model}`);

    const res = await fetch(provider.address, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.token}` },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      getLogger().toolAi.debug(`× ${provider.name}: ${res.status} ${errText}`);
      errors.set(provider.name, `${res.status}: ${errText}`);
      continue;
    }

    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content ?? '';
    getLogger().toolAi.debug(`← ${provider.name}: ${reply.length} 字符`);
    return reply;
  }

  let detail = '所有 AI Profile 请求失败: ';
  errors.forEach((v, k) => { detail += `${k}: "${String(v).replace(/\n/g, '\\n')}"; `; });
  throw new Error(detail);
}
