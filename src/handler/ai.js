/**
 * handler/ai.js — AI 交互模块（概念验证）
 *
 * 使用 OpenAI 兼容 API 格式，仅发送系统提示词 + 用户消息，无历史记录。
 * 系统提示词按 OAI provider 名称加载：
 *   config/prompts/${oai[x].name}.md
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

import { CONFIG_PATHS, getConfig } from '../system/conf.js';
import { getLogger } from '../system/logger.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** @type {Map<string, string>} provider 名 → 提示词 */
const _promptCache = new Map();

/**
 * @param {string} providerName
 * @returns {string}
 */
function loadSystemPrompt(providerName) {
  if (_promptCache.has(providerName)) return _promptCache.get(providerName);
  let prompt;
  try {
    prompt = readFileSync(resolve(ROOT, `config/prompts/${providerName}.md`), 'utf8').trim();
  } catch {
    prompt = '你是一个有用的 AI 助手。';
    getLogger().toolAi.warn(`未找到提示词文件: config/prompts/${providerName}.md，使用默认`);
  }
  _promptCache.set(providerName, prompt);
  return prompt;
}

/**
 * 向 AI 发送请求并获取回复。
 * @param {string} userMessage 用户输入
 * @returns {Promise<string>} AI 回复文本
 */
export async function askAI(userMessage) {
  const oaiList = getConfig(CONFIG_PATHS.secret).getList('oai');
  const provider = oaiList.find((p) => p?.available !== false);
  if (!provider) throw new Error('未找到可用的 AI API 配置');

  const systemPrompt = loadSystemPrompt(provider.name);
  const url  = `${provider.address}/v1/chat/completions`;
  const body = {
    model: provider.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
  };

  getLogger().toolAi.info(`→ 向 ${provider.name} (${provider.model}) 发送请求`);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`AI API 请求失败 (${res.status}): ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const reply = data.choices?.[0]?.message?.content ?? '';

  getLogger().toolAi.info(`← 收到回复 (${reply.length} 字符)`);
  return reply;
}
