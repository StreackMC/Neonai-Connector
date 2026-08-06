/**
 * handler/ai.js — AI 交互模块（概念验证）
 *
 * 使用 OpenAI 兼容 API 格式，仅发送系统提示词 + 用户消息，无历史记录。
 * API 端点与凭据从 secret.json oai[] 读取，
 * 系统提示词从文件 config/prompts/system.md 加载。
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

import { CONFIG_PATHS, getConfig } from '../system/conf.js';
import { getLogger } from '../system/logger.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** 缓存的系统提示词 */
let _systemPrompt = null;

function loadSystemPrompt() {
  if (_systemPrompt) return _systemPrompt;
  try {
    _systemPrompt = readFileSync(resolve(ROOT, 'config/prompts/system.md'), 'utf8').trim();
  } catch {
    _systemPrompt = '你是一个有用的 AI 助手。';
  }
  return _systemPrompt;
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

  const systemPrompt = loadSystemPrompt();
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
