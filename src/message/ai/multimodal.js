/**
 * ai/multimodal.js — 多模态能力判定与内容构建
 *
 * Profile 声明能理解哪些 MIME，消息片段按 Profile 逐个降级：
 * 支持的走 SDK `file` 片段，不支持的退回 markdown（base64 / 本地地址换成占位文本）。
 */

import { NeonaicMediaMsgFrag } from '#src/message/messageFragment.js';
import { parseString } from '#src/utils/chore.js';

// ---- 多模态 ----

/** MIME 别名（配置里常见 image/jpg、audio/mp3 这类不规范的写法） */
const MIME_ALIASES = Object.freeze({
  'image/jpg': 'image/jpeg',
  'image/x-png': 'image/png',
  'audio/mp3': 'audio/mpeg',
  'audio/wave': 'audio/wav',
  'audio/x-wav': 'audio/wav',
  'video/x-m4v': 'video/mp4',
});

/** 媒体种类的中文名，用于降级时的占位文本 */
const MEDIA_LABELS = Object.freeze({ image: '图片', audio: '音频', video: '视频' });

/**
 * 规范化 MIME：小写、去空白、折叠常见别名。
 * @param {string} mime
 * @returns {string}
 */
function normalizeMime(mime) {
  const lower = parseString(mime).trim().toLowerCase();
  return MIME_ALIASES[lower] ?? lower;
}

/**
 * 读取 Profile 声明的多模态能力。
 *
 * 同时接受正字 `multimodal` 与历史拼写 `mutimodal`（正字优先）；
 * 每种模态的值为 `true`（等价于 `["*"]`）、单个 MIME 或 MIME 数组。
 * 数组为空 / 缺省表示**不支持**该模态。
 *
 * @param {object} provider oai 配置项
 * @returns {{image: string[], audio: string[], video: string[]}} 规范化后的 MIME 列表
 */
function resolveMultimodal(provider) {
  const raw = provider?.multimodal ?? provider?.mutimodal;
  const caps = { image: [], audio: [], video: [] };
  if (!raw || typeof raw !== 'object') return caps;
  for (const kind of Object.keys(caps)) {
    const value = raw[kind];
    if (value === true) { caps[kind] = ['*']; continue; }
    if (!value) continue;
    const list = Array.isArray(value) ? value : [value];
    caps[kind] = list
      .filter((v) => typeof v === 'string' && v.trim())
      .map(normalizeMime);
  }
  return caps;
}

/**
 * Profile 是否能理解指定媒体。
 * @param {{image: string[], audio: string[], video: string[]}} caps
 * @param {'image'|'audio'|'video'} kind 媒体种类
 * @param {string|null} mime
 * @returns {boolean}
 * @apiNote MIME 未知时**放行**：由于非异步问题，远程媒体无法获取 MIME。
 */
function supportsMedia(caps, kind, mime) {
  const list = caps[kind] ?? [];
  if (!mime) return true;
  if (!list.length) return false;
  if (list.includes('*') || list.includes(kind) || list.includes(`${kind}/*`)) return true;
  return list.includes(normalizeMime(mime));
}

/**
 * 是否是可被远端模型取到的地址。
 * 只有 http(s) 算数：data: 是内联数据（只能作为 data 片段发送，不能写进 markdown），
 * blob:/file: 是本地资源，模型取不到。
 * @param {string} uri
 * @returns {boolean}
 */
function isRemoteMediaUrl(uri) {
  return /^https?:\/\//i.test(parseString(uri).trim());
}

/**
 * 把媒体片段降级成占位文本（来源不是可公开访问的 URL 时使用）。
 * @param {'image'|'audio'|'video'} kind
 * @returns {string}
 */
function mediaPlaceholder(kind) {
  return `about:block/media?type=${kind}&label=${MEDIA_LABELS[kind] ?? '媒体'}`;
}

/**
 * 把消息渲染成**纯文本** markdown：媒体保留 URL 链接，base64 / 本地地址降级为占位。
 * 用于提示词优化（优化器只吃文本）与「该 Profile 不支持该模态」的兜底。
 * @param {NeonaicMessage} message
 * @returns {string}
 */
function renderTextOnly(message) {
  let out = '';
  message.forEachFrag((frag) => {
    if (frag instanceof NeonaicMediaMsgFrag && !isRemoteMediaUrl(frag.uri)) {
      out += mediaPlaceholder(frag.TYPE);
      return;
    }
    out += frag.markdown;
  });
  return out;
}

/**
 * 把单个媒体片段转成 AI SDK 的内容片段。
 * @param {NeonaicMediaMsgFrag} frag 媒体片段
 * @param {{image: string[], audio: string[], video: string[]}} caps 多模态能力
 * @param {object} provider oai 配置项
 * @returns {{type: 'file', mediaType: string, data: {type: 'url'|'data', url?: string, data?: string}}|null} 不支持/不可上传时为 null
 * @apiNote 模态**已开启**时，URL 与 base64 都会发出去：base64 走 `data` 片段，URL 走 `url` 片段。
 *          「只允许 URL、不允许 base64」只约束**降级到 markdown** 的那条路。
 * @apiNote 传输限制（`@ai-sdk/openai`）：
 *          - Chat Completions 支持图片（URL/data）与 wav/mp3 音频（仅 data），不支持视频，
 *            音频 URL 也会被 SDK 拒绝；
 *          - Responses API 支持非图片文件的 URL（`input_file.file_url`），内联非图片文件需要
 *            `passThroughUnsupportedFiles`（`callProvider` 已按 Profile 声明打开）。
 */
function buildMediaPart(frag, caps, provider) {
  const kind = frag.TYPE;
  if (kind !== 'image' && kind !== 'audio' && kind !== 'video') return null;
  if (!supportsMedia(caps, kind, frag.mime)) return null;

  const uri = parseString(frag.uri).trim();
  if (!uri) return null;

  // 已开启的模态：base64 直接内联（只有降级 markdown 时才禁止 base64）
  if (frag.isBase64 || /^data:/i.test(uri)) {
    const comma = uri.indexOf(',');
    if (comma < 0) return null;
    const header = uri.slice(5, comma);
    // 非 base64 的 data URL（如 data:text/plain,xxx）不能作为 file data 传递
    if (!/;base64$/i.test(header)) return null;
    const mediaType = normalizeMime(header.slice(0, -';base64'.length)) || frag.mime || kind;
    // Chat 只支持图片与 wav/mp3 音频的内联；视频任何接口都不接受内联
    if (kind === 'video' && !provider?.responseAPI) return null;
    if (kind === 'audio' && !provider?.responseAPI && mediaType !== 'audio/wav' && mediaType !== 'audio/mpeg') {
      return null;
    }
    return { type: 'file', mediaType, data: { type: 'data', data: uri.slice(comma + 1) } };
  }

  if (!isRemoteMediaUrl(uri)) return null;
  // Chat Completions 传不了音频/视频的 URL
  if (!provider?.responseAPI && kind !== 'image') return null;
  return {
    type: 'file',
    mediaType: frag.mime ? normalizeMime(frag.mime) : kind,
    data: { type: 'url', url: uri },
  };
}

/**
 * 按 Profile 的多模态能力构建消息内容。
 *
 * - 支持的媒体 → AI SDK 的 `file` 内容片段；
 * - 不支持的媒体 → 降级为 markdown（URL），base64 / 本地地址换成占位文本；
 * - 全程没有媒体片段时返回字符串，保持与旧实现完全一致的请求体。
 *
 * @param {NeonaicMessage} message 消息
 * @param {object} provider oai 配置项
 * @param {string|null} [optimizedText=null] 提示词优化后的文本；给出时用它替换文本部分
 * @returns {string|Array<object>} 字符串或 AI SDK 内容片段数组
 */
function buildUserContent(message, provider, optimizedText = null) {
  const caps = resolveMultimodal(provider);
  const parts = [];
  let text = '';

  message.forEachFrag((frag) => {
    if (!(frag instanceof NeonaicMediaMsgFrag)) {
      text += frag.markdown;
      return;
    }
    const part = buildMediaPart(frag, caps, provider);
    if (part) {
      parts.push(part);
      return;
    }
    // 未开启该模态或格式不在白名单：降级为 markdown，但只允许 URL
    text += isRemoteMediaUrl(frag.uri) ? frag.markdown : mediaPlaceholder(frag.TYPE);
  });

  const finalText = optimizedText ?? text;
  if (!parts.length) return finalText;
  // 纯媒体消息没有文本时不要塞一个空 text 片段
  return finalText ? [{ type: 'text', text: finalText }, ...parts] : parts;
}

export const neonaicAIMultimodal = {
  MIME_ALIASES,
  normalizeMime,
  resolveMultimodal,
  supportsMedia,
  isRemoteMediaUrl,
  mediaPlaceholder,
  renderTextOnly,
  buildMediaPart,
  buildUserContent,
};
