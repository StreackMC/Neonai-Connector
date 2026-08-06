/**
 * handler/ai.js — AI 交互模块（概念验证）
 *
 * 使用 OpenAI 兼容 API 格式，仅发送系统提示词 + 用户消息，无历史记录。
 * API 端点与凭据从 secret.json 的 oai[] 读取，系统提示词从 main.json 读取。
 */

import { CONFIG_PATHS, getConfig } from '../system/conf.js';
import { getLogger } from '../system/logger.js';

/**
 * 向 AI 发送请求并获取回复。
 * @param {string} userMessage 用户输入
 * @returns {Promise<string>} AI 回复文本
 */
export async function askAI(userMessage) {
  const oaiList = getConfig(CONFIG_PATHS.secret).getList('oai');
  const provider = oaiList.find((p) => p?.available !== false);
  if (!provider) throw new Error('未找到可用的 AI API 配置');

  const systemPrompt = getConfig(CONFIG_PATHS.main).getString(
    'systemPrompt',
    '你是一个有用的 AI 助手。',
  );

  const url = `${provider.address}/v1/chat/completions`;
  const body = {
    model: provider.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
  };

  getLogger().chatIn.info(`[请求] ${userMessage}`);
  getLogger().chatOut.info(`[系统提示词] ${systemPrompt}`);
  getLogger().chatOut.info(`[请求] ${JSON.stringify(body)}`);

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

  getLogger().chatOut.info(`[回复] ${reply}`);
  return reply;
}
