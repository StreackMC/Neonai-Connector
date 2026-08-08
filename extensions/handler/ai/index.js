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

import { CONFIG_PATHS, getConfig } from '../../../src/system/conf.js';
import { getLogger, parseString } from '../../../src/system/logger/logger.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

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
    getLogger().toolAi.debug(`未找到提示词文件: config/prompts/${providerName}.md，使用默认`);
  }
  _promptCache.set(providerName, prompt);
  return prompt;
}

/**
 * 向 AI 发送请求并获取回复。
 * @param {string} userMessage 用户输入
 * @param {string|stirng[]} AIlist 可以使用的AI Profile
 * @returns {Promise<string>} AI 回复文本
 */
export async function askAI(userMessage, AIlist) {
  // 处理 AI 列表
  if (!(AIlist instanceof Array)) AIlist = [AIlist];
  AIlist = AIlist.map((value, index, array) => (typeof value === 'string') ? value.trim() : parseString(value, false).trim());

  // 导入配置
  /** 当前是否允许全部使用 */
  const isAllAcceptable = AIlist.includes('*');
  const oaiList = getConfig(CONFIG_PATHS.secret).getList('oai').filter((v) => {
    if (v?.available === false) return false;// 禁用的直接跳过
    if (isAllAcceptable) return true;// 含有通配符全部允许
    return AIlist.includes(v?.name);// 查找是否允许调用
  });
  if (oaiList.length == 0) throw new Error('未找到可用的 AI Profile 配置');

  // 开始请求
  let request_result = new Map();
  for (let i = 0; i < oaiList.length; i++) {
    const provider = oaiList[i];
    // 请求配置
    const systemPrompt = loadSystemPrompt(provider.name);
    const url = provider.address;
    if (!url) {
      getLogger().toolAi.debug(`×→`, provider.name, ` 没有提供有效的 API 地址:`, provider.address);
      request_result.set(provider.name, `没有提供有效的 API 地址`);
      continue;
    }
    const body = {
      model: provider.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.25,
      top_p: 0.9,
    };
    // const body = {
    //   model: provider.model,
    //   input: systemPrompt + userMessage,
    //   temperature: 0.25,
    //   top_p: 0.9,
    //   tools: [{ type: "web_search" }]
    // };

    getLogger().toolAi.debug(`→`, provider.name, ` 向 ${provider.address}#${provider.model} 发送请求`);

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
      getLogger().toolAi.debug(`←×`, provider.name, ` 请求API失败 (${res.status}):`, errText);
      request_result.set(provider.name, `请求API失败 (${res.status}): ${errText}`);
      continue;
    }

    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content ?? '';

    getLogger().toolAi.debug(`←`, provider.name, ` 收到回复 (${reply.length} 字符)`);
    return reply;
  }

  // 请求失败了
  let joint_result = "对以下 AI_Profile 的尝试都失败了:{";
  request_result.forEach((value, key) => {
    joint_result += `${key}:"${value.replace(/\n/g,'\\n')}",`;
  })
  joint_result += `}`;
  throw new Error(joint_result);
}