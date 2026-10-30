/**
 * @module extensions/qqbot/src/msgPayloadConvertor.js
 * @description 负责在 {@link NeonaicTValidMessage} 和 {@link qqBotBackend.Sendable} 两者间相互转换。
 */

import { NeonaicAtMsgFrag, NeonaicAudioMsgFrag, NeonaicEmojiMsgFrag, NeonaicImageMsgFrag, NeonaicLinkMsgFrag, NeonaicMessage, NeonaicTextMsgFrag, NeonaicVideoMsgFrag } from '#src/message/messageFragment.js';
import qqBotBackend, { segment as qbSegment } from 'qq-official-bot';
import { PlatformQQBot } from './entry.js';
import { fromQQElement } from './emoji.js';
import { NeonaicIllegalArgumentError, NeonaicIllegalStateError } from '#src/utils/NeonaicNewableError.js';
import { neonaicFileSystem } from '#src/utils/io.js';
import { parseString } from '#src/utils/chore.js';

/**
 * @param {qqBotBackend.PrivateMessageEvent|qqBotBackend.GroupMessageEvent} event 原始信息
 * @param {PlatformQQBot} pp 
 * @param {boolean} [textOnly=false] 开启后将只处理可用文本表达的消息片段，其余部分自动忽略，这将替换图片视频等内容为无意义占位符而非链接、Base64 等带内容的 Payload
 * @returns {NeonaicMessage}
 */
export function convert_qqBotMsg_to_NeonaicMsg(event, pp, textOnly = false) {
  // 平台正常情况下只会给数组；但异常/残缺的 payload 不该让整条消息炸掉
  const raw = Array.isArray(event?.message) ? event.message : [];
  let result = new NeonaicMessage();
  raw.forEach((piece) => {
    try {
      const msgMeta = piece?.data || {};
      switch (parseString(piece?.type).trim().toLowerCase()) {
        case 'text':// 纯文本
          result.appendFragment(new NeonaicTextMsgFrag(msgMeta?.text ?? ''));
          break;
        case 'face':// 表情1
          result.appendFragment(new NeonaicEmojiMsgFrag(`:${fromQQElement(msgMeta, 'face')?.text ?? 'Unknown Emoji'}:`));
          break;
        case 'emoji':// 表情2
          result.appendFragment(new NeonaicEmojiMsgFrag(`:${fromQQElement(msgMeta, 'emoji')?.text ?? 'Unknown Emoji'}:`));
          break;
        case 'image':// 图片
          result.appendFragment(new NeonaicImageMsgFrag(msgMeta?.url ?? 'about:unknown', msgMeta?.name ?? 'Untitled Image'));
          break;
        case 'audio':// 音频
          result.appendFragment(new NeonaicAudioMsgFrag(textOnly ? 'about:nosource' : msgMeta?.url ?? 'about:unknown', msgMeta?.name ?? 'Untitled Audio'));
          break;
        case 'video':// 视频
          result.appendFragment(new NeonaicVideoMsgFrag(textOnly ? 'about:nosource' : msgMeta?.url ?? 'about:unknown', msgMeta?.name ?? 'Untitled Video'));
          break;
        case 'link':// 链接
          result.appendFragment(new NeonaicLinkMsgFrag(msgMeta?.url ?? 'about:unknown', msgMeta?.text ?? msgMeta?.url ?? 'Untitled Link', msgMeta?.description ?? 'A link'));
          break;
        case 'markdown':
          // QQ 的 markdown 元素只有一个 content 字段，已经是 Markdown 文本。
          // 这里不做结构还原（那需要一个完整的 Markdown 解析器），直接原样当文本承载，
          // 以便 `toMarkdown()` 能逐字回放，而不是落到 default 被当成未知类型丢掉。
          result.appendFragment(new NeonaicTextMsgFrag(msgMeta?.content ?? ''));
          break;

        default:
          //TODO: 还有其他富文本消息类型没有转换
          pp.log('warn', "无法将消息片段", piece, "转换为 Markdown，未知的消息类型：", piece.type);
          break;
      }
    } catch (error) {
      pp.log('warn', "无法将消息片段", piece, "转换为 Markdown，无法获取消息内容：", error);
    }
  });

  /** @type {import('qq-official-bot').MentionedGroupMember[]} */
  const mentioned = Array.isArray(event.mentions) ? event.mentions : [];
  for (const user of mentioned) {
    result.appendFragment(new NeonaicAtMsgFrag(`qUSR#${user.id}@${pp.selfInfo.id}`));
  }
  return result;
}

/**
 * @param {import('#src/message/messageFragment.js').NeonaicTValidMessage} msg 原始信息
 * @param {boolean} [allowTempSave=false] 是否允许保存临时的 base64 字符串以便音频和视频的上传。如果不保存将指向空地址。
 * @returns {qqBotBackend.Sendable}
 * @throws {NeonaicIllegalArgumentError} 消息的类型不合法
 * @throws {NeonaicIllegalStateError} 消息的参数不合法
 */
export function convert_NeonaicMsg_to_qqBotMsg(msg, allowTempSave = false) {
  const nmsg = new NeonaicMessage(msg);
  return nmsg.mapFrag((frag, index, type) => {
    switch (type) {
      case 'text':
        // qq-official-bot #132 ，混用出现未定义行为，必须使用 Markdown
        return qbSegment.markdown(frag.markdown);
      case 'br':
        // qq-official-bot #132 ，混用出现未定义行为，必须使用 Markdown
        // 用片段自身的输出（一个空行）：br 的语义是强制分段，QQ 侧也应是段落间距而非单次换行
        return qbSegment.markdown(frag.markdown);
      case 'at': {
        const target = frag.target.replace(/@.*$/, '');
        if (target.startsWith('qGRP#')) throw new NeonaicIllegalStateError(`无法@一个群聊`);
        // return qbSegment.at(target.replace(/^qUSR#/, ''));
        // qq-official-bot #131 ，@单个成员有bug，需要强转 markdown 消息。
        return qbSegment.markdown(`<qqbot-at-user id="${target.replace(/^qUSR#/, '')}" />`);
      }
      case 'emoji':// TODO: 以后再写，现在先穿透到 table 并回退 Markdown
      // 以下片段 QQ 官方消息没有对应元素，统一用 Markdown 承载。
      case 'table':
      case 'link'/* QQ 的 link 消息语义不同 */:
      case 'code':
      case 'inline-code':
      case 'heading':
      case 'blockquote':
      case 'ordered-list':
      case 'unordered-list':
      case 'checkbox':
      case 'divider':
        return qbSegment.markdown(frag.markdown);
      case 'image':
        return frag.image.isBase64
          ? qbSegment.image(Buffer.from(frag.image.payload.replace(/^data:.*;base64,/, ''), 'base64'), {
            name: frag.title + "\n" + frag.alt,
          })
          : qbSegment.image(frag.image.payload, {
            name: frag.title + "\n" + frag.alt,
          });
      case 'audio':
        if (frag.isBase64) {
          return (allowTempSave)
            ? qbSegment.audio(neonaicFileSystem.tempSaveAndGet(frag.src.replace(/^data:.*;base64,/, '')), {
              name: frag.title + "\n" + frag.alt,
            })
            : qbSegment.audio("https://example.com/unresolvable_audio", {
              name: frag.title + "\n" + frag.alt,
            });
        } else {
          return qbSegment.audio(frag.src, {
            name: frag.title + "\n" + frag.alt,
          });
        }
      case 'video':
        if (frag.isBase64) {
          return (allowTempSave)
            ? qbSegment.video(neonaicFileSystem.tempSaveAndGet(frag.src.replace(/^data:.*;base64,/, '')), {
              name: frag.title + "\n" + frag.alt,
            })
            : qbSegment.video("https://example.com/unresolvable_video", {
              name: frag.title + "\n" + frag.alt,
            });
        } else {
          return qbSegment.video(frag.src, {
            name: frag.title + "\n" + frag.alt,
          });
        }
      default:
        throw new NeonaicIllegalArgumentError(`未知的消息类型：${type}`);
    }
  });
}