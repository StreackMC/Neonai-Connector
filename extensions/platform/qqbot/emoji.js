/**
 * emoji.js — QQ 机器人表情映射（Unicode / 文本 / ID / Type 四维互查）
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │ 每条记录包含 4 个维度，可任意两两互查：                              │
 * │   type    : 1 = QQ 小黄脸(face) │ 2 = Emoji(unicode)               │
 * │   id      : 表情数字 ID（QQ 小黄脸为 QQ 内部 ID；Emoji 为 Unicode   │
 * │             码点十进制，可由 id 反推 unicode 字符）                  │
 * │   unicode : Unicode 字符（Emoji 可由 id 推导；小黄脸无标准 Unicode，  │
 * │             置 null）                                               │
 * │   text    : 表情含义（中文语义）                                    │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * 设计目标：可拓展性良好
 *   - 数据层（EMOJI_BASE）与索引层（_store）分离，新增表情只动数据。
 *   - 提供 registerEmoji / registerEmojis 运行时热扩展接口，无需改源码。
 *   - 所有查询统一返回标准记录对象，缺维度（如小黄脸 unicode）返回 null。
 *
 * 使用约定（与 qq-official-bot SDK 对齐）：
 *   - 小黄脸在消息中以 { type: 'face',  id: <number> } 表达
 *   - Emoji  在消息中以 { type: 'emoji', id: <codepoint> } 表达
 *   - 商城表情以 { type: 'face', id: '', ext: <base64> } 表达
 *     （id 为空，ext 为 base64(JSON)，解码得 { text:'表情描述' }，无标准 ID/Unicode）
 */

// ——————————————————————————— 类型定义（JSDoc @typedef） ———————————————————————————

/**
 * @typedef {1|2} EmojiType
 *   QQ 表情大类：1 = 小黄脸(face)，2 = Emoji(unicode)。
 */

/**
 * @typedef {Object} EmojiRecord
 *   标准表情记录——_store 存储形态，也是所有查询函数的返回形态。
 * @property {EmojiType}   type     表情大类
 * @property {number}      id       表情数字 ID
 * @property {string}      text     表情含义（中文语义）
 * @property {string|null} unicode  Unicode 字符；小黄脸无标准 Unicode，为 null
 * @property {string}      typeName 类型名（FACE / EMOJI），便于日志/调试
 */

/**
 * @typedef {Object} EmojiRaw
 *   原始表情数据——EMOJI_BASE 与 registerEmoji 入参形态。
 * @property {EmojiType} type
 * @property {number}    id
 * @property {string}    text
 * @property {string}    [unicode] 可选：显式提供以覆盖自动推导值
 */

/**
 * @typedef {Object} QQEmojiElement
 *   qq-official-bot 消息片段中的表情元素。
 * @property {'face'|'emoji'} type
 * @property {number}         id
 */

/**
 * @typedef {Object} MallEmojiRecord
 *   商城表情（自定义贴纸）解析结果——仅 inbound 出现，无标准 ID / Unicode。
 * @property {EmojiType}    type     恒为 FACE(1)
 * @property {string}       id       空字符串（商城表情无标准数字 ID）
 * @property {string|null}  text     来自 ext 解码的 {"text":"..."} 描述；解码失败为 null
 * @property {string|null}  unicode  null（无标准 Unicode）
 * @property {string}       typeName 'FACE'
 * @property {true}         mall     标记：商城表情
 * @property {string}       ext      原始 base64 ext（调试/排查用）
 */

/**
 * 表情类型枚举（同时作为 type 字段取值）。
 * 新增表情大类时在此追加即可，其余逻辑无需改动。
 */
export const EMOJI_TYPES = Object.freeze({
  /** QQ 小黄脸（face），无标准 Unicode，unicode 维度为 null */
  FACE: 1,
  /** Emoji（unicode），id 即 Unicode 码点十进制 */
  EMOJI: 2,
});

/** 反向查类型名，便于日志/调试 */
const TYPE_NAMES = Object.freeze(
  Object.fromEntries(Object.entries(EMOJI_TYPES).map(([k, v]) => [v, k]))
);

/**
 * 原始表情数据（可在此直接追加）。
 * 字段：{ type:number, id:number, text:string, unicode?:string }
 *   - type 2 可不填 unicode：normalize 阶段会用 String.fromCodePoint(id) 推导。
 *   - type 1 不填 unicode：推导结果为 null（正确，小黄脸无标准 Unicode）。
 */
const EMOJI_BASE = [
  // ——————————————————————————— Type 1：QQ 小黄脸 ———————————————————————————
  { type: 1, id: 4,    text: '得意' },
  { type: 1, id: 5,    text: '流泪' },
  { type: 1, id: 8,    text: '睡' },
  { type: 1, id: 9,    text: '大哭' },
  { type: 1, id: 10,   text: '尴尬' },
  { type: 1, id: 12,   text: '调皮' },
  { type: 1, id: 14,   text: '微笑' },
  { type: 1, id: 16,   text: '酷' },
  { type: 1, id: 21,   text: '可爱' },
  { type: 1, id: 23,   text: '傲慢' },
  { type: 1, id: 24,   text: '饥饿' },
  { type: 1, id: 25,   text: '困' },
  { type: 1, id: 26,   text: '惊恐' },
  { type: 1, id: 27,   text: '流汗' },
  { type: 1, id: 28,   text: '憨笑' },
  { type: 1, id: 29,   text: '悠闲' },
  { type: 1, id: 30,   text: '奋斗' },
  { type: 1, id: 32,   text: '疑问' },
  { type: 1, id: 33,   text: '嘘' },
  { type: 1, id: 34,   text: '晕' },
  { type: 1, id: 38,   text: '敲打' },
  { type: 1, id: 39,   text: '再见' },
  { type: 1, id: 41,   text: '发抖' },
  { type: 1, id: 42,   text: '爱情' },
  { type: 1, id: 43,   text: '跳跳' },
  { type: 1, id: 49,   text: '拥抱' },
  { type: 1, id: 53,   text: '蛋糕' },
  { type: 1, id: 60,   text: '咖啡' },
  { type: 1, id: 63,   text: '玫瑰' },
  { type: 1, id: 66,   text: '爱心' },
  { type: 1, id: 74,   text: '太阳' },
  { type: 1, id: 75,   text: '月亮' },
  { type: 1, id: 76,   text: '赞' },
  { type: 1, id: 78,   text: '握手' },
  { type: 1, id: 79,   text: '胜利' },
  { type: 1, id: 85,   text: '飞吻' },
  { type: 1, id: 89,   text: '西瓜' },
  { type: 1, id: 96,   text: '冷汗' },
  { type: 1, id: 97,   text: '擦汗' },
  { type: 1, id: 98,   text: '抠鼻' },
  { type: 1, id: 99,   text: '鼓掌' },
  { type: 1, id: 100,  text: '糗大了' },
  { type: 1, id: 101,  text: '坏笑' },
  { type: 1, id: 102,  text: '左哼哼' },
  { type: 1, id: 103,  text: '右哼哼' },
  { type: 1, id: 104,  text: '哈欠' },
  { type: 1, id: 106,  text: '委屈' },
  { type: 1, id: 109,  text: '左亲亲' },
  { type: 1, id: 111,  text: '可怜' },
  { type: 1, id: 116,  text: '示爱' },
  { type: 1, id: 118,  text: '抱拳' },
  { type: 1, id: 120,  text: '拳头' },
  { type: 1, id: 122,  text: '爱你' },
  { type: 1, id: 123,  text: 'NO' },
  { type: 1, id: 124,  text: 'OK' },
  { type: 1, id: 125,  text: '转圈' },
  { type: 1, id: 129,  text: '挥手' },
  { type: 1, id: 144,  text: '喝彩' },
  { type: 1, id: 147,  text: '棒棒糖' },
  { type: 1, id: 171,  text: '茶' },
  { type: 1, id: 173,  text: '泪奔' },
  { type: 1, id: 174,  text: '无奈' },
  { type: 1, id: 175,  text: '卖萌' },
  { type: 1, id: 176,  text: '小纠结' },
  { type: 1, id: 179,  text: 'doge' },
  { type: 1, id: 180,  text: '惊喜' },
  { type: 1, id: 181,  text: '骚扰' },
  { type: 1, id: 182,  text: '笑哭' },
  { type: 1, id: 183,  text: '我最美' },
  { type: 1, id: 201,  text: '点赞' },
  { type: 1, id: 203,  text: '托脸' },
  { type: 1, id: 212,  text: '托腮' },
  { type: 1, id: 214,  text: '啵啵' },
  { type: 1, id: 219,  text: '蹭一蹭' },
  { type: 1, id: 222,  text: '抱抱' },
  { type: 1, id: 227,  text: '拍手' },
  { type: 1, id: 232,  text: '佛系' },
  { type: 1, id: 240,  text: '喷脸' },
  { type: 1, id: 243,  text: '甩头' },
  { type: 1, id: 246,  text: '加油抱抱' },
  { type: 1, id: 262,  text: '脑阔疼' },
  { type: 1, id: 264,  text: '捂脸' },
  { type: 1, id: 265,  text: '辣眼睛' },
  { type: 1, id: 266,  text: '哦哟' },
  { type: 1, id: 267,  text: '头秃' },
  { type: 1, id: 268,  text: '问号脸' },
  { type: 1, id: 269,  text: '暗中观察' },
  { type: 1, id: 270,  text: 'emm' },
  { type: 1, id: 271,  text: '吃瓜' },
  { type: 1, id: 272,  text: '呵呵哒' },
  { type: 1, id: 273,  text: '我酸了' },
  { type: 1, id: 277,  text: '汪汪' },
  { type: 1, id: 278,  text: '汗' },
  { type: 1, id: 281,  text: '无眼笑' },
  { type: 1, id: 282,  text: '敬礼' },
  { type: 1, id: 284,  text: '面无表情' },
  { type: 1, id: 285,  text: '摸鱼' },
  { type: 1, id: 287,  text: '哦' },
  { type: 1, id: 289,  text: '睁眼' },
  { type: 1, id: 290,  text: '敲开心' },
  { type: 1, id: 293,  text: '摸锦鲤' },
  { type: 1, id: 294,  text: '期待' },
  { type: 1, id: 297,  text: '拜谢' },
  { type: 1, id: 298,  text: '元宝' },
  { type: 1, id: 299,  text: '牛啊' },
  { type: 1, id: 305,  text: '右亲亲' },
  { type: 1, id: 306,  text: '牛气冲天' },
  { type: 1, id: 307,  text: '喵喵' },
  { type: 1, id: 314,  text: '仔细分析' },
  { type: 1, id: 315,  text: '加油' },
  { type: 1, id: 318,  text: '崇拜' },
  { type: 1, id: 319,  text: '比心' },
  { type: 1, id: 320,  text: '庆祝' },
  { type: 1, id: 322,  text: '拒绝' },
  { type: 1, id: 324,  text: '吃糖' },

  // ——————————————————————————— Type 2：Emoji（unicode） ———————————————————————————
  // id 即 Unicode 码点十进制，unicode 由 normalize 自动推导，此处仅标注含义。
  { type: 2, id: 9728,  text: '晴天' },
  { type: 2, id: 9749,  text: '咖啡' },
  { type: 2, id: 9786,  text: '可爱' },
  { type: 2, id: 10024, text: '闪光' },
  { type: 2, id: 10060, text: '错误' },
  { type: 2, id: 10068, text: '问号' },
  { type: 2, id: 127801, text: '玫瑰' },
  { type: 2, id: 127817, text: '西瓜' },
  { type: 2, id: 127822, text: '苹果' },
  { type: 2, id: 127827, text: '草莓' },
  { type: 2, id: 127836, text: '拉面' },
  { type: 2, id: 127838, text: '面包' },
  { type: 2, id: 127847, text: '刨冰' },
  { type: 2, id: 127866, text: '啤酒' },
  { type: 2, id: 127867, text: '干杯' },
  { type: 2, id: 127881, text: '庆祝' },
  { type: 2, id: 128027, text: '虫' },
  { type: 2, id: 128046, text: '牛' },
  { type: 2, id: 128051, text: '鲸鱼' },
  { type: 2, id: 128053, text: '猴' },
  { type: 2, id: 128074, text: '拳头' },
  { type: 2, id: 128076, text: '好的' },
  { type: 2, id: 128077, text: '厉害' },
  { type: 2, id: 128079, text: '鼓掌' },
  { type: 2, id: 128089, text: '内衣' },
  { type: 2, id: 128102, text: '男孩' },
  { type: 2, id: 128104, text: '爸爸' },
  { type: 2, id: 128147, text: '爱心' },
  { type: 2, id: 128157, text: '礼物' },
  { type: 2, id: 128164, text: '睡觉' },
  { type: 2, id: 128166, text: '水' },
  { type: 2, id: 128168, text: '吹气' },
  { type: 2, id: 128170, text: '肌肉' },
  { type: 2, id: 128235, text: '邮箱' },
  { type: 2, id: 128293, text: '火' },
  { type: 2, id: 128513, text: '呲牙' },
  { type: 2, id: 128514, text: '激动' },
  { type: 2, id: 128516, text: '高兴' },
  { type: 2, id: 128522, text: '嘿嘿' },
  { type: 2, id: 128524, text: '羞涩' },
  { type: 2, id: 128527, text: '哼哼' },
  { type: 2, id: 128530, text: '不屑' },
  { type: 2, id: 128531, text: '汗' },
  { type: 2, id: 128532, text: '失落' },
  { type: 2, id: 128536, text: '飞吻' },
  { type: 2, id: 128538, text: '亲亲' },
  { type: 2, id: 128540, text: '淘气' },
  { type: 2, id: 128541, text: '吐舌' },
  { type: 2, id: 128557, text: '大哭' },
  { type: 2, id: 128560, text: '紧张' },
  { type: 2, id: 128563, text: '瞪眼' },
];

// ——————————————————————————— 运行时存储与索引 ———————————————————————————

/** 主存储：键 `${type}:${id}` → 标准记录对象（唯一） */
const _store = new Map();

/**
 * 将原始记录规范化为标准记录。
 * - 自动推导 unicode：type 2 用 String.fromCodePoint(id)，其余为 null。
 * - 显式传入 unicode 时优先使用（允许覆盖推导值）。
 * @param {EmojiRaw} raw
 * @returns {EmojiRecord}
 */
function _normalize(raw) {
  if (!Number.isInteger(raw.type) || !Number.isInteger(raw.id)) {
    throw new TypeError(`非法表情记录：type/id 必须为整数 (${JSON.stringify(raw)})`);
  }
  const unicode =
    raw.unicode != null
      ? String(raw.unicode)
      : raw.type === EMOJI_TYPES.EMOJI
        ? String.fromCodePoint(raw.id)
        : null;
  return {
    type: raw.type,
    id: raw.id,
    text: String(raw.text),
    unicode,
    typeName: TYPE_NAMES[raw.type] ?? `UNKNOWN(${raw.type})`,
  };
}

/** 写入一条记录到存储（覆盖同名键，便于热更新） */
function _index(entry) {
  _store.set(`${entry.type}:${entry.id}`, entry);
}

// 初始化内置数据
for (const raw of EMOJI_BASE) _index(_normalize(raw));

// ——————————————————————————— 扩展接口（可拓展性核心） ———————————————————————————

/**
 * 注册单条表情（运行时热扩展）。重复 type+id 将覆盖。
 * @param {EmojiRaw} entry
 */
export function registerEmoji(entry) {
  _index(_normalize(entry));
}

/**
 * 批量注册表情。
 * @param {EmojiRaw[]} list
 */
export function registerEmojis(list = []) {
  if (!Array.isArray(list)) throw new TypeError('registerEmojis 期望数组');
  for (const e of list) registerEmoji(e);
}

// ——————————————————————————— 查询接口（四维互查） ———————————————————————————

/**
 * 按 type+id 精确查询（主键）。
 * @param {EmojiType} type
 * @param {number} id
 * @returns {EmojiRecord|null}
 */
export function getEmoji(type, id) {
  return _store.get(`${type}:${id}`) ?? null;
}
/** getEmoji 的别名，语义化命名 */
export const getByTypeAndId = getEmoji;

/**
 * 按 Unicode 字符查询（仅 type 2 有值，type 1 返回 null）。
 * @param {string} ch
 * @returns {EmojiRecord|null}
 */
export function getByUnicode(ch) {
  if (typeof ch !== 'string' || ch.length === 0) return null;
  for (const e of _store.values()) if (e.unicode === ch) return e;
  return null;
}

/**
 * 按含义文本查询。
 * @param {string} text
 * @param {EmojiType} [type] 指定类型可缩小范围；不传则返回跨类型所有匹配（数组）
 * @returns {EmojiRecord|EmojiRecord[]|null}
 */
export function getByText(text, type) {
  const t = String(text).trim();
  const out = [];
  for (const e of _store.values()) {
    if (e.text === t && (type === undefined || e.type === type)) out.push(e);
  }
  return out.length === 0 ? null : out.length === 1 ? out[0] : out;
}

/**
 * 按 id 查询（跨类型时可能命中多条）。
 * @param {number} id
 * @param {EmojiType} [type] 指定类型则精确单条，否则返回所有匹配（数组）
 * @returns {EmojiRecord|EmojiRecord[]|null}
 */
export function getById(id, type) {
  if (type !== undefined) return getEmoji(type, id);
  const out = [];
  for (const e of _store.values()) if (e.id === id) out.push(e);
  return out.length === 0 ? null : out.length === 1 ? out[0] : out;
}

// ——————————————————————————— 便捷转换 ———————————————————————————

/**
 * type+id → unicode 字符（小黄脸返回 null）。
 * @param {EmojiType} type
 * @param {number} id
 * @returns {string|null}
 */
export function toUnicode(type, id) {
  return getEmoji(type, id)?.unicode ?? null;
}
/**
 * type+id → 含义文本。
 * @param {EmojiType} type
 * @param {number} id
 * @returns {string|null}
 */
export function toText(type, id) {
  return getEmoji(type, id)?.text ?? null;
}
/**
 * 由 unicode 字符或含义文本反查 type+id。
 * 优先按 unicode 匹配；未命中再按文本匹配（取首个跨类型结果）。
 * @param {string} unicodeOrText
 * @returns {{type:EmojiType,id:number}|null}
 */
export function toId(unicodeOrText) {
  const byU = getByUnicode(unicodeOrText);
  if (byU) return { type: byU.type, id: byU.id };
  const byT = getByText(unicodeOrText);
  if (byT) {
    const hit = Array.isArray(byT) ? byT[0] : byT;
    return { type: hit.type, id: hit.id };
  }
  return null;
}

// ——————————————————————————— 与 QQ 消息元素互转 ———————————————————————————

/**
 * 将记录转为 qq-official-bot 的消息片段元素。
 * - type 1 → { type: 'face',  id }
 * - type 2 → { type: 'emoji', id }（id 即 Unicode 码点）
 * @param {EmojiType} type
 * @param {number} id
 * @returns {QQEmojiElement|null}
 */
export function toQQElement(type, id) {
  const e = getEmoji(type, id);
  if (!e) return null;
  return { type: e.type === EMOJI_TYPES.FACE ? 'face' : 'emoji', id: e.id };
}

/**
 * 由 qq-official-bot 消息片段元素反查记录。
 * 兼容三类元素：
 *   - 普通小黄脸 { type:'face',  id:N }             → EmojiRecord
 *   - 普通 Emoji  { type:'emoji', id:codepoint }     → EmojiRecord
 *   - 商城表情     { type:'face', id:'', ext:base64 } → MallEmojiRecord
 *     （ext 为 base64(JSON)，解码得 { text:'表情描述' }，无标准 ID/Unicode）
 * @param {QQEmojiElement} el
 * @returns {EmojiRecord|MallEmojiRecord|null}
 */
export function fromQQElement(el) {
  if (!el || typeof el.type !== 'string') return null;
  // 商城表情：face 但 id 为空且携带 ext
  if (el.type === 'face' && (el.id === '' || el.id == null) && typeof el.ext === 'string') {
    return decodeFaceExt(el.ext);
  }
  if (typeof el.id !== 'number') return null;
  const type = el.type === 'face' ? EMOJI_TYPES.FACE : el.type === 'emoji' ? EMOJI_TYPES.EMOJI : undefined;
  return type === undefined ? null : getEmoji(type, el.id);
}

/**
 * 解码商城表情的 ext 字段（base64 → JSON → { text }）。
 * 解码失败时仍返回商城表情记录，text 置 null（保留原始 ext 供排查）。
 * @param {string} ext base64 编码的 JSON 文本
 * @returns {MallEmojiRecord}
 */
export function decodeFaceExt(ext) {
  let text = "";
  try {
    const json = JSON.parse(Buffer.from(ext, 'base64').toString('utf8'));
    if (json && typeof json.text === 'string') text = json.text.trim();
    // 处理特定包含符
    if (text.startsWith('[')) text = text.slice(1);
    if (text.endsWith(']')) text = text.slice(-1);
  } catch {
    // 解码失败：text 设为 null
    text = null;
  }
  return {
    type: EMOJI_TYPES.FACE,
    id: '',
    text,
    unicode: null,
    typeName: TYPE_NAMES[EMOJI_TYPES.FACE],
    mall: true,
    ext,
  };
}

// ——————————————————————————— 导出 ———————————————————————————

/** 只读的全部内置数据快照（不含运行时注册项） */
export const EMOJI_DATA = Object.freeze(EMOJI_BASE.map((e) => ({ ...e })));

/**
 * 当前全部记录（含运行时注册项），用于遍历/调试。
 * @returns {EmojiRecord[]}
 */
export function listAll() {
  return [..._store.values()].map((e) => ({ ...e }));
}
