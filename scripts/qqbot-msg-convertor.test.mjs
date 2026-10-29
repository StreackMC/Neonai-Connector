#!/usr/bin/env node

/**
 * scripts/qqbot-msg-convertor.test.mjs — QQ 消息 ⇄ NeonaicMessage 转换测试
 *
 * 覆盖 `extensions/qqbot/src/msgPayloadConvertor.js` 的两个方向：
 *   - 入站 `convert_qqBotMsg_to_NeonaicMsg(event, pp, textOnly)`：QQ 事件 → NeonaicMessage
 *   - 出站 `convert_NeonaicMsg_to_qqBotMsg(msg, allowTempSave)`：NeonaicMessage → qq-official-bot 片段
 * 以及 `msgHandler.sendMsg` / `PlatformQQBot.sendMsg` 这两层发送入口（用桩 bot，不联网）。
 *
 * 用法：
 *   node scripts/qqbot-msg-convertor.test.mjs                    # 离线：只跑本地断言（默认，零网络）
 *   node scripts/qqbot-msg-convertor.test.mjs --live --listen=60 # 联网：连沙箱，只观测收到的消息 60 秒
 *   node scripts/qqbot-msg-convertor.test.mjs --live --send      # 联网：向沙箱群/用户真的发一组消息
 *   node scripts/qqbot-msg-convertor.test.mjs --sandbox --live --send   # 强制 sandbox: true
 *
 * 说明：
 *   - 所有测试用的 `qUSR#…@<botId>` / `qGRP#…@<botId>` 都来自已授权沙箱，`@` 后是机器人自身 id。
 *   - 离线模式**不会**连接 QQ、不会发任何消息；联网模式才走真实 Bot。
 *   - 退出码：0 全绿 / 1 有用例失败 / 2 脚本自身异常 / 3 模块别名非法（见下）。
 *   - 前置条件：源码里的 `#/…` 子路径导入在 Node 中是非法别名（imports 键不能以 `#/` 开头），
 *     需先把 package.json 的 `"#/*"` 改成 `"#src/*"` 并把源码里的 `'#/…'` 换成 `'#src/…'`；
 *     未修复时本脚本会在加载阶段以退出码 3 给出提示。
 */

import { existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// 配置（./config/main.json、./secret.json）都是相对 cwd 读取的，先切到项目根
process.chdir(fileURLToPath(new URL('../', import.meta.url)));

// ---- 已授权的沙箱标识 ----

/** 机器人自身 id（`qUSR#…@` 后面的那串） */
const BOT_ID = '8528533035224324959';
/** 沙箱测试用户（完整标识） */
const SANDBOX_USER = 'qUSR#DE5D74452748FAFEF5063175198C950C@' + BOT_ID;
/** 沙箱测试群（完整标识） */
const SANDBOX_GROUP = 'qGRP#588A721FF0F068E24B68628F087AFB31@' + BOT_ID;
/** 测试用户的裸 id（@ 片段里应该是这个） */
const SANDBOX_USER_ID = 'DE5D74452748FAFEF5063175198C950C';
/** 测试群的裸 id */
const SANDBOX_GROUP_ID = '588A721FF0F068E24B68628F087AFB31';

// ---- 断言的计数与输出 ----

let passed = 0;
/** @type {{name: string, detail: string}[]} */
const failures = [];

/**
 * 断言一条用例。
 * @param {string} name 用例名
 * @param {boolean} cond 是否通过
 * @param {any} [detail] 失败时打印的现场
 */
function ok(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failures.push({ name, detail: safeJson(detail) });
    console.log(`  FAIL  ${name}${detail === undefined ? '' : `  →  ${safeJson(detail)}`}`);
  }
}

/**
 * 断言一段代码抛出指定类型的错误。
 * @param {string} name 用例名
 * @param {() => any} fn 待执行
 * @param {string} [wantType] 期望的错误类名
 */
function throws(name, fn, wantType) {
  try {
    const value = fn();
    failures.push({ name, detail: `未抛错，返回 ${safeJson(value)}` });
    console.log(`  FAIL  ${name}  →  未抛错，返回 ${safeJson(value).slice(0, 120)}`);
  } catch (error) {
    const actual = error?.constructor?.name ?? 'Error';
    const good = !wantType || actual === wantType;
    if (good) {
      passed++;
      console.log(`  ok    ${name}  (${actual})`);
    } else {
      failures.push({ name, detail: `${actual}: ${error?.message}` });
      console.log(`  FAIL  ${name}  →  期望 ${wantType}，实际 ${actual}: ${error?.message}`);
    }
  }
}

/** 把一个值变成适合单行打印的字符串 */
function safeJson(value) {
  try {
    if (typeof value === 'string') return JSON.stringify(value);
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * 执行一段用例；其中抛出的异常记为一条失败，不中断整个脚本。
 * @param {string} label 用例组名
 * @param {() => void} fn 用例主体
 */
function guard(label, fn) {
  try {
    fn();
  } catch (error) {
    failures.push({ name: label, detail: `${error.constructor.name}: ${error.message}` });
    console.log(`  FAIL  ${label}  →  ${error.constructor.name}: ${error.message}`);
  }
}

/** 取片段类型序列，便于比较转换结果 */
function typesOf(message) {
  return message.fragments.map((f) => f.TYPE);
}

// ---- 最小运行时 ----

/**
 * 起一个「够用」的内核：日志 + PlatformManager 单例。
 * qqbot 的 entry.js 在模块顶层就会 registerPlatform，因此必须先把单例建好。
 */
async function bootRuntime(loggerOverrides = {}) {
  await import('../src/utils/NeonaicNewableError.js'); // 既有 ESM 环：先求值错误模块，避免 TDZ
  const { PlatformManager } = await import('../src/platform/platformManager.js');
  const { getLogger } = await import('../src/logger/Logger.js');
  const { resolve } = await import('node:path');

  if (!PlatformManager.instance) {
    new PlatformManager({ configPath: resolve(process.cwd(), 'secret.json'), logger: getLogger() });
  }
  return { PlatformManager, getLogger };
}

/**
 * 造一个最小的「Platform 实例」：只需要 selfInfo.id 与 log()。
 * 入站转换只用到这两样，不必真的连接 QQ。
 */
function fakePlatform() {
  /** @type {{type: string, args: any[]}[]} */
  const logs = [];
  return {
    profile: '@test',
    selfInfo: { id: BOT_ID },
    logs,
    log: (type, ...args) => logs.push({ type, args }),
  };
}

// =====================================================================================
// 一、离线：入站转换
// =====================================================================================

async function runInbound(convert) {
  console.log('\n=== 1. 入站：QQ 事件 → NeonaicMessage ===');
  const pp = fakePlatform();

  // 1.1 纯文本
  {
    const event = { message: [{ type: 'text', data: { text: '你好，澪奈' } }], mentions: [] };
    const msg = convert.toNeonaicMsg(event, pp);
    ok('纯文本：类型序列', safeJson(typesOf(msg)) === '["text"]', typesOf(msg));
    ok('纯文本：markdown', msg.toMarkdown() === '你好，澪奈', msg.toMarkdown());
  }

  // 1.2 混合消息（文本 / 表情 / 图片 / 链接 / 音频 / 视频 / 未知类型）
  {
    const event = {
      message: [
        { type: 'text', data: { text: '看这个' } },
        { type: 'face', data: { id: 4 } },                       // 得意（表情表内的 id）
        { type: 'image', data: { url: 'https://example.com/a.png', name: 'a.png' } },
        { type: 'link', data: { url: 'https://example.com/doc', text: '文档' } },
        { type: 'audio', data: { url: 'https://example.com/a.mp3', name: 'a.mp3' } },
        { type: 'video', data: { url: 'https://example.com/v.mp4', name: 'v.mp4' } },
        { type: 'no-such-type', data: {} },
      ],
      mentions: [],
    };
    const msg = convert.toNeonaicMsg(event, pp);
    ok(
      '混合消息：未知类型被跳过、其余按序转换',
      safeJson(typesOf(msg)) === '["text","emoji","image","link","audio","video"]',
      typesOf(msg),
    );
    const md = msg.toMarkdown();
    ok('混合消息：图片为 markdown 图片', md.includes('https://example.com/a.png'), md);
    ok('混合消息：音频导出为 <audio> 标签', md.includes('<audio') && md.includes('a.mp3'), md.slice(0, 200));
    ok('混合消息：视频导出为 <video> 标签', md.includes('<video') && md.includes('v.mp4'), md.slice(0, 200));
    ok('混合消息：链接仍保留 URL', md.includes('https://example.com/doc'), md);
    ok('混合消息：未知类型留下一条 warn', pp.logs.some((l) => l.type === 'warn'), pp.logs.length);
    ok('表情：face 转成 emoji 片段', typesOf(msg).includes('emoji'), typesOf(msg));
    ok('表情：markdown 不是占位符', !md.includes('Unknown Emoji'), md);
  }

  // 1.3 textOnly：音视频不带真实地址（避免把 base64/链接塞进纯文本通道）
  {
    const event = {
      message: [
        { type: 'audio', data: { url: 'https://example.com/a.mp3' } },
        { type: 'video', data: { url: 'https://example.com/v.mp4' } },
      ],
      mentions: [],
    };
    const msg = convert.toNeonaicMsg(event, pp, true);
    const md = msg.toMarkdown();
    ok('textOnly：音视频地址被替换为占位', md.includes('about:nosource') && !md.includes('example.com'), md);
  }

  // 1.4 @ 提及：target 必须是 `qUSR#<裸 id>@<botId>`
  {
    const event = {
      message: [{ type: 'text', data: { text: 'hi' } }],
      mentions: [{ id: SANDBOX_USER_ID, is_you: true }],
    };
    const msg = convert.toNeonaicMsg(event, pp);
    const atFrag = msg.fragments.find((f) => f.TYPE === 'at');
    ok('@ 提及：生成 at 片段', !!atFrag, typesOf(msg));
    ok(`@ 提及：target 为 ${SANDBOX_USER}`, atFrag?.target === SANDBOX_USER, atFrag?.target);
    ok('@ 提及：markdown 含 @ 目标', msg.toMarkdown().includes(SANDBOX_USER), msg.toMarkdown());
  }

  // 1.5 空消息 / 异常载荷
  {
    ok('空事件：不抛错且为空消息', typesOf(convert.toNeonaicMsg({}, pp)).length === 0);
    ok('mentions 非数组：不抛错', typesOf(convert.toNeonaicMsg({ message: [], mentions: 'x' }, pp)).length === 0);

    // message 不是数组时目前会抛 TypeError，这里只记录、不让脚本崩
    /** @type {Error|null} */
    let payloadError = null;
    try { convert.toNeonaicMsg({ message: 'oops' }, pp); } catch (error) { payloadError = error; }
    ok('message 非数组：不应抛错', payloadError === null,
      payloadError && `${payloadError.constructor.name}: ${payloadError.message}`);

    // 单个片段自身结构坏掉时，只应跳过这一片，不能整条消息失败
    /** @type {any} */
    let broken = null;
    /** @type {Error|null} */
    let brokenError = null;
    try {
      broken = convert.toNeonaicMsg({
        message: [{ type: 'text', data: { text: '在' } }, null, { type: 'image', data: null }],
        mentions: [],
      }, pp);
    } catch (error) { brokenError = error; }
    ok('坏片段被跳过、其余保留', !brokenError && typesOf(broken).join(',') === 'text,image',
      brokenError ? `${brokenError.constructor.name}: ${brokenError.message}` : typesOf(broken));
  }
}

// =====================================================================================
// 二、离线：出站转换
// =====================================================================================

async function runOutbound(convert, frag) {
  console.log('\n=== 2. 出站：NeonaicMessage → qq-official-bot 片段 ===');
  const {
    NeonaicMessage, NeonaicTextMsgFrag, NeonaicBrMsgFrag, NeonaicAtMsgFrag,
    NeonaicLinkMsgFrag, NeonaicImageMsgFrag, NeonaicAudioMsgFrag, NeonaicVideoMsgFrag,
    NeonaicTableMsgFrag, NeonaicEmojiMsgFrag,
  } = frag;

  // 2.1 NeonaicTValidMessage 的五种形态都要能进
  {
    const cases = [
      ['字符串', '你好'],
      ['字符串数组', ['甲', '乙']],
      ['单个片段', new NeonaicTextMsgFrag('丙')],
      ['片段数组', [new NeonaicTextMsgFrag('丁'), new NeonaicBrMsgFrag()]],
      ['NeonaicMessage', new NeonaicMessage('戊')],
    ];
    for (const [label, payload] of cases) {
      try {
        const out = convert.toQbMsg(payload);
        ok(`入参形态「${label}」可转换`, Array.isArray(out) && out.length > 0, out);
      } catch (error) {
        failures.push({ name: `入参形态「${label}」可转换`, detail: `${error.constructor.name}: ${error.message}` });
        console.log(`  FAIL  入参形态「${label}」可转换  →  ${error.constructor.name}: ${error.message}`);
      }
    }
    throws('非法入参（数字）抛 IllegalArgument', () => convert.toQbMsg(123), 'NeonaicIllegalArgumentError');
  }

  // 2.2 文本 / 换行
  {
    const out = convert.toQbMsg(new NeonaicMessage([new NeonaicTextMsgFrag('你好'), new NeonaicBrMsgFrag(), '世界']));
    ok('文本+换行：片段数量', out.length === 3, out.length);
    ok('文本：type/data 正确', out[0]?.type === 'text' && out[0]?.data?.text === '你好', out[0]);
    ok('换行：转成 \\n 文本片段', out[1]?.type === 'text' && out[1]?.data?.text === '\n', out[1]);
  }

  // 2.3 @：`qUSR#<裸 id>@<botId>` → `at(user_id = 裸 id)`
  guard('@ 片段转换', () => {
    const seg = convert.toQbMsg(new NeonaicMessage([new NeonaicAtMsgFrag(SANDBOX_USER)]))[0];
    ok('@：生成 at 片段', seg?.type === 'at', seg);
    ok(`@：user_id 为裸 id（去掉 qUSR# 与 @botId）`, seg?.data?.user_id === SANDBOX_USER_ID, seg?.data);
  });
  throws('@ 群聊：抛 IllegalState', () => convert.toQbMsg(new NeonaicMessage([new NeonaicAtMsgFrag(SANDBOX_GROUP)])), 'NeonaicIllegalStateError');

  // 2.4 链接 / 表格 / 表情都退化为 markdown 片段
  guard('链接转换', () => {
    const link = convert.toQbMsg(new NeonaicMessage([new NeonaicLinkMsgFrag('https://example.com/doc', '文档')]))[0];
    ok('链接：转为 markdown 片段', link?.type === 'markdown', link);
    ok('链接：markdown 内容含 URL', String(link?.data?.content ?? '').includes('https://example.com/doc'), link?.data?.content);
    ok('链接：缺省 alt 不产生 "undefined" 标题', !String(link?.data?.content ?? '').includes('undefined'), link?.data?.content);
  });
  guard('表格转换', () => {
    const table = convert.toQbMsg(new NeonaicMessage([new NeonaicTableMsgFrag([['a', 'b'], ['1', '2']], 'array[]', { colTitle: ['列1', '列2'] })]))[0];
    ok('表格：转为 markdown 片段', table?.type === 'markdown' && String(table.data.content).includes('|'), table);
  });
  guard('表情转换', () => {
    const emoji = convert.toQbMsg(new NeonaicMessage([new NeonaicEmojiMsgFrag(':smile:')]))[0];
    ok('表情：退化为 markdown 片段', emoji?.type === 'markdown', emoji);
  });

  // 2.5 图片：base64 走 Buffer、URL 直接透传
  guard('图片转换', () => {
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8, 0)]);
    const segBase64 = convert.toQbMsg(new NeonaicMessage([new NeonaicImageMsgFrag(PNG, { title: 'T', alt: 'A' })]))[0];
    ok('图片 base64：转成 image 片段且 file 为 Buffer', segBase64?.type === 'image' && Buffer.isBuffer(segBase64?.data?.file), segBase64);
    ok('图片：name 为「标题\\n替代」', segBase64?.data?.name === 'T\nA', segBase64?.data?.name);

    const segUrl = convert.toQbMsg(new NeonaicMessage([new NeonaicImageMsgFrag('https://example.com/p.png')]))[0];
    ok('图片 URL：file 保持 URL', segUrl?.data?.file === 'https://example.com/p.png', segUrl?.data);
  });

  // 2.6 音频 / 视频：URL 透传；base64 依 allowTempSave 决定落盘还是占位
  guard('音频转换', () => {
    const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(8, 1)]);
    const audioUrl = convert.toQbMsg(new NeonaicMessage([new NeonaicAudioMsgFrag('https://example.com/a.mp3')]))[0];
    ok('音频 URL：file 保持 URL', audioUrl?.type === 'audio' && audioUrl.data.file === 'https://example.com/a.mp3', audioUrl);

    const audioNoSave = convert.toQbMsg(new NeonaicMessage([new NeonaicAudioMsgFrag(MP3)]), false)[0];
    ok('音频 base64 且不落盘：退化为占位地址', String(audioNoSave?.data?.file ?? '').includes('unresolvable'), audioNoSave?.data);

    const audioSaved = convert.toQbMsg(new NeonaicMessage([new NeonaicAudioMsgFrag(MP3)]), true)[0];
    const tmpPath = String(audioSaved?.data?.file ?? '');
    ok('音频 base64 且允许落盘：拿到临时文件路径', tmpPath.startsWith('/') && existsSync(tmpPath), tmpPath);
    if (tmpPath.startsWith('/') && existsSync(tmpPath)) unlinkSync(tmpPath);
  });
  guard('视频转换', () => {
    const videoNoSave = convert.toQbMsg(new NeonaicMessage([new NeonaicVideoMsgFrag(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom')]))]), false)[0];
    ok('视频 base64 且不落盘：退化为占位地址', String(videoNoSave?.data?.file ?? '').includes('unresolvable'), videoNoSave?.data);
  });

  // 2.7 未知片段类型：必须抛 NeonaicIllegalArgumentError（而不是 ReferenceError）
  {
    class WeirdFrag extends frag.NeonaicMessageFragment { get TYPE() { return 'raw-fragment'; } }
    throws('未知片段类型抛 IllegalArgument', () => convert.toQbMsg(new NeonaicMessage([new WeirdFrag()])), 'NeonaicIllegalArgumentError');
  }
}

// =====================================================================================
// 三、离线：发送入口（桩 bot）
// =====================================================================================

async function runSendPaths(msgHandler, entryModule, frag) {
  console.log('\n=== 3. 发送入口：msgHandler.sendMsg / PlatformQQBot.sendMsg（桩 bot，不联网）===');
  const { NeonaicMessage } = frag;
  const { PlatformQQBot } = entryModule;

  /** @type {{kind: string, id: string, payload: any}[]} */
  const calls = [];
  const stubBot = {
    async sendGroupMessage(id, payload) {
      calls.push({ kind: 'group', id, payload });
      return { id: 'stub-msg', timestamp: Date.now(), audit_status: 'approved' };
    },
    async sendPrivateMessage(id, payload) {
      calls.push({ kind: 'private', id, payload });
      return { id: 'stub-msg', timestamp: Date.now(), audit_status: 'approved' };
    },
  };

  // 继承真实平台类：msgHandler.sendMsg 里有 `instanceof PlatformQQBot` 校验，
  // 而 bot / selfInfo 是只读 getter，子类覆写即可注入桩。
  class StubPlatform extends PlatformQQBot {
    constructor() { super('stub-profile'); }
    get bot() { return stubBot; }
    get selfInfo() { return { id: BOT_ID }; }
  }
  const pp = new StubPlatform();

  // 3.1 群聊
  calls.length = 0;
  try {
    const result = await msgHandler.sendMsg(pp, SANDBOX_GROUP, new NeonaicMessage('群聊测试'));
    ok('群聊：调用 sendGroupMessage 一次', calls.length === 1 && calls[0].kind === 'group', calls.length);
    ok(`群聊：目标 id 为裸群号 ${SANDBOX_GROUP_ID}`, calls[0]?.id === SANDBOX_GROUP_ID, calls[0]?.id);
    ok('群聊：payload 是片段数组', Array.isArray(calls[0]?.payload) && calls[0].payload[0]?.type === 'text', calls[0]?.payload);
    ok('群聊：返回 SendResult', result?.id === 'stub-msg', result);
  } catch (error) {
    failures.push({ name: '群聊发送全链路', detail: `${error.constructor.name}: ${error.message}` });
    console.log(`  FAIL  群聊发送全链路  →  ${error.constructor.name}: ${error.message}`);
  }

  // 3.2 私聊
  calls.length = 0;
  try {
    await msgHandler.sendMsg(pp, SANDBOX_USER, new NeonaicMessage('私聊测试'));
    ok('私聊：调用 sendPrivateMessage 一次', calls.length === 1 && calls[0].kind === 'private', calls.length);
    ok(`私聊：目标 id 为裸用户号 ${SANDBOX_USER_ID}`, calls[0]?.id === SANDBOX_USER_ID, calls[0]?.id);
  } catch (error) {
    failures.push({ name: '私聊发送全链路', detail: `${error.constructor.name}: ${error.message}` });
    console.log(`  FAIL  私聊发送全链路  →  ${error.constructor.name}: ${error.message}`);
  }

  // 3.3 无法识别的目标
  await (async () => {
    try {
      await msgHandler.sendMsg(pp, 'not-a-target', 'x');
      failures.push({ name: '非法目标抛错', detail: '未抛错' });
      console.log('  FAIL  非法目标抛错  →  未抛错');
    } catch (error) {
      ok('非法目标抛 IllegalArgument', error.constructor.name === 'NeonaicIllegalArgumentError', error.constructor.name);
    }
  })();

  // 3.4 平台层 sendMsg：成功路径（这里最容易踩到「把 NeonaicMessage 当字符串用」）
  calls.length = 0;
  const reply = await pp.sendMsg(SANDBOX_GROUP, '平台层文本');
  ok('PlatformQQBot.sendMsg 群聊：真的发出了片段', calls.length === 1, calls.length);
  ok('PlatformQQBot.sendMsg 群聊：回执为「成功」', reply.includes('成功'), reply);

  // 3.4b 平台层 sendMsg：单个 NeonaicMessage 也必须能进（rest 参数包成数组会抛 IllegalArgument）
  calls.length = 0;
  try {
    const replyMsg = await pp.sendMsg(SANDBOX_GROUP, new NeonaicMessage('平台层 NeonaicMessage'));
    ok('PlatformQQBot.sendMsg 传单个 NeonaicMessage：真的发出', calls.length === 1, calls.length);
    ok('PlatformQQBot.sendMsg 传单个 NeonaicMessage：回执为「成功」', replyMsg.includes('成功'), replyMsg);
  } catch (error) {
    failures.push({ name: 'PlatformQQBot.sendMsg 传单个 NeonaicMessage', detail: `${error.constructor.name}: ${error.message}` });
    console.log(`  FAIL  PlatformQQBot.sendMsg 传单个 NeonaicMessage  →  ${error.constructor.name}: ${error.message}`);
  }

  // 3.5 平台层 sendMsg：botId 不匹配必须被拦下
  calls.length = 0;
  const mismatch = await pp.sendMsg(`qGRP#${SANDBOX_GROUP_ID}@9999999999`, '发给别的机器人');
  ok('PlatformQQBot.sendMsg botId 不匹配：被拦下', calls.length === 0, calls.length);
  ok('PlatformQQBot.sendMsg botId 不匹配：回执说明不匹配', mismatch.includes('不匹配'), mismatch);
}

// =====================================================================================
// 四、联网：连沙箱收发
// =====================================================================================

async function runLive({ PlatformManager, getLogger }, { send, listenSeconds, sandbox, only }, msgHandler) {
  console.log('\n=== 4. 联网：连接 QQ 沙箱 ===');
  const pm = PlatformManager.instance;
  const profiles = [...pm._profiles.values()].filter((p) => p.type === 'qqbot');
  if (!profiles.length) {
    console.log('  !! secret.json 里没有 type=qqbot 的 Profile，跳过联网测试');
    return;
  }
  const profile = profiles[0];
  if (sandbox) profile.sandbox = true;
  // 只观测时不希望触发 AI 回复（否则沙箱群会被刷屏），命令仍可正常工作
  if (listenSeconds > 0 && !send) profile.useAI = false;

  console.log(`  使用 Profile「${profile.name}」，sandbox=${profile.sandbox === true}`);
  const { PlatformQQBot } = await import('../extensions/qqbot/src/entry.js');
  const convert = await import('../extensions/qqbot/src/msgPayloadConvertor.js');
  const pp = new PlatformQQBot(profile.name);

  await pp.start();
  console.log(`  已连接，机器人 id = ${pp.selfInfo?.id}`);
  if (pp.selfInfo?.id && pp.selfInfo.id !== BOT_ID) {
    console.log(`  !! 机器人 id 与预期（${BOT_ID}）不同，脚本里的沙箱标识可能不匹配`);
  }

  try {
    if (send) {
      console.log('\n--- 逐条发送：先看「转换出的片段」，再看「传输结果」 ---');
      const msgFrag = await import('../src/message/messageFragment.js');
      const { NeonaicMessage, NeonaicAtMsgFrag, NeonaicLinkMsgFrag, NeonaicImageMsgFrag } = msgFrag;
      /** 真实的 1×1 PNG（只造文件头 QQ 会以 850019「格式不支持」拒绝，测不出转换层） */
      const PNG = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      );
      /** @type {[string, any][]} */
      const cases = [
        ['纯文本', new NeonaicMessage('【转换测试1】纯文本')],
        ['文本+@', new NeonaicMessage(['【转换测试2】@ 你：', new NeonaicAtMsgFrag(SANDBOX_USER)])],
        ['链接(markdown)', new NeonaicMessage([new NeonaicLinkMsgFrag('https://example.com/doc', '【转换测试3】链接')])],
        ['图片(URL)', new NeonaicMessage([new NeonaicImageMsgFrag('https://httpbin.org/image/png', { title: '转换测试4' })])],
        ['图片(base64)', new NeonaicMessage([new NeonaicImageMsgFrag(PNG, { title: '转换测试5' })])],
      ];

      for (const [label, payload] of cases) {
        if (only && !label.includes(only)) continue;
        for (const [scope, who] of [['群', SANDBOX_GROUP], ['私聊', SANDBOX_USER]]) {
          console.log(`\n  [${label} → ${scope}] 目标=${who}`);
          /** @type {any} */
          let segments = null;
          /** @type {Error|null} */
          let convError = null;
          try { segments = convert.convert_NeonaicMsg_to_qqBotMsg(payload); } catch (error) { convError = error; }
          if (convError) {
            console.log(`    片段=转换失败 ${convError.constructor.name}: ${convError.message}`);
            console.log('    → 未发送（转换阶段就抛了）');
            continue;
          }
          console.log(`    片段=${safeJson(segments).slice(0, 220)}`);
          try {
            const result = await msgHandler.sendMsg(pp, who, payload);
            console.log(`    → 已提交，SendResult=${safeJson(result)}`);
          } catch (error) {
            console.log(`    → 发送失败 ${error.constructor.name}: ${error.message}`);
          }
          await new Promise((r) => setTimeout(r, 1500)); // 官方接口有频控
        }
      }
    }

    if (listenSeconds > 0) {
      console.log(`\n--- 监听 ${listenSeconds} 秒：请在沙箱群/私聊里发消息 ---`);
      const seen = [];
      // 额外挂一个只做转换的监听器，用于打印「原始 payload → NeonaicMessage」的对照
      pp.bot.on('message.group', (event) => {
        const msg = convert.toNeonaicMsg(event, pp);
        seen.push(msg);
        console.log(`  [入站/群] 片段=${JSON.stringify(typesOf(msg))}`);
        console.log(`           markdown=${JSON.stringify(msg.toMarkdown())}`);
        console.log(`           raw=${JSON.stringify((event.message || []).map((p) => p?.type))}`);
      });
      pp.bot.on('message.private', (event) => {
        const msg = convert.toNeonaicMsg(event, pp);
        seen.push(msg);
        console.log(`  [入站/私聊] 片段=${JSON.stringify(typesOf(msg))}`);
        console.log(`            markdown=${JSON.stringify(msg.toMarkdown())}`);
      });
      await new Promise((r) => setTimeout(r, listenSeconds * 1000));
      console.log(`  监听结束，共收到 ${seen.length} 条消息`);
      if (!seen.length) console.log('  （一条都没收到：检查是否 sandbox 模式、是否把消息发到了对应会话）');
    }
  } finally {
    await pp.stop().catch(() => { });
    console.log('  已断开连接');
  }
}

// =====================================================================================
// 主流程
// =====================================================================================

/** 解析命令行参数 */
function parseArgv(argv) {
  const flags = new Set(argv.filter((a) => !a.startsWith('--listen')));
  const listenArg = argv.find((a) => a.startsWith('--listen'));
  const listenSeconds = listenArg
    ? Number(listenArg.includes('=') ? listenArg.split('=')[1] : 30) || 30
    : 0;
  const onlyArg = argv.find((a) => a.startsWith('--only='));
  return {
    live: flags.has('--live'),
    send: flags.has('--send'),
    sandbox: flags.has('--sandbox'),
    listenSeconds,
    /** 只跑标签里含该子串的用例，避免重复刷屏 */
    only: onlyArg ? onlyArg.slice('--only='.length) : '',
  };
}

async function main() {
  const opts = parseArgv(process.argv.slice(2));

  const runtime = await bootRuntime();

  /** @type {any} */
  let convert, msgHandler, entryModule, frag;
  try {
    // 先装载 entry（模块顶层会 registerPlatform），再取转换器
    entryModule = await import('../extensions/qqbot/src/entry.js');
    convert = await import('../extensions/qqbot/src/msgPayloadConvertor.js');
    msgHandler = await import('../extensions/qqbot/src/msgHandler.js');
    frag = await import('../src/message/messageFragment.js');
  } catch (error) {
    if (error?.code === 'ERR_INVALID_MODULE_SPECIFIER') {
      console.error('\n无法加载 qqbot 模块：源码里的 `#/…` 子路径导入在 Node 中是**非法别名**。');
      console.error('Node 规定 imports 的键不能以 `#/` 开头，`"#/*": "./src/*"` 永远不会命中。');
      console.error('修法：package.json 里把 "#/*" 改成 "#src/*"，再把源码中的 \'#/…\' 全量替换为 \'#src/…\'。');
      console.error('（本脚本自身已改用相对路径，不受影响；受影响的是 src/ 与 extensions/ 内部。）\n');
    }
    throw error;
  }

  // 把导出名对齐到脚本里用的短名，避免改测试正文
  const api = {
    toNeonaicMsg: convert.convert_qqBotMsg_to_NeonaicMsg,
    toQbMsg: convert.convert_NeonaicMsg_to_qqBotMsg,
  };

  await runInbound(api);
  await runOutbound(api, frag);
  await runSendPaths(msgHandler, entryModule, frag);

  if (opts.live) {
    await runLive(runtime, opts, msgHandler);
  }

  console.log('\n============================');
  console.log(`通过 ${passed} 条，失败 ${failures.length} 条`);
  if (failures.length) {
    console.log('失败明细：');
    for (const f of failures) console.log(`  - ${f.name}：${f.detail}`);
  }
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  if (error?.code === 'ERR_INVALID_MODULE_SPECIFIER') {
    console.error('\n无法加载内核模块：源码里的 `#/…` 子路径导入在 Node 中是**非法别名**。');
    console.error('Node 规定 package.json 的 imports 键不能以 `#/` 开头，故 `"#/*": "./src/*"` 永不命中。');
    console.error('修法：把 "#/*" 改成 "#src/*"，并把源码中的 \'#/…\' 全量替换成 \'#src/…\'。');
    console.error('（本脚本自身用相对路径导入，不受别名影响；受影响的是 src/ 与 extensions/ 内部。）\n');
    process.exit(3);
  }
  console.error('脚本自身异常：', error);
  process.exit(2);
});
