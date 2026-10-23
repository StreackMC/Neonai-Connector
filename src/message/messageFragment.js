import { parseString } from "../utils/chore.js";
import { NeonaicTable } from "../utils/math.js";
import { NeonaicNewable } from "../utils/NeonaicNewableClass.js";
import { NeonaicIllegalArgumentError } from "../utils/NeonaicNewableError.js";
import { NeonaicUriMeta } from "../utils/NeonaicUriMeta.js";

/** base64 形式的 data URL，第一个捕获组是 MIME */
const BASE64_DATA_URL_RE = /^data:([^;,]*);base64,/i;
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export class NeonaicMessage extends NeonaicNewable {
  /** @type {NeonaicMessageFragment[]} */
  #frag = [];

  /**
   * @param {NeonaicMessage|NeonaicMessageFragment|NeonaicMessageFragment[]|string|string[]} [msg] 消息内容；留空时创建空消息
   * @throws {NeonaicIllegalArgumentError} 参数不合法
   */
  constructor(msg) {
    super();
    if (msg === undefined || msg === null) return;
    if (msg instanceof NeonaicMessage) {
      this.#frag = msg.#frag.slice(0);
    } else if (Array.isArray(msg)) {
      this.#frag = msg.map((element) => {
        if (element instanceof NeonaicMessageFragment) {
          return element;
        } else if (typeof element === "string") {
          return new NeonaicTextMsgFrag(element);
        }
        throw new NeonaicIllegalArgumentError("Array elements must be NeonaicMessageFragment or string");
      });
    } else if (msg instanceof NeonaicMessageFragment) {
      this.#frag = [msg];
    } else if (typeof msg === "string") {
      this.#frag = [new NeonaicTextMsgFrag(msg)];
    } else {
      throw new NeonaicIllegalArgumentError("msg should be NeonaicMessage, NeonaicMessageFragment, array of NeonaicMessageFragment, or string");
    }
  }

  /** 获取全部消息片段的**原始引用** @type {NeonaicMessageFragment[]} */
  get fragments() { return this.#frag; }
  /**
   * 覆写消息片段
   * @param {NeonaicMessageFragment[]} value 目标参数片段，**自动获取副本并存入**
   * @throws {NeonaicIllegalArgumentError} 参数不合法
   */
  set fragments(value) {
    if (!Array.isArray(value) || value.some(v => !(v instanceof NeonaicMessageFragment))) throw new NeonaicIllegalArgumentError("fragments must be an array of NeonaicMessageFragment");
    this.#frag = value.slice(0);
  }

  /**
   * 追加消息片段
   * @param {NeonaicMessageFragment} fragment 消息片段
   * @throws {NeonaicIllegalArgumentError} 参数不合法
   */
  appendFragment(fragment) {
    if (!(fragment instanceof NeonaicMessageFragment)) throw new NeonaicIllegalArgumentError("fragment must be an instance of NeonaicMessageFragment");
    this.#frag.push(fragment);
  }

  /**
   * 遍历各消息片段
   * @param {(value: NeonaicMessageFragment, index: number, type: NeonaicTMessageFragmentTypes) => void} callback
   * @param {any} [thisArg] 可选的 this 值，默认为本实例
   * @returns {void}
   * @throws {NeonaicIllegalArgumentError} callback 不是函数
   */
  forEachFrag(callback, thisArg = this) {
    if (typeof callback !== "function") throw new NeonaicIllegalArgumentError("callback must be a function");
    this.#frag.forEach((value, index) => { callback.call(thisArg, value, index, value.TYPE); });
  }

  /**
   * 遍历各消息片段并返回新数组
   * @template T
   * @param {(value: NeonaicMessageFragment, index: number, type: NeonaicTMessageFragmentTypes) => T} callback
   * @param {any} [thisArg] 可选的 this 值，默认为本实例
   * @returns {T[]} 返回一个新数组，包含 callback 的返回值
   * @throws {NeonaicIllegalArgumentError} callback 不是函数
   */
  mapFrag(callback, thisArg = this) {
    if (typeof callback !== "function") throw new NeonaicIllegalArgumentError("callback must be a function");
    return this.#frag.map((value, index) => callback.call(thisArg, value, index, value.TYPE));
  }

  /**
   * 遍历各消息片段并返回新数组
   * @template T
   * @param {Partial<Record<NeonaicTMessageFragmentTypes, ((value: NeonaicMessageFragment, index: number, type: NeonaicTMessageFragmentTypes) => T|null|undefined)>>} override 传入处理器覆写方法。键名是一个消息片段类型，键值为处理函数时会将返回值作为对应数组元素，键值为 null 时将对应元素置为 null，键值为其他值时将使用默认的 markdown 输出。
   * @param {any} [thisArg] 可选的 this 值，默认为本实例
   * @returns {(T|string|null)[]|string[]} 返回一个新数组
   */
  markdown(override = null, thisArg = this) {
    // 语法糖先决判断
    if (override === null || typeof override !== "object") {
      return this.#frag.map((value) => value.markdown);
    }
    return this.#frag.map((value, index) => {
      const handler = override[value.TYPE];
      if (typeof handler === "function") {
        return handler.call(thisArg, value, index, value.TYPE);
      } else if (handler !== undefined) {
        return null;
      } else {
        return value.markdown;
      }
    });
  }

  /**
   * 把各片段直接拼成一段 markdown 文本
   * @param {Partial<Record<NeonaicTMessageFragmentTypes, ((value: NeonaicMessageFragment, index: number, type: NeonaicTMessageFragmentTypes) => string|null|undefined)>>} [override] 同 {@link NeonaicMessage#markdown}
   * @param {any} [thisArg] 可选的 this 值，默认为本实例
   * @returns {string}
   */
  toMarkdown(override = null, thisArg = this) {
    return this.markdown(override, thisArg)
      .map((value) => (value === null || value === undefined ? "" : parseString(value)))
      .join("");
  }

  toString() { return this.toMarkdown(); }
}

/** @apiNote 原始类型，需继承使用 */
export class NeonaicMessageFragment extends NeonaicNewable {
  get TYPE() { return 'raw-fragment'; }
  toString() { return this.markdown; }
  get markdown() { return ""; }

  constructor() {
    if (new.target === NeonaicMessageFragment) throw new NeonaicIllegalArgumentError("NeonaicMessageFragment is an abstract class and cannot be instantiated directly.");
    super();
  }
}

/** @typedef {'raw-fragment'|'text'|'br'|'image'|'video'|'audio'|'link'|'emoji'|'table'} NeonaicTMessageFragmentTypes Neonai Connector 内置的消息片段类型 */

/** 表示一个文本消息片段 */
export class NeonaicTextMsgFrag extends NeonaicMessageFragment {
  #payload = {};

  /** @returns {NeonaicTMessageFragmentTypes} */
  get TYPE() { return 'text'; }
  toString() { return this.markdown; }
  get markdown() {
    let text = this.#payload.text;
    if (this.#payload.style.code) {
      if (text.includes("\n")) {
        // 多行
        return `\`\`\`${this.#payload.style.codeType || ''}\n${text}\n\`\`\``;
      } else {
        // 单行，需要解析原文本
        /* 先算出连续反引号的最大数量 */
        let max = 0;
        let cur = 0;
        for (let i = 0; i < text.length; i++) {
          if (text[i] === "`") {
            cur++;
            if (cur > max) max = cur;
          } else {
            cur = 0;
          }
        }
        const backticks = "`".repeat(max + 1);
        /* 接着判开头结尾是否有反引号 */
        const space = text.startsWith("`") || text.endsWith("`") ? " " : "";
        /* 最后构造 */
        return backticks + space + text + space + backticks;
      }
    }
    if (this.#payload.style.color) {
      text = `<span style="color:${this.#payload.style.color}">${text}</span>`;
    }
    if (this.#payload.style.bold) {
      text = `**${text}**`;
    }
    if (this.#payload.style.italic) {
      text = `*${text}*`;
    }
    if (this.#payload.style.underline) {
      text = `<u>${text}</u>`;
    }
    if (this.#payload.style.strikethrough) {
      text = `~~${text}~~`;
    }
    return text;
  }
  /** @returns {string|null} */
  get color() { return this.#payload.style.color; }
  /** @returns {boolean} */
  get bold() { return this.#payload.style.bold; }
  /** @returns {boolean} */
  get italic() { return this.#payload.style.italic; }
  /** @returns {boolean} */
  get underline() { return this.#payload.style.underline; }
  /** @returns {boolean} */
  get strikethrough() { return this.#payload.style.strikethrough; }
  /** @returns {boolean} */
  get code() { return this.#payload.style.code; }
  /** @returns {string|null} */
  get codeType() { return this.#payload.style.codeType; }

  /**
   * @param {any} payload 文本消息，将自动化为文本
   * @param {Object} style 文本样式
   * @param {string} [style.color=null] 文本颜色，需为 HEX 代码，否则回退未设置
   * @param {boolean} [style.bold=false] 是否加粗
   * @param {boolean} [style.italic=false] 是否斜体
   * @param {boolean} [style.underline=false] 是否下划线
   * @param {boolean} [style.strikethrough=false] 是否删除线
   * @param {boolean} [style.code=false] 是否代码块，注意设为代码块后其余样式可被访问，但内置导出方法将忽略样式
   * @param {string} [style.codeType=null] 代码块类型，用于指定代码块的语言，需要 code=true 才会生效
   */
  constructor(payload, style = {}) {
    super();
    this.#payload = {
      text: parseString(payload),
      style: {
        color: style.color && HEX_COLOR_RE.test(style.color) ? style.color : null,
        bold: !!style.bold,
        italic: !!style.italic,
        underline: !!style.underline,
        strikethrough: !!style.strikethrough,
        code: !!style.code,
        codeType: style.code && style.codeType && typeof style.codeType === "string" ? style.codeType : null,
      }
    };
  }
}

/** 表示一个换行片段 */
export class NeonaicBrMsgFrag extends NeonaicTextMsgFrag {
  /** @returns {NeonaicTMessageFragmentTypes} */
  get TYPE() { return 'br'; }

  constructor() {
    super('\n', {});
  }
}

/** 表示一个链接片段 */
export class NeonaicLinkMsgFrag extends NeonaicMessageFragment {
  #payload = {};

  /** @returns {NeonaicTMessageFragmentTypes} */
  get TYPE() { return 'link'; }
  /** @returns {NeonaicUriMeta} */
  get uri() { return this.#payload.uri; }
  /** @returns {NeonaicTextMsgFrag} */
  get description() { return this.#payload.description; }
  /** @returns {NeonaicTextMsgFrag} */
  get alt() { return this.#payload.alt; }
  toString() { return this.markdown; }
  get markdown() {
    const url = escapeMarkdownUrl(this.#payload.uri.toString()) + this.alt ? ` "${escapeMarkdownTitle(this.alt.markdown)}"` : "";
    // 描述文本里的 [ ] \ 会打断链接语法，必须转义；空描述退回显示 URL 本身
    const label = escapeMarkdownAlt(this.#payload.description.markdown) || url;
    return `[${label}](${url})`;
  }

  /**
   * @param {string|URL|NeonaicUriMeta} url 链接指向
   * @param {String|NeonaicTextMsgFrag} desc 显示的文本
   * @param {String|NeonaicTextMsgFrag} alt 鼠标指向显示的描述文本
   * @throws {NeonaicIllegalArgumentError}
  */
  constructor(url, desc, alt) {
    super();
    if (!url) throw new NeonaicIllegalArgumentError("url must be a string, URL, or NeonaicUriMeta");
    let uri;
    try {
      uri = url instanceof NeonaicUriMeta ? url : NeonaicUriMeta.resolve(url, {});
    } catch (error) {
      throw new NeonaicIllegalArgumentError(`invalid url: ${parseString(url)}`);
    }
    this.#payload = { uri, description: desc instanceof NeonaicTextMsgFrag ? desc : new NeonaicTextMsgFrag(desc), alt: alt instanceof NeonaicTextMsgFrag ? alt : new NeonaicTextMsgFrag(alt) };
  }
}

/**
 * 表示一个表情片段。
 *
 * 支持三种形态，导出优先级为「Unicode 字符 → 自定义图片 → 短代码」：
 *   - `new NeonaicEmojiMsgFrag('😄')` → `😄`
 *   - `new NeonaicEmojiMsgFrag(':smile:', { url: 'https://example.com/smile.png' })` → `![smile](…)`
 *   - `new NeonaicEmojiMsgFrag('smile')` → `:smile:`
 */
export class NeonaicEmojiMsgFrag extends NeonaicMessageFragment {
  #payload = { name: null, unicode: null, url: null, alt: null };

  /** @returns {NeonaicTMessageFragmentTypes} */
  get TYPE() { return 'emoji'; }
  /** @returns {string} 短代码名称 */
  get name() { return this.#payload.name; }
  /** @returns {string|null} Unicode 表情字符 */
  get unicode() { return this.#payload.unicode; }
  /** @returns {string|null} 自定义表情图片地址 */
  get url() { return this.#payload.url; }
  /** @returns {string|null} 自定义表情的替代文本 */
  get alt() { return this.#payload.alt; }
  toString() { return this.markdown; }
  get markdown() {
    if (this.#payload.unicode) return this.#payload.unicode;
    if (this.#payload.url) {
      const alt = escapeMarkdownAlt(this.#payload.alt ?? this.#payload.name ?? '');
      return `![${alt}](${escapeMarkdownUrl(this.#payload.url)})`;
    }
    return `:${this.#payload.name}:`;
  }

  /**
   * @param {string} emoji Unicode 表情字符，或 `name` / `:name:` 形式的短代码
   * @param {object} [option] 选项
   * @param {string} [option.name] 显式指定短代码名称（用于自定义图片的替代文本）
   * @param {string|URL} [option.url] 自定义表情图片地址；给出时导出为图片
   * @param {string} [option.alt] 自定义表情图片的替代文本，默认取名称
   * @throws {NeonaicIllegalArgumentError} 参数不是合法的表情
   */
  constructor(emoji, option = {}) {
    super();
    if (typeof emoji !== 'string' || !emoji.trim()) {
      throw new NeonaicIllegalArgumentError('emoji must be a non-empty string');
    }
    if (option === null || typeof option !== 'object' || Array.isArray(option)) {
      throw new NeonaicIllegalArgumentError('option must be an object');
    }

    const text = emoji.trim();
    const shortcode = /^:([A-Za-z0-9_+-]+):$/.exec(text);
    let name = option.name ?? null;
    let unicode = null;

    if (shortcode) {
      name = shortcode[1];
    } else if (/[^\u0000-\u007f]/.test(text)) {
      // 含非 ASCII 字符时按 Unicode 表情处理（😄、👍🏽、🏳️‍🌈 都走这条）
      unicode = text;
      if (name === null) name = text;
    } else if (/^[A-Za-z0-9_+-]+$/.test(text)) {
      name = text;
    } else {
      throw new NeonaicIllegalArgumentError(`invalid emoji: ${text}`);
    }

    let url = option.url ?? null;
    if (url instanceof URL) url = url.href;
    if (url !== null && (typeof url !== 'string' || !url)) {
      throw new NeonaicIllegalArgumentError('option.url must be a non-empty string or URL');
    }
    if (option.alt !== undefined && typeof option.alt !== 'string') {
      throw new NeonaicIllegalArgumentError('option.alt must be a string');
    }

    this.#payload = { name, unicode, url, alt: option.alt ?? null };
  }
}

/** 表示一个表格片段 */
export class NeonaicTableMsgFrag extends NeonaicMessageFragment {
  #payload = {};

  /** @returns {NeonaicTMessageFragmentTypes} */
  get TYPE() { return 'table'; }
  /** @returns {NeonaicTable<string>} */
  get table() { return this.#payload.table; }
  toString() { return this.markdown; }
  get markdown() { return this.table.markdown; }

  /**
   * 新建或解析一个表格
   * @param {object[]|any[][]|string|NeonaicTable<string>} data 数据源
   * @param {'object-row'|'object-col'|'csv'|'array[]'|'markdown'} type 数据源类型
   * @param {object} [option] 配置
   * @param {number} [option.cols] 允许列数，不存在自动大小；小于实际列数时将被截断，大于时以空文本补齐
   * @param {string[]|undefined|null} [option.colTitle=null] 列标题
   * @param {number} [option.rows] 允许行数，不存在自动大小；小于实际行数时将被截断，大于时以空文本补齐
   * @param {string[]|undefined|null} [option.rowTitle=null] 行名称
   * @throws {NeonaicIllegalArgumentError} 数据源类型或数据格式不合法
   * @apiNote 类型为 csv 且未指定 colTitle 时，首行会被视为列标题。
   */
  constructor(data, type, option = {}) {
    super();
    // 必须指定 direction='cell'：默认的 'row' 会把整行数组当作一个值，parseString 后变成 "['a','b']"
    this.#payload = { table: new NeonaicTable(data, type, option).map((value) => parseString(value), 'cell') };
  }
}

/**
 * 媒体消息片段的公共基类（抽象）。
 *
 * 负责三件与具体媒体类型无关的事：
 *   1. 把 `Buffer | Blob | URL | Request | NeonaicUriMeta | string` 归一化成可嵌入的 URI
 *      （`Buffer` 转成 data URL，`Blob` 在浏览器里转成 object URL）；
 *   2. 记录 MIME 与是否为 data URL，并负责 object URL 的释放；
 *   3. 生成带 `src`、`title`、`aria-label` 与播放选项的 HTML 媒体标签。
 *
 * 子类通过静态字段声明自己的身份，并按需覆写 {@link NeonaicMediaMsgFrag#markdown}：
 *   - `NeonaicAudioMsgFrag` / `NeonaicVideoMsgFrag`：`KIND` + `TAG`，直接用基类的 `<audio>` / `<video>` 输出；
 *   - `NeonaicImageMsgFrag`：只声明 `KIND`，`markdown` 覆写为 `![alt](url)`。
 */
export class NeonaicMediaMsgFrag extends NeonaicMessageFragment {
  /** 媒体种类，子类必须覆写 @type {'image'|'audio'|'video'|null} */
  static KIND = null;
  /** HTML 媒体标签名；为 null 表示子类自行实现 markdown @type {string|null} */
  static TAG = null;

  #media = {
    uri: "", isBase64: false, mime: null, objectUrl: null,
    title: "", alt: "",
    controls: true, loop: false, muted: false, autoplay: false,
    preload: null, poster: null,
  };

  /** @returns {NeonaicTMessageFragmentTypes} */
  get TYPE() { return 'raw-fragment'; }
  /** @returns {'image'|'audio'|'video'|null} */
  get kind() { return this.constructor.KIND; }
  /** @returns {string} 可嵌入的 URI（data URL 或普通 URL） */
  get uri() { return this.#media.uri; }
  /** @returns {string} 同 {@link NeonaicMediaMsgFrag#uri}，便于与 HTML 的 src 对齐 */
  get src() { return this.#media.uri; }
  /** @returns {boolean} 是否为 base64 data URL */
  get isBase64() { return this.#media.isBase64; }
  /** @returns {string|null} MIME 类型（可能由 magic number 或扩展名推断） */
  get mime() { return this.#media.mime; }
  /** @returns {string} */
  get title() { return this.#media.title; }
  /** @returns {string} */
  get alt() { return this.#media.alt; }
  /** @returns {boolean} */
  get controls() { return this.#media.controls; }
  /** @returns {boolean} */
  get loop() { return this.#media.loop; }
  /** @returns {boolean} */
  get muted() { return this.#media.muted; }
  /** @returns {boolean} */
  get autoplay() { return this.#media.autoplay; }
  /** @returns {'none'|'metadata'|'auto'|null} */
  get preload() { return this.#media.preload; }
  /** @returns {string|null} */
  get poster() { return this.#media.poster; }

  toString() { return this.markdown; }
  /** 生成 HTML 媒体标签；没有声明 TAG 的子类（图片）应覆写本 getter */
  get markdown() {
    const tag = this.constructor.TAG;
    if (!tag) return "";
    const attrs = [`src="${escapeHtmlAttribute(this.#media.uri)}"`];
    // poster 只属于 video；audio 上写它是无效属性
    if (tag === 'video' && this.#media.poster) attrs.push(`poster="${escapeHtmlAttribute(this.#media.poster)}"`);
    if (this.#media.title) attrs.push(`title="${escapeHtmlAttribute(this.#media.title)}"`);
    if (this.#media.alt) attrs.push(`aria-label="${escapeHtmlAttribute(this.#media.alt)}"`);
    if (this.#media.controls) attrs.push('controls');
    if (this.#media.loop) attrs.push('loop');
    if (this.#media.muted) attrs.push('muted');
    if (this.#media.autoplay) attrs.push('autoplay');
    if (this.#media.preload) attrs.push(`preload="${this.#media.preload}"`);
    return `<${tag} ${attrs.join(' ')}></${tag}>`;
  }

  /**
   * 释放 Blob 分支创建的 object URL。不再使用本实例时请调用。
   */
  dispose() {
    if (this.#media.objectUrl !== null) {
      URL.revokeObjectURL(this.#media.objectUrl);
      this.#media.objectUrl = null;
    }
  }

  /**
   * Node / 浏览器通用的 Blob 构造入口（异步）。
   * 浏览器里也可以直接用 `new NeonaicXxxMsgFrag(blob)`，走 object URL 分支。
   * @param {Blob} blob
   * @param {NeonaicTMediaOptions|string} [options] 选项；传字符串时等价于 `{ title: options }`
   * @returns {Promise<NeonaicMediaMsgFrag>} 与调用者同类型的实例
   */
  static async fromBlob(blob, options = {}) {
    if (typeof blob?.arrayBuffer !== "function") {
      throw new NeonaicIllegalArgumentError("blob must have an arrayBuffer() method");
    }
    // 浏览器里没有 Buffer：直接交给构造函数走 object URL 分支
    if (typeof Buffer === "undefined") return new this(blob, options);
    const buf = Buffer.from(await blob.arrayBuffer());
    return new this(buf, options);
  }

  /**
   * @param {Buffer|Blob|URL|Request|NeonaicUriMeta|string} source 媒体来源；Buffer 会转成 data URL
   * @param {NeonaicTMediaOptions|string} [options] 选项；传字符串时等价于 `{ title: options }`
   * @param {string} [legacyAlt] 兼容旧签名：仅在 options 为字符串时作为替代文本
   * @throws {NeonaicIllegalArgumentError} 来源类型不支持，或选项不合法
   */
  constructor(source, options = {}, legacyAlt = "") {
    super();
    if (new.target === NeonaicMediaMsgFrag) {
      throw new NeonaicIllegalArgumentError("NeonaicMediaMsgFrag is an abstract class and cannot be instantiated directly.");
    }

    const kind = this.constructor.KIND;
    if (!kind) throw new NeonaicIllegalArgumentError(`${this.constructor.name} must declare a static KIND`);

    const opt = typeof options === "string"
      ? { title: options, alt: legacyAlt }
      : options;
    if (opt === null || typeof opt !== "object" || Array.isArray(opt)) {
      throw new NeonaicIllegalArgumentError("options must be an object or a title string");
    }
    const title = opt.title ?? "";
    const alt = opt.alt ?? "";
    if (typeof title !== "string" || typeof alt !== "string") {
      throw new NeonaicIllegalArgumentError("title and alt must be strings");
    }
    const preload = opt.preload ?? null;
    if (preload !== null && !['none', 'metadata', 'auto'].includes(preload)) {
      throw new NeonaicIllegalArgumentError(`preload must be one of none, metadata, auto: ${parseString(preload)}`);
    }
    let poster = opt.poster ?? null;
    if (poster instanceof URL) poster = poster.href;
    if (poster !== null && (typeof poster !== "string" || !poster)) {
      throw new NeonaicIllegalArgumentError("poster must be a non-empty string or URL");
    }

    this.#media = {
      ...resolveMediaSource(source, kind),
      title,
      alt,
      controls: opt.controls === undefined ? true : !!opt.controls,
      loop: !!opt.loop,
      muted: !!opt.muted,
      autoplay: !!opt.autoplay,
      preload,
      poster,
    };
  }
}

/**
 * @typedef {Object} NeonaicTMediaOptions 媒体片段选项
 * @property {string} [title=""] 标题，导出为 HTML 的 `title` 属性
 * @property {string} [alt=""] 替代文本，导出为 HTML 的 `aria-label`（图片用作 `![alt]`）
 * @property {boolean} [controls=true] 是否显示播放控件（audio/video）
 * @property {boolean} [loop=false] 是否循环播放
 * @property {boolean} [muted=false] 是否默认静音
 * @property {boolean} [autoplay=false] 是否自动播放
 * @property {'none'|'metadata'|'auto'} [preload=null] 预加载策略；null 表示不写该属性
 * @property {string|URL} [poster=null] 视频封面（仅 video 使用）
 */

/** 图片消息片段 */
export class NeonaicImageMsgFrag extends NeonaicMediaMsgFrag {
  static KIND = "image";

  /** @returns {NeonaicTMessageFragmentTypes} */
  get TYPE() { return 'image'; }

  toString() { return this.markdown; }
  get markdown() {
    const alt = escapeMarkdownAlt(this.alt);
    const title = this.title
      ? ` "${escapeMarkdownTitle(this.title)}"`
      : "";
    const url = escapeMarkdownUrl(this.src);
    return `![${alt}](${url}${title})`;
  }

  /**
   * 返回图片数据
   * @returns {{isBase64: boolean, payload: string}} payload 是 data URL 或普通 URL
   */
  get image() {
    return {
      isBase64: this.isBase64,
      payload: this.src,
    };
  }

  /**
   * @param {Buffer|Blob|URL|Request|NeonaicUriMeta|string} img 传入图片
   * @param {NeonaicTMediaOptions|string} [options] 选项；传字符串时作为图片标题
   * @param {string} [alt] 兼容旧签名：仅在 options 为字符串时作为替代描述
   */
  constructor(img, options = {}, alt = "") {
    super(img, options, alt);
  }
}

/** 音频消息片段。markdown 输出为 `<audio>` 标签。 */
export class NeonaicAudioMsgFrag extends NeonaicMediaMsgFrag {
  static KIND = "audio";
  static TAG = "audio";

  /** @returns {NeonaicTMessageFragmentTypes} */
  get TYPE() { return 'audio'; }

  /**
   * @param {Buffer|Blob|URL|Request|NeonaicUriMeta|string} audio 音频来源；Buffer 会按 magic number 推断 MIME
   * @param {NeonaicTMediaOptions|string} [options] 选项；传字符串时作为标题
   * @param {string} [alt] 兼容旧签名：仅在 options 为字符串时作为替代文本
   */
  constructor(audio, options = {}, alt = "") {
    super(audio, options, alt);
  }
}

/** 视频消息片段。markdown 输出为 `<video>` 标签。 */
export class NeonaicVideoMsgFrag extends NeonaicMediaMsgFrag {
  static KIND = "video";
  static TAG = "video";

  /** @returns {NeonaicTMessageFragmentTypes} */
  get TYPE() { return 'video'; }

  /**
   * @param {Buffer|Blob|URL|Request|NeonaicUriMeta|string} video 视频来源；Buffer 会按 magic number 推断 MIME
   * @param {NeonaicTMediaOptions|string} [options] 选项；传字符串时作为标题
   * @param {string} [legacyAlt] 兼容旧签名：仅在 options 为字符串时作为替代文本
   */
  constructor(video, options = {}, legacyAlt = "") {
    super(video, options, legacyAlt);
  }
}

/* ---------- 工具函数 ---------- */

/**
 * 把媒体来源归一化成可嵌入的 URI。
 * @param {Buffer|Blob|URL|Request|NeonaicUriMeta|string} source 媒体来源
 * @param {'image'|'audio'|'video'} kind 媒体种类，用于限制 Buffer 的 MIME 推断
 * @returns {{uri: string, isBase64: boolean, mime: string|null, objectUrl: string|null}}
 * @throws {NeonaicIllegalArgumentError} 来源类型不支持
 */
function resolveMediaSource(source, kind) {
  if (typeof source === "string") {
    if (!source.trim()) throw new NeonaicIllegalArgumentError("media source must not be empty");
    const base64 = source.match(BASE64_DATA_URL_RE);
    if (base64) {
      return { uri: source, isBase64: true, mime: base64[1] || null, objectUrl: null };
    }
    const dataUrl = /^data:([^;,]*)/i.exec(source);
    if (dataUrl) {
      // 非 base64 的 data URL：原样保留，但 isBase64 为 false
      return { uri: source, isBase64: false, mime: dataUrl[1] || null, objectUrl: null };
    }
    return { uri: source, isBase64: false, mime: mimeFromPath(source), objectUrl: null };
  }

  if (typeof Buffer !== "undefined" && Buffer.isBuffer(source)) {
    if (source.length === 0) throw new NeonaicIllegalArgumentError("media buffer must not be empty");
    const mime = detectMediaMimeType(source, kind) || "application/octet-stream";
    return { uri: `data:${mime};base64,${source.toString("base64")}`, isBase64: true, mime, objectUrl: null };
  }

  if (source instanceof URL) {
    return { uri: source.href, isBase64: false, mime: mimeFromPath(source.pathname), objectUrl: null };
  }

  if (source instanceof NeonaicUriMeta) {
    const uri = source.toString();
    return { uri, isBase64: false, mime: mimeFromPath(uri), objectUrl: null };
  }

  if (typeof Blob !== "undefined" && source instanceof Blob) {
    // Node 里 URL.createObjectURL 生成的 blob:nodedata: URL 无法被 Markdown 渲染器使用
    const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";
    if (!isBrowser) {
      throw new NeonaicIllegalArgumentError(
        "Blob input is not usable in this environment; " +
        "use fromBlob() or convert to Buffer first"
      );
    }
    const objectUrl = URL.createObjectURL(source);
    return { uri: objectUrl, isBase64: false, mime: source.type || null, objectUrl };
  }

  if (typeof Request !== "undefined" && source instanceof Request) {
    const header = source.headers?.get?.("content-type")?.split(";")[0]?.trim();
    return { uri: source.url, isBase64: false, mime: header || mimeFromPath(source.url), objectUrl: null };
  }

  throw new NeonaicIllegalArgumentError("media source must be a string, Buffer, Blob, URL, Request, or NeonaicUriMeta");
}

// Markdown 的 alt 文本里 `\` `[` `]` 必须转义
function escapeMarkdownAlt(text) {
  return text.replace(/([\\\[\]])/g, "\\$1");
}

// 链接 title 里 `\` `"` 必须转义
function escapeMarkdownTitle(text) {
  return text.replace(/([\\"])/g, "\\$1");
}

// 链接目标含空白时必须用 <> 包裹，且 <> 内部不能出现裸 < >
function escapeMarkdownUrl(url) {
  if (!/\s/.test(url)) return url;
  return `<${url.replace(/</g, "%3C").replace(/>/g, "%3E")}>`;
}

// HTML 属性值里 & " < > 必须转义（& 必须最先替换，否则会把后续实体再转一次）
function escapeHtmlAttribute(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// 读取 buffer 的一段 ASCII（越界时返回空串，便于组合判断）
function asciiSlice(buf, start, end) {
  return buf.length >= end ? buf.toString("latin1", start, end) : "";
}

/** 扩展名 → MIME 的兜底表 @type {Map<string, string>} */
const MEDIA_MIME_BY_EXTENSION = new Map([
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
  [".gif", "image/gif"], [".webp", "image/webp"], [".bmp", "image/bmp"], [".svg", "image/svg+xml"],
  [".mp3", "audio/mpeg"], [".wav", "audio/wav"], [".ogg", "audio/ogg"], [".oga", "audio/ogg"],
  [".flac", "audio/flac"], [".m4a", "audio/mp4"], [".aac", "audio/aac"],
  [".mid", "audio/midi"], [".midi", "audio/midi"],
  [".mp4", "video/mp4"], [".m4v", "video/mp4"], [".webm", "video/webm"], [".ogv", "video/ogg"],
  [".mov", "video/quicktime"], [".avi", "video/x-msvideo"], [".mkv", "video/x-matroska"],
]);

// 按扩展名推断 MIME（查询串与锚点先去掉）；推断不出时返回 null
function mimeFromPath(path) {
  const clean = parseString(path).split(/[?#]/)[0].toLowerCase();
  const dot = clean.lastIndexOf(".");
  if (dot < 0) return null;
  return MEDIA_MIME_BY_EXTENSION.get(clean.slice(dot)) ?? null;
}

/**
 * 按媒体种类从 magic number 推断 MIME。
 * @param {Buffer} buf 媒体字节
 * @param {'image'|'audio'|'video'} kind 媒体种类
 * @returns {string|null} 推断不出时为 null
 */
function detectMediaMimeType(buf, kind) {
  if (kind === "image") return detectImageMimeType(buf);
  if (kind === "audio") return detectAudioMimeType(buf);
  if (kind === "video") return detectVideoMimeType(buf);
  return null;
}

// 通过 magic number 探测图片 MIME，避免 data URL 全用 application/octet-stream
function detectImageMimeType(buf) {
  if (buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (buf.length >= 6 &&
    buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return "image/gif";
  }
  if (buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    return "image/webp";
  }
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return "image/bmp";
  }
  return null;
}

// 音频容器：MP3 / AAC / WAV / OGG / FLAC / MIDI / WebM / M4A
function detectAudioMimeType(buf) {
  if (asciiSlice(buf, 0, 3) === "ID3") return "audio/mpeg";
  if (buf.length >= 2 && buf[0] === 0xff) {
    // ADTS 的同步字是 0xFFF，MPEG 音频层帧是 0xFFE
    if (buf[1] === 0xf1 || buf[1] === 0xf9) return "audio/aac";
    if (buf[1] === 0xfb || buf[1] === 0xfa || buf[1] === 0xf3 || buf[1] === 0xf2) return "audio/mpeg";
  }
  if (asciiSlice(buf, 0, 4) === "RIFF" && asciiSlice(buf, 8, 12) === "WAVE") return "audio/wav";
  if (asciiSlice(buf, 0, 4) === "OggS") return "audio/ogg";
  if (asciiSlice(buf, 0, 4) === "fLaC") return "audio/flac";
  if (asciiSlice(buf, 0, 4) === "MThd") return "audio/midi";
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return "audio/webm";
  if (asciiSlice(buf, 4, 8) === "ftyp") {
    const brand = asciiSlice(buf, 8, 12);
    // 只有 M4A/M4B 是纯音频；isom/mp42 之类按容器当视频处理
    if (brand === "M4A " || brand === "M4B ") return "audio/mp4";
  }
  return null;
}

// 视频容器：MP4 / MOV / WebM-MKV / OGG / AVI
function detectVideoMimeType(buf) {
  if (asciiSlice(buf, 4, 8) === "ftyp") {
    return asciiSlice(buf, 8, 12) === "qt  " ? "video/quicktime" : "video/mp4";
  }
  if (asciiSlice(buf, 0, 4) === "RIFF" && asciiSlice(buf, 8, 12) === "AVI ") return "video/x-msvideo";
  if (asciiSlice(buf, 0, 4) === "OggS") return "video/ogg";
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return "video/webm";
  return null;
}
