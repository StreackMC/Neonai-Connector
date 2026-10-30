import { parseString } from "#src/utils/chore.js";
import { NeonaicTable } from "#src/utils/math.js";
import { NeonaicNewable } from "#src/utils/NeonaicNewableClass.js";
import { NeonaicIllegalArgumentError } from "#src/utils/NeonaicNewableError.js";
import { NeonaicUriMeta } from "#src/utils/NeonaicUriMeta.js";

/** base64 形式的 data URL，第一个捕获组是 MIME */
const BASE64_DATA_URL_RE = /^data:([^;,]*);base64,/i;
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * @typedef {NeonaicMessage|NeonaicMessageFragment|NeonaicMessageFragment[]|string|string[]} NeonaicTValidMessage 可被 {@link NeonaicMessage} 构造函数接受的消息类型，也即允许传递的消息负荷类型。
 */

/**
 * 「容器 → 允许嵌套的子片段类型」的 Markdown 嵌套约束。
 *
 * 值为 `null` 表示该容器**不限制**子片段类型（列表项、引用块在 Markdown 里确实可以
 * 放任意块级/行内内容）；未在此表登记的容器名视为编程错误。
 *
 * @apiNote 这里守的是**语法**而不是**语义**：例如 `at` 在链接文本里语法上只是普通字符，
 *          但渲染出来是一串无意义的 `@qUSR#…`，所以一并挡掉。
 * @type {Readonly<Record<string, readonly NeonaicTMessageFragmentTypes[]|null>>}
 */
const NESTING = Object.freeze({
  /**
   * 链接的显示文本（`[label](url)` 的 label）是**行内上下文**：
   * 允许文本、行内代码、表情、图片；不允许块级内容（代码块/表格/列表/引用/标题/
   * 分隔线/音视频），也不允许嵌套链接（Markdown 不允许链接套链接）。
   */
  'link': Object.freeze(['text', 'inline-code', 'emoji', 'image']),
  /**
   * 标题（`## text`）同样是**行内上下文**，但比链接多允许一种：链接本身。
   * 不允许块级内容与 `br`（换行会把标题截断成两行）。
   */
  'heading': Object.freeze(['text', 'inline-code', 'emoji', 'image', 'link']),
  /** 列表项：可放任意内容（含嵌套列表、代码块、引用…） */
  'list-item': null,
  /** 引用块：同上 */
  'blockquote': null,
  /** 复选框项：同上 */
  'checkbox': null,
});

export class NeonaicMessage extends NeonaicNewable {
  /** @type {NeonaicMessageFragment[]} */
  #frag = [];

  /**
   * @param {NeonaicTValidMessage} [msg] 消息内容；留空时创建空消息
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
   * @returns {(T|string|null)[]} 返回一个新数组
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
   *
   * @apiNote 拼接**不是**无脑 `join("")`：块级片段（代码块/表格/列表/引用/分隔线/音视频）
   *          必须独占行，因此与相邻内容之间会补一个空行。否则
   *          `文本 + 代码块` 会拼成 `说明```…`，渲染器会把整段当成一段普通文本。
   *          行内片段之间仍然零分隔拼接。
   * @param {Partial<Record<NeonaicTMessageFragmentTypes, ((value: NeonaicMessageFragment, index: number, type: NeonaicTMessageFragmentTypes) => string|null|undefined)>>} [override] 同 {@link NeonaicMessage#markdown}
   * @param {any} [thisArg] 可选的 this 值，默认为本实例
   * @returns {string}
   */
  toMarkdown(override = null, thisArg = this) {
    const rendered = this.markdown(override, thisArg);
    let out = "";
    let prevBlock = false;
    this.#frag.forEach((frag, index) => {
      const text = rendered[index] === null || rendered[index] === undefined
        ? ""
        : parseString(rendered[index]);
      // 空片段不参与分隔，否则会凭空多出空行
      if (!text) return;
      if (out && (frag.isBlock || prevBlock)) {
        // 先把已有的行尾换行归一，再补成恰好一个空行
        out = `${out.replace(/\n+$/, "")}\n\n`;
      }
      out += text;
      prevBlock = frag.isBlock;
    });
    return out;
  }

  toString() { return parseString(this.mapFrag(f => f.toString())); }
}

/** @apiNote 原始类型，需继承使用 */
export class NeonaicMessageFragment extends NeonaicNewable {
  /**
   * 该片段在 Markdown 中是否为**块级**内容（独占行，与相邻内容之间需要空行）。
   *
   * @apiNote 这不是装饰性标记：`NeonaicMessage.toMarkdown()` 按片段顺序直接拼接，
   *          块级片段若不加空行就会与上文黏成一行（`说明` + 代码块 → `说明```…`，
   *          整段语法失效）。行内片段（文本/换行/图片/链接/表情/行内代码/@）必须保持 false。
   */
  static BLOCK = false;

  get TYPE() { return 'raw-fragment'; }
  /** 是否为块级片段 @returns {boolean} */
  get isBlock() { return this.constructor.BLOCK === true; }
  toString() { return `${this.TYPE}:${this.markdown}`; }
  get markdown() { return ""; }

  constructor() {
    if (new.target === NeonaicMessageFragment) throw new NeonaicIllegalArgumentError("NeonaicMessageFragment is an abstract class and cannot be instantiated directly.");
    super();
  }
}

/** @typedef {'raw-fragment'|'text'|'br'|'image'|'video'|'audio'|'link'|'emoji'|'table'|'at'|'heading'|'ordered-list'|'unordered-list'|'code'|'inline-code'|'blockquote'|'divider'|'checkbox'} NeonaicTMessageFragmentTypes Neonai Connector 内置的消息片段类型 */

/** 表示一个文本消息片段 */
export class NeonaicTextMsgFrag extends NeonaicMessageFragment {
  #payload = {};

  /** @returns {NeonaicTMessageFragmentTypes} */
  get TYPE() { return 'text'; }
  toString() { return `${this.TYPE}:${this.markdown}`; }
  get markdown() {
    let text = this.#payload.text;
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

  /**
   * @param {any} payload 文本消息，将自动化为文本
   * @param {Object} style 文本样式
   * @param {string} [style.color=null] 文本颜色，需为 HEX 代码，否则回退未设置
   * @param {boolean} [style.bold=false] 是否加粗
   * @param {boolean} [style.italic=false] 是否斜体
   * @param {boolean} [style.underline=false] 是否下划线
   * @param {boolean} [style.strikethrough=false] 是否删除线
   */
  constructor(payload, style = {}) {
    super();
    // 片段对象传进来会被 parseString 静默变成 "text:xxx" 这种字符串，必须拦下
    assertPlainText(payload, 'text');
    this.#payload = {
      text: parseString(payload),
      style: {
        color: style.color && HEX_COLOR_RE.test(style.color) ? style.color : null,
        bold: !!style.bold,
        italic: !!style.italic,
        underline: !!style.underline,
        strikethrough: !!style.strikethrough,
      }
    };
  }
}

/** 表示一段代码 */
export class NeonaicCodeMsgFrag extends NeonaicMessageFragment {
  /** 代码块是块级内容 @returns {boolean} */
  static BLOCK = true;

  /** @returns {NeonaicTMessageFragmentTypes} */
  get TYPE() { return 'code'; }

  #payload = {};

  /** @returns {string} */
  get markdown() { return `\`\`\`${this.#payload.codeType || ''}\n${this.#payload.text}\n\`\`\``; }
  toString() { return `${this.TYPE}:${this.markdown}`; }

  constructor(code, type = null) {
    super();
    assertPlainText(code, 'code');
    this.#payload = {
      text: parseString(code),
      codeType: type && typeof type === "string" && !type.includes('`') ? type.trim() : null,
    };
  }
}

/** 表示一段行内代码 */
export class NeonaicInlineCodeMsgFrag extends NeonaicTextMsgFrag {
  /** @returns {NeonaicTMessageFragmentTypes} */
  get TYPE() { return 'inline-code'; }

  /**
   * @param {string} code 行内代码块将移除全部的换行
   */
  constructor(code) {
    const text = parseString(code).replace(/\r?\n/g, ' ');
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
    super(backticks + space + text + space + backticks);
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

/** 表示一个 @ 片段 */
export class NeonaicAtMsgFrag extends NeonaicMessageFragment {
  #payload;
  /** @returns {NeonaicTMessageFragmentTypes} */
  get TYPE() { return 'at'; }

  get target() { return this.#payload.target; }
  toString() { return `${this.TYPE}:${this.markdown}`; }
  get markdown() { return ` @${this.#payload.target} `; }

  constructor(target) {
    super();
    assertPlainText(target, 'at');
    this.#payload = { target: parseString(target) };
  }
}

/**
 * 表示一个链接片段。
 *
 * 显示文本是**行内上下文**：允许嵌套文本、行内代码、表情与图片
 * （`[![alt](img)](url)` 是合法 Markdown），但**不允许**块级内容
 * （代码块/表格/列表/引用/分隔线/音视频）与嵌套链接。
 */
export class NeonaicLinkMsgFrag extends NeonaicMessageFragment {
  #payload = {};

  /** @returns {NeonaicTMessageFragmentTypes} */
  get TYPE() { return 'link'; }
  /** @returns {NeonaicUriMeta} */
  get uri() { return this.#payload.uri; }
  /** 显示文本片段（已通过嵌套校验） @returns {NeonaicMessageFragment[]} */
  get description() { return this.#payload.description.slice(0); }
  /** 鼠标指向时显示的描述文本，只能是纯文本 @returns {NeonaicTextMsgFrag} */
  get alt() { return this.#payload.alt; }
  toString() { return `${this.TYPE}:${this.markdown}`; }
  get markdown() {
    // 注意优先级：原来的 `url + alt ? … : ""` 会先做字符串拼接再判真假，
    // 恒为真 ⇒ 链接目标被替换成 alt，URL 整个丢掉
    const target = escapeMarkdownUrl(this.#payload.uri.toString());
    const alt = this.#payload.alt?.markdown ?? "";
    const title = alt ? ` "${escapeMarkdownTitle(alt)}"` : "";
    // 只有纯文本需要转义 [ ] \；行内代码/表情/图片自带语法，转义反而把它们变成字面量。
    // 空描述退回显示 URL 本身
    const label = renderInlineFragments(this.#payload.description) || target;
    return `[${label}](${target}${title})`;
  }

  /**
   * @param {string|URL|NeonaicUriMeta} url 链接指向
   * @param {String|NeonaicMessageFragment|NeonaicMessageFragment[]} desc 显示的内容；可嵌套行内片段（文本/行内代码/表情/图片）
   * @param {String|NeonaicTextMsgFrag} alt 鼠标指向显示的描述文本，只能是纯文本
   * @throws {NeonaicIllegalArgumentError} URL 不合法，或显示文本/描述里出现了不允许嵌套的片段
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
    // 缺省必须落成空串：`parseString(undefined)` 得到的是字面量 "undefined"，
    // 会让 `[文本](url "undefined")` 这种畸形标题跑到输出里
    this.#payload = {
      uri,
      description: normalizeNestedFragments(desc, 'link'),
      // title 属性的值只能是纯文本：传片段会被 parseString 成 "image:![…]"，必须拒绝
      alt: requirePlainTextFrag(alt, 'link alt'),
    };
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
  toString() { return `${this.TYPE}:${this.markdown}`; }
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
  /** 表格是块级内容 @returns {boolean} */
  static BLOCK = true;

  #payload = {};

  /** @returns {NeonaicTMessageFragmentTypes} */
  get TYPE() { return 'table'; }
  /** @returns {NeonaicTable<string>} */
  get table() { return this.#payload.table; }
  toString() { return `${this.TYPE}:${this.markdown}`; }
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
    // 单元格在 Markdown 表格里只能是行内文本，塞片段会被 parseString 静默变成 "text:xxx"，必须拦下
    this.#payload = {
      table: new NeonaicTable(data, type, option).map((value) => {
        assertPlainText(value, 'table cell');
        return parseString(value);
      }, 'cell'),
    };
  }
}

/* ---------- 标题 ---------- */

/**
 * 标题片段（ATX 风格 `#` ～ `######`）。
 *
 * 内容只能是**行内**片段：文本、行内代码、表情、图片、链接。
 * 块级内容（列表/代码块/表格…）与 `br` 都会被拒绝——它们会把标题行截断。
 *
 * @example
 * new NeonaicHeadingMsgFrag('第一章', 2)              // → `## 第一章`
 * new NeonaicHeadingMsgFrag([                        // → `### 见 [文档](https://e.com/doc)`
 *   '见 ', new NeonaicLinkMsgFrag('https://e.com/doc', '文档'),
 * ], 3)
 */
export class NeonaicHeadingMsgFrag extends NeonaicMessageFragment {
  static BLOCK = true;

  /** 允许的标题层级 @type {ReadonlyArray<number>} */
  static LEVELS = Object.freeze([1, 2, 3, 4, 5, 6]);

  #payload = { level: 1, content: [] };

  /** @returns {NeonaicTMessageFragmentTypes} */
  get TYPE() { return 'heading'; }
  /** 标题层级 1–6 @returns {number} */
  get level() { return this.#payload.level; }
  /** 标题内容片段 @returns {NeonaicMessageFragment[]} */
  get content() { return this.#payload.content.slice(0); }
  toString() { return `${this.TYPE}:${this.markdown}`; }
  get markdown() {
    const hashes = '#'.repeat(this.#payload.level);
    // 换行会把标题截成两行：折叠成空格（与行内代码的处理一致）
    const text = renderInlineFragments(this.#payload.content).replace(/\r?\n/g, ' ');
    // 空标题输出 `##`（CommonMark 允许 `#` 后直接换行），避免留下孤零零的尾随空格
    return text ? `${hashes} ${text}` : hashes;
  }

  /**
   * @param {NeonaicTValidMessage} content 标题内容；只能是行内片段
   * @param {number} [level=1] 标题层级，1–6
   * @throws {NeonaicIllegalArgumentError} 层级不合法，或内容里出现了不允许嵌套的片段
   */
  constructor(content, level = 1) {
    super();
    if (!NeonaicHeadingMsgFrag.LEVELS.includes(level)) {
      throw new NeonaicIllegalArgumentError(
        `heading level must be one of ${NeonaicHeadingMsgFrag.LEVELS.join(', ')}: ${parseString(level)}`,
      );
    }
    const fragments = normalizeNestedFragments(content, 'heading');
    this.#payload = { level, content: fragments };
  }
}

/* ---------- 列表 / 引用 / 分隔线 ---------- */

/**
 * 有序列表片段。
 *
 * @apiNote 列表项用 `NeonaicMessageFragment[][]` 表达（每项一个片段数组），
 *          内部会归一化成子消息：这样「一项多段落 / 嵌套列表 / 代码块」都能正确缩进，
 *          而调用方又不必手工 `new NeonaicMessage(...)`。单项也可直接传字符串或单个片段。
 */
export class NeonaicOrderedListMsgFrag extends NeonaicMessageFragment {
  static BLOCK = true;

  /** @type {NeonaicMessage[]} */
  #items = [];
  /** @type {number} */
  #start = 1;

  /** @returns {NeonaicTMessageFragmentTypes} */
  get TYPE() { return 'ordered-list'; }
  /** 各列表项（每项是一条子消息） @returns {NeonaicMessage[]} */
  get items() { return this.#items.slice(0); }
  /** 起始序号 @returns {number} */
  get start() { return this.#start; }
  toString() { return `${this.TYPE}:${this.markdown}`; }

  get markdown() {
    return renderListItems(this.#items.map((message, index) => ({
      marker: `${this.#start + index}. `,
      message,
    })));
  }

  /**
   * @param {NeonaicTValidMessage[]} items 各列表项
   * @param {object} [option] 选项
   * @param {number} [option.start=1] 起始序号
   * @throws {NeonaicIllegalArgumentError} items 不是数组/为空，或序号不合法
   */
  constructor(items, option = {}) {
    super();
    if (option === null || typeof option !== "object" || Array.isArray(option)) {
      throw new NeonaicIllegalArgumentError("option must be an object");
    }
    const start = option.start ?? 1;
    if (!Number.isInteger(start) || start < 0) {
      throw new NeonaicIllegalArgumentError(`option.start must be a non-negative integer: ${parseString(start)}`);
    }
    this.#start = start;
    this.#items = normalizeListItems(items, 'list-item', 'ordered-list');
  }
}

/**
 * 无序列表片段。列表项的表示方式同 {@link NeonaicOrderedListMsgFrag}。
 */
export class NeonaicUnorderedListMsgFrag extends NeonaicMessageFragment {
  static BLOCK = true;

  /** @type {NeonaicMessage[]} */
  #items = [];

  /** @returns {NeonaicTMessageFragmentTypes} */
  get TYPE() { return 'unordered-list'; }
  /** 各列表项（每项是一条子消息） @returns {NeonaicMessage[]} */
  get items() { return this.#items.slice(0); }
  toString() { return `${this.TYPE}:${this.markdown}`; }

  get markdown() {
    return renderListItems(this.#items.map((message) => ({ marker: '- ', message })));
  }

  /**
   * @param {NeonaicTValidMessage[]} items 各列表项
   * @throws {NeonaicIllegalArgumentError} items 不是数组或为空
   */
  constructor(items) {
    super();
    this.#items = normalizeListItems(items, 'list-item', 'unordered-list');
  }
}

/**
 * 复选框列表片段（任务列表）。
 *
 * @apiNote 之所以做成「一组条目」而不是单个条目：Markdown 里相邻两个复选框必须落在
 *          同一个列表块内，若各自成块，`toMarkdown` 会在它们之间补空行，
 *          列表就变成松散列表（每项外面包一层 `<p>`），视觉上多出空隙。
 * @example
 * new NeonaicCheckboxMsgFrag([
 *   { checked: true, content: '已完成' },
 *   { checked: false, content: ['待办：', new NeonaicLinkMsgFrag('https://example.com', '示例')] },
 * ]);
 */
export class NeonaicCheckboxMsgFrag extends NeonaicMessageFragment {
  static BLOCK = true;

  /** @type {Array<{checked: boolean, message: NeonaicMessage}>} */
  #items = [];

  /** @returns {NeonaicTMessageFragmentTypes} */
  get TYPE() { return 'checkbox'; }
  /** 各条目的勾选状态与内容 @returns {Array<{checked: boolean, message: NeonaicMessage}>} */
  get items() { return this.#items.map(({ checked, message }) => ({ checked, message })); }
  toString() { return `${this.TYPE}:${this.markdown}`; }

  get markdown() {
    return renderListItems(this.#items.map(({ checked, message }) => ({
      marker: checked ? '- [x] ' : '- [ ] ',
      message,
    })));
  }

  /**
   * @param {Array<{checked: boolean, content: NeonaicTValidMessage}>|{checked: boolean, content: NeonaicTValidMessage}} items 条目；单个条目对象也可
   * @throws {NeonaicIllegalArgumentError} 条目格式不合法
   */
  constructor(items) {
    super();
    const list = Array.isArray(items) ? items : [items];
    if (!list.length) throw new NeonaicIllegalArgumentError("checkbox items must not be empty");
    this.#items = list.map((item, index) => {
      const label = `第 ${index + 1} 个复选框`;
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        throw new NeonaicIllegalArgumentError(`${label}必须是 { checked, content } 对象`);
      }
      if (typeof item.checked !== "boolean") {
        throw new NeonaicIllegalArgumentError(`${label}的 checked 必须是布尔值`);
      }
      return {
        checked: item.checked,
        message: normalizeMessage(item.content, 'checkbox', `${label}的内容`),
      };
    });
  }
}

/**
 * 引用块片段。
 *
 * 块内可放任意内容（段落、列表、代码块，甚至嵌套引用）：
 * 渲染时逐行加 `> ` 前缀，嵌套引用会自然变成 `> > …`。
 */
export class NeonaicBlockquoteMsgFrag extends NeonaicMessageFragment {
  static BLOCK = true;

  /** @type {NeonaicMessage} */
  #message = null;

  /** @returns {NeonaicTMessageFragmentTypes} */
  get TYPE() { return 'blockquote'; }
  /** 引用内容 @returns {NeonaicMessage} */
  get content() { return this.#message; }
  toString() { return `${this.TYPE}:${this.markdown}`; }

  get markdown() {
    const body = this.#message.toMarkdown();
    // 空引用也要留一个 `>`，否则整段引用会凭空消失
    if (!body) return '>';
    return body.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n');
  }

  /**
   * @param {NeonaicTValidMessage} content 引用内容
   * @throws {NeonaicIllegalArgumentError} 内容不合法
   */
  constructor(content) {
    super();
    this.#message = normalizeMessage(content, 'blockquote');
  }
}

/**
 * 分隔线片段。
 *
 * @apiNote 用 `---`（而非 `***`）：在 `toMarkdown` 里它被当作块级片段处理，
 *          前面一定会有空行，因此不会触发「上一行被当成 setext 标题」的歧义。
 */
export class NeonaicDividerMsgFrag extends NeonaicMessageFragment {
  static BLOCK = true;

  /** @returns {NeonaicTMessageFragmentTypes} */
  get TYPE() { return 'divider'; }
  toString() { return `${this.TYPE}:${this.markdown}`; }
  get markdown() { return '---'; }
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

  toString() { return `${this.TYPE}:${this.markdown}`; }
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

  toString() { return `${this.TYPE}:${this.markdown}`; }
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
  /** `<audio>` 是块级 HTML，独占行 */
  static BLOCK = true;

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
  /** `<video>` 是块级 HTML，独占行；也因此**不能**嵌进链接文本 */
  static BLOCK = true;

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
 * 渲染一段**行内**内容的 markdown（链接 label、标题共用）。
 *
 * @apiNote 只对 `text` 片段转义 `[ ] \`：行内代码、表情、图片自带语法，
 *          一律转义会把 `![alt](url)` 变成字面量（等于图片进不了链接/标题）。
 * @param {NeonaicMessageFragment[]} fragments 已通过嵌套校验的行内片段
 * @returns {string}
 */
function renderInlineFragments(fragments) {
  return fragments
    .map((frag) => {
      const text = frag.markdown;
      return frag.TYPE === 'text' ? escapeMarkdownAlt(text) : text;
    })
    .join("");
}

/**
 * 校验某个片段能否嵌进指定容器。
 * @param {string} container {@link NESTING} 里的容器名
 * @param {NeonaicMessageFragment} fragment 待校验的子片段
 * @returns {void}
 * @throws {NeonaicIllegalArgumentError} 容器未知，或该片段不允许出现在此位置
 */
function assertNestable(container, fragment) {
  if (!(fragment instanceof NeonaicMessageFragment)) {
    throw new NeonaicIllegalArgumentError(`“${container}”只能嵌套消息片段`);
  }
  if (!Object.hasOwn(NESTING, container)) {
    throw new NeonaicIllegalArgumentError(`未知的嵌套容器：${container}`);
  }
  // 基类的 TYPE 是 raw-fragment；子类忘记覆写 TYPE 时，它在下游会被当成未知类型
  if (fragment.TYPE === 'raw-fragment') {
    throw new NeonaicIllegalArgumentError(
      "不能嵌套未声明 TYPE 的片段（继承 NeonaicMessageFragment 时必须覆写 TYPE）",
    );
  }
  const allowed = NESTING[container];
  if (allowed === null) return; // 不限制
  if (!allowed.includes(fragment.TYPE)) {
    throw new NeonaicIllegalArgumentError(
      `“${container}”不能嵌套“${fragment.TYPE}”片段：Markdown 在该位置只允许 ${allowed.join(' / ')}`,
    );
  }
}

/**
 * 拦下「本该是纯文本、却传了片段」的入参。
 *
 * @apiNote 不拦的话 `parseString(fragment)` 会走 `toString()`，静默得到
 *          `"image:![alt](url)"` 这种字符串，错误直到渲染时才显现。
 * @param {*} value 待检查的值
 * @param {string} label 出错时指代该位置的名字
 * @returns {void}
 * @throws {NeonaicIllegalArgumentError} 传入了消息或片段
 */
function assertPlainText(value, label) {
  if (value instanceof NeonaicMessageFragment) {
    throw new NeonaicIllegalArgumentError(`${label} 只能是纯文本，不能嵌套“${value.TYPE}”片段`);
  }
  if (value instanceof NeonaicMessage) {
    throw new NeonaicIllegalArgumentError(`${label} 只能是纯文本，不能嵌入整条消息`);
  }
}

/**
 * 规范化「只能是纯文本片段」的位置（如链接 title）。
 * @param {string|NeonaicTextMsgFrag|null|undefined} value 纯文本或纯文本片段
 * @param {string} label 出错时指代该位置的名字
 * @returns {NeonaicTextMsgFrag}
 * @throws {NeonaicIllegalArgumentError} 类型不合法
 */
function requirePlainTextFrag(value, label) {
  if (value === undefined || value === null) return new NeonaicTextMsgFrag("");
  if (value instanceof NeonaicTextMsgFrag) {
    // br / inline-code 也继承自 TextMsgFrag，但它们不是「纯文本」语义
    if (value.TYPE !== 'text') {
      throw new NeonaicIllegalArgumentError(`${label} 只能是纯文本片段，不能是“${value.TYPE}”`);
    }
    return value;
  }
  if (value instanceof NeonaicMessageFragment || value instanceof NeonaicMessage) {
    throw new NeonaicIllegalArgumentError(`${label} 只能是纯文本，不能嵌套片段或消息`);
  }
  if (typeof value !== 'string') {
    throw new NeonaicIllegalArgumentError(`${label} 必须是字符串或纯文本片段`);
  }
  return new NeonaicTextMsgFrag(value);
}

/**
 * 把容器的内容规范化成片段数组，并按 {@link NESTING} 校验可嵌套性。
 * @param {NeonaicMessageFragment|NeonaicMessageFragment[]|string|string[]|null|undefined} value 容器内容
 * @param {string} container {@link NESTING} 里的容器名
 * @returns {NeonaicMessageFragment[]} 至少含一个片段（空内容落成空文本）
 * @throws {NeonaicIllegalArgumentError} 元素类型不合法，或不允许嵌套
 */
function normalizeNestedFragments(value, container) {
  const list = value === undefined || value === null
    ? []
    : (Array.isArray(value) ? value : [value]);
  const out = list.map((item) => {
    if (item instanceof NeonaicMessageFragment) return item;
    if (typeof item === 'string') return new NeonaicTextMsgFrag(item);
    if (item instanceof NeonaicMessage) {
      throw new NeonaicIllegalArgumentError(`“${container}”只能嵌套消息片段，不能嵌入整条消息`);
    }
    throw new NeonaicIllegalArgumentError(`“${container}”的每个元素必须是消息片段或字符串`);
  });
  for (const frag of out) assertNestable(container, frag);
  return out.length ? out : [new NeonaicTextMsgFrag("")];
}

/**
 * 把一项列表/引用内容规范化成一条子消息。
 * @param {NeonaicTValidMessage} value 一项内容
 * @param {string} container {@link NESTING} 里的容器名
 * @param {string} [label="内容"] 出错时指代该项的名字
 * @returns {NeonaicMessage}
 * @throws {NeonaicIllegalArgumentError} 内容不合法，或不允许嵌套
 */
function normalizeMessage(value, container, label = "内容") {
  let message;
  try {
    // 一律新建：既是防御性拷贝，也避免调用方后续 appendFragment 绕过嵌套校验
    message = new NeonaicMessage(value);
  } catch (error) {
    throw new NeonaicIllegalArgumentError(
      `${label}必须是消息、消息片段、片段数组或字符串：${error?.message ?? error}`,
    );
  }
  for (const frag of message.fragments) assertNestable(container, frag);
  return message;
}

/**
 * 规范化列表项集合。
 * @param {NeonaicTValidMessage[]} items 列表项
 * @param {string} container {@link NESTING} 里的容器名
 * @param {string} label 出错时指代该列表的名字
 * @returns {NeonaicMessage[]}
 * @throws {NeonaicIllegalArgumentError} items 不是数组或为空
 */
function normalizeListItems(items, container, label) {
  if (!Array.isArray(items)) {
    throw new NeonaicIllegalArgumentError(`${label} 的 items 必须是数组（每一项是一个片段数组）`);
  }
  if (!items.length) {
    throw new NeonaicIllegalArgumentError(`${label} 至少需要一个列表项`);
  }
  return items.map((item, index) => normalizeMessage(item, container, `第 ${index + 1} 项`));
}

/**
 * 渲染一组列表项（有序 / 无序 / 复选框共用）。
 *
 * @apiNote 续行必须缩进到 marker 之后，否则嵌套列表、代码块会被当成新块，
 *          列表结构直接断掉。
 * @param {Array<{marker: string, message: NeonaicMessage}>} entries 列表项与各自的 marker
 * @returns {string}
 */
function renderListItems(entries) {
  return entries.map(({ marker, message }) => {
    const body = message.toMarkdown();
    // 空项也要占一个 marker，否则「第 3 项是空的」会变成第 2 项
    if (!body) return marker.trimEnd();
    const lines = body.split('\n');
    const pad = ' '.repeat(marker.length);
    lines[0] = marker + lines[0];
    for (let i = 1; i < lines.length; i++) {
      // 空行保持为空（不写尾随空格），非空行缩进到 marker 之后
      if (lines[i]) lines[i] = pad + lines[i];
    }
    return lines.join('\n');
  }).join('\n');
}

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

/**
 * 消息片段的 Markdown 嵌套约束与校验工具。
 *
 * @apiNote 只读快照；要新增允许的嵌套关系请改模块内的 {@link NESTING} 常量，
 *          而不是改这里（这里只是暴露给外部做展示 / 预校验）。
 */
export const neonaicMessageFragment = Object.freeze({
  NESTING,
  assertNestable,
});
