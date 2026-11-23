/**
 * ai/prompt.js — 系统提示词加载与缓存
 *
 * 提示词文件位于 `config/prompts/<profile>.md`；按文件名缓存，进程生命周期内只读一次。
 */

import { readFileSync } from 'node:fs';

import { getLogger } from '#src/logger/Logger.js';
import { neonaicFileSystem } from '#src/utils/io.js';
import { NeonaicIllegalStateError } from '#src/utils/NeonaicNewableError.js';

// ---- 提示词加载 ----

/** 文件提示词缓存 @type {Map<string, string>} */
const _promptCache = new Map();

function loadSystemPrompt(promptFilename) {
  if (_promptCache.has(promptFilename)) return _promptCache.get(promptFilename);
  let prompt;
  try {
    const path = neonaicFileSystem.resolveStrict('config/prompts', promptFilename);
    prompt = readFileSync(path, 'utf8').trim();
  } catch (e) {
    getLogger().tool.debug(`无法加载提示词 ${promptFilename}`, e);
    throw new NeonaicIllegalStateError(`无法加载提示词：${e?.message ?? '未知原因'}`, e);
  }
  _promptCache.set(promptFilename, prompt);
  return prompt;
}

export const neonaicAIPrompt = {
  loadSystemPrompt,
};
