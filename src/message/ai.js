/**
 * ai.js — 兼容入口
 *
 * 实现已拆分到 `./ai/` 目录（每个子模块导出各自的命名空间对象，见 `ai/index.js`）。
 * 保留本文件只是为了让既有的 `#src/message/ai.js` 引用（内核与各拓展）不必改动。
 */

export { neonaicAI } from './ai/index.js';
