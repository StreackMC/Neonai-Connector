import { NeonaicArithmeticError, NeonaicIllegalArgumentError, NeonaicIllegalStateError } from "./NeonaicNewableError.js";
import { parseString } from "./chore.js";
// ⚠️ 这个 import 必须放在前两者之后：NeonaicNewableClass ↔ NeonaicNewableError ↔ chore →
// confManager → NeonaicConfig → NeonaicNewableClass 之间存在既有的 ESM 环，环的求值顺序
// 决定了 NeonaicConfig 定义类时基类是否已就绪。若本文件从基类开始求值（写成第一行），
// NeonaicConfig 会读到尚未初始化的 NeonaicNewable 并抛 TDZ 错误（直接 import 本文件即可复现）。
import { NeonaicNewable } from "./NeonaicNewableClass.js";

// --- 表格 ---

/**
 * 断言遍历方向合法
 * @param {string} direction 遍历方向
 * @param {boolean} [onlyLine=false] 是否只允许 row/col
 * @returns {'row'|'col'|'cell'} 合法方向
 */
function assertTableDirection(direction, onlyLine = false) {
  const allow = onlyLine ? ['row', 'col'] : NeonaicTable.TABLE_DIRECTIONS;
  if (!allow.includes(direction)) {
    throw new NeonaicIllegalArgumentError(`direction must be one of ${allow.join(', ')}, got ${parseString(direction)}`);
  }
  return direction;
}

/**
 * 解析 CSV 文本为二维数组（支持双引号包裹、转义双引号与换行）
 * @param {string} text CSV 文本
 * @returns {string[][]} 二维数组
 */
function splitCsv(text) {
  const s = parseString(text).replace(/\r\n?/g, '\n');
  const rows = [];
  let row = [];
  let field = '';
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuote) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else { inQuote = false; }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') inQuote = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  row.push(field);
  rows.push(row);
  // 丢弃文末的空行（尾部换行导致）
  const last = rows[rows.length - 1];
  if (last && last.length === 1 && last[0] === '') rows.pop();
  return rows;
}

/**
 * 解析 Markdown 表格文本（忽略对齐分隔行，支持转义竖线）
 *
 * 「有没有表头」在 Markdown 里是可以可靠推断的：GFM 规定表头行必须**紧邻**分隔行，
 * 因此只有当分隔行位于第二行时，第一行才是表头。分隔行出现在其它位置时仅被丢弃，
 * 不影响数据（此时视为没有表头）。
 * @param {string} text Markdown 文本
 * @returns {{rows: string[][], headerDetected: boolean}} 二维数组，以及「首行是否为表头」的推断结果
 */
function splitMarkdownTable(text) {
  const s = parseString(text).replace(/\r\n?/g, '\n');
  const isSeparator = (line) => /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(line);
  const rows = [];
  /** 首个分隔行出现时，已经收集到的数据行数；-1 表示没有分隔行 */
  let separatorAfter = -1;
  for (const rawLine of s.split('\n')) {
    const line = rawLine.trim();
    if (!line || !line.includes('|')) continue;
    if (isSeparator(line)) {
      if (separatorAfter < 0) separatorAfter = rows.length;
      continue;
    }
    let body = line;
    if (body.startsWith('|')) body = body.slice(1);
    if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
    const row = [];
    let field = '';
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (ch === '\\' && body[i + 1] === '|') { field += '|'; i++; }
      else if (ch === '|') { row.push(field.trim()); field = ''; }
      else field += ch;
    }
    row.push(field.trim());
    rows.push(row);
  }
  // 分隔行前恰好一行 ⇒ 那一行就是表头；前 0 行（分隔行打头）或前多行都不视为表头
  return { rows, headerDetected: separatorAfter === 1 };
}

/**
 * 把标题入参规整为数组副本；null / undefined 表示「未提供标题」。
 * 数组直接复制，单值包成单元素数组（避免 `colTitle: 'A'` 被静默丢弃）。
 * @param {any} v 标题入参
 * @returns {any[]|null} 副本，未提供时为 null
 */
function titleList(v) {
  if (v === null || v === undefined) return null;
  return Array.isArray(v) ? v.slice() : [v];
}

/**
 * 判定数据源首行是否为表头行（`option.header` 的求值）。
 *
 * 三种取值：`true` / `false` / `'auto'`（默认）。
 * `'auto'` 只在 Markdown 上能可靠推断（依据分隔行），CSV 与 array[] 一律视为无表头 ——
 * CSV 的首行究竟是标题还是数据没有任何语法线索，猜错会把一整行真实数据变成标题，
 * 因此宁可保守，需要时必须显式传 `header: true`。
 * @param {'csv'|'markdown'|'array[]'} type 数据源类型
 * @param {boolean|'auto'|undefined|null} option `option.header` 的原值
 * @param {boolean} autoDetected 文本结构推断出的结果
 * @returns {boolean} 首行是否为表头行
 * @throws {NeonaicIllegalArgumentError} `option.header` 取值非法
 */
function resolveTableHeader(type, option, autoDetected) {
  if (option === undefined || option === null || option === 'auto') {
    return type === 'markdown' ? autoDetected : false;
  }
  if (typeof option === 'boolean') return option;
  throw new NeonaicIllegalArgumentError(`option.header must be true, false or "auto", got ${parseString(option)}`);
}

/**
 * 将标题数组规整到指定长度
 * @param {any[]|null} titles 原始标题
 * @param {number} size 目标长度
 * @returns {string[]|null} 规整后的标题，原为 null 时返回 null
 */
function normalizeTitles(titles, size) {
  if (titles === null || titles === undefined) return null;
  const list = Array.isArray(titles) ? titles : [titles];
  const out = [];
  for (let i = 0; i < size; i++) {
    out.push(i < list.length ? tableCellText(list[i]) : '');
  }
  return out;
}

/**
 * 将任意单元格值转为文本
 * @param {any} v 单元格值
 * @returns {string} 文本
 */
function tableCellText(v) {
  return (v === null || v === undefined) ? '' : parseString(v);
}

/**
 * 保留单元格值的类型；仅将空单元格规整为默认填充值。
 * @template T
 * @param {T|null|undefined} v 单元格值
 * @returns {T|string} 单元格值
 */
function tableCellValue(v) {
  return (v === null || v === undefined) ? '' : v;
}

/**
 * 归一化表格数据承载器
 * @template T 数据内容
 */
export class NeonaicTable extends NeonaicNewable {
  #payload;

  /** 支持的表格数据源类型 */
  static get TABLE_SOURCE_TYPES() {
    return Object.freeze(['object-row', 'object-col', 'csv', 'array[]', 'markdown']);
  }
  /** 支持的遍历方向 */
  static get TABLE_DIRECTIONS() {
    return Object.freeze(['row', 'col', 'cell']);
  }

  /**
   * 新建或解析一个表格
   *
   * 标题冲突的裁决规则：**option 优先**。数据源自带的标题（object 的键、文本的表头行）
   * 只在 option 未给出对应标题时才使用；两者同时存在时以 option 的内容为准。
   * 其中 object 源存在「键 → 顺序」的映射，原始数据会被重排以对齐 option 的顺序；
   * 文本源的标题是位置性的，无法重排，只能被 option 的标题整体覆盖。
   *
   * `option.rows` / `option.cols` 与数据实际尺寸冲突时同样**按 option 来**：
   * 小于实际值则截断，大于则以空文本补齐。
   *
   * @template T
   * @param {Record<string, T>[]|T[][]|string|NeonaicTable} data 数据源
   * @param {'object-row'|'object-col'|'csv'|'array[]'|'markdown'} type 数据源类型
   * @param {object} [option] 配置
   * @param {number} [option.cols] 允许列数，不存在自动大小；小于实际列数时将被截断，大于时以空文本补齐
   * @param {string[]|string|undefined|null} [option.colTitle=null] 列标题，优先于数据源自带的表头
   * @param {boolean|'auto'} [option.header='auto'] 数据源首行是否为表头行，仅对 csv / markdown / array[] 生效。
   *   `'auto'`（默认）：Markdown 依据分隔行推断（分隔行紧跟在首行之后 ⇒ 首行是表头），
   *   CSV 与 array[] 一律视为无表头（CSV 首行是标题还是数据没有语法线索，猜错会吞掉真实数据）；
   *   `true`：首行作为列标题；此时若 `option.colTitle` 也已给出，则以 option 为准、首行仅被移除
   * @param {number} [option.rows] 允许行数，不存在自动大小；小于实际行数时将被截断，大于时以空文本补齐
   * @param {string[]|string|undefined|null} [option.rowTitle=null] 行名称，优先于数据源自带的键
   * @throws {NeonaicIllegalArgumentError} 数据源类型、数据格式或 option 取值不合法
   * @apiNote 表头行计数在 `option.rows` **之前**生效：`rows` 指的是数据行数，不含表头。
   */
  constructor(data, type, option = {}) {
    super();
    if (!NeonaicTable.TABLE_SOURCE_TYPES.includes(type)) {
      throw new NeonaicIllegalArgumentError(`type must be one of ${NeonaicTable.TABLE_SOURCE_TYPES.join(', ')}, got ${parseString(type)}`);
    }
    const opt = (option !== null && typeof option === 'object') ? option : {};
    let cells = [];
    // option 给出的标题优先；数组与单值都接受（单值会被包成单元素标题列表）
    let colTitle = titleList(opt.colTitle);
    let rowTitle = titleList(opt.rowTitle);
    /** 数据源是否可能有「表头行」：只有逐行排列、且不是复制已有表格时才有这个概念 */
    const mayHaveHeaderRow = !(data instanceof NeonaicTable)
      && (type === 'csv' || type === 'markdown' || type === 'array[]');
    /** Markdown 依据分隔行推断出的「首行是表头」结果 */
    let detectedHeader = false;

    if (data instanceof NeonaicTable) {
      cells = data.matrix;
      if (colTitle === null) colTitle = data.colTitle;
      if (rowTitle === null) rowTitle = data.rowTitle;
    } else if (type === 'csv') {
      const lines = splitCsv(data);
      cells = lines.map((line) => line.map(tableCellValue));
    } else if (type === 'markdown') {
      const parsed = splitMarkdownTable(data);
      cells = parsed.rows.map((line) => line.map(tableCellValue));
      detectedHeader = parsed.headerDetected;
    } else if (type === 'array[]') {
      if (!Array.isArray(data)) throw new NeonaicIllegalArgumentError('data must be an array of arrays when type is "array[]"');
      cells = data.map((line) => Array.isArray(line) ? line.map(tableCellValue) : [tableCellValue(line)]);
    } else if (type === 'object-row') {
      if (!Array.isArray(data)) throw new NeonaicIllegalArgumentError('data must be an array of objects when type is "object-row"');
      const objects = data.map((v) => (v !== null && typeof v === 'object') ? v : {});
      const keys = [];
      for (const o of objects) for (const k of Object.keys(o)) if (!keys.includes(k)) keys.push(k);
      const order = colTitle === null ? keys : colTitle.slice();
      colTitle = order;
      cells = objects.map((o) => order.map((k) => tableCellValue(o[k])));
    } else {
      // object-col
      if (Array.isArray(data)) {
        // 数组元素依次视为一列
        const objects = data.map((v) => (v !== null && typeof v === 'object') ? v : {});
        const keys = [];
        for (const o of objects) for (const k of Object.keys(o)) if (!keys.includes(k)) keys.push(k);
        const order = rowTitle === null ? keys : rowTitle.slice();
        rowTitle = order;
        cells = order.map((k) => objects.map((o) => tableCellValue(o[k])));
      } else if (data !== null && typeof data === 'object') {
        // 键为列标题，值为该列数据
        const order = colTitle === null ? Object.keys(data) : colTitle.slice();
        colTitle = order;
        const columns = order.map((k) => Array.isArray(data[k]) ? data[k] : [data[k]]);
        const rowCount = columns.reduce((m, c) => Math.max(m, c.length), 0);
        cells = [];
        for (let r = 0; r < rowCount; r++) cells.push(columns.map((c) => tableCellValue(c[r])));
      } else {
        throw new NeonaicIllegalArgumentError('data must be an object or an array of objects when type is "object-col"');
      }
    }

    // 表头行：option.header 显式指定优先，'auto' 时只有 Markdown 能依据分隔行可靠推断。
    // 冲突裁决：option.colTitle 已给出时以 option 为准，但表头行**仍然**从数据中移除 ——
    // 否则同一份标题会同时出现在「列标题」和「首行数据」里。
    /** 被识别为表头的那一行的列数；用于「只有表头、没有数据行」时推断列数 */
    let headerWidth = 0;
    if (mayHaveHeaderRow && resolveTableHeader(type, opt.header, detectedHeader) && cells.length > 0) {
      headerWidth = cells[0].length;
      if (colTitle === null) colTitle = cells[0].map(tableCellText);
      cells = cells.slice(1);
    }

    const needRows = cells.length;
    // 列数取「数据行最大宽度」与「表头行宽度」的较大者：否则只有表头的表会被判成 0 列，
    // 连列标题都会被 normalizeTitles 截成空数组。
    const needCols = cells.reduce((m, line) => Math.max(m, line.length), headerWidth);
    const rows = (opt.rows === undefined || opt.rows === null) ? needRows : opt.rows;
    const cols = (opt.cols === undefined || opt.cols === null) ? needCols : opt.cols;
    if (!Number.isInteger(rows) || rows < 0) throw new NeonaicIllegalArgumentError(`option.rows must be a non-negative integer, got ${parseString(rows)}`);
    if (!Number.isInteger(cols) || cols < 0) throw new NeonaicIllegalArgumentError(`option.cols must be a non-negative integer, got ${parseString(cols)}`);

    const matrix = [];
    for (let r = 0; r < rows; r++) {
      const line = [];
      for (let c = 0; c < cols; c++) line.push(cells[r]?.[c] ?? '');
      matrix.push(line);
    }

    this.#payload = {
      cells: matrix,
      rows,
      cols,
      colTitle: normalizeTitles(colTitle, cols),
      rowTitle: normalizeTitles(rowTitle, rows),
    };
  }

  /** @returns {number} 行数 */
  get rows() { return this.#payload.rows; }
  /** @returns {number} 列数 */
  get cols() { return this.#payload.cols; }
  /** @returns {string[]|null} 列标题副本 */
  get colTitle() { return this.#payload.colTitle ? this.#payload.colTitle.slice() : null; }
  /** @returns {string[]|null} 行标题副本 */
  get rowTitle() { return this.#payload.rowTitle ? this.#payload.rowTitle.slice() : null; }
  /** @returns {T[][]} 全部单元格副本 */
  get matrix() { return this.#payload.cells.map((line) => line.slice()); }

  /**
   * 解析单个行列下标（支持负数与标题）
   * @param {number|string} v 行/列下标或标题
   * @param {number} size 该维度长度
   * @param {string[]|null} titles 该维度标题
   * @param {string} what 维度名称
   * @returns {number} 规整后的下标
   */
  #index(v, size, titles, what) {
    if (typeof v === 'string' && titles) {
      const hit = titles.indexOf(v);
      if (hit < 0) throw new NeonaicIllegalArgumentError(`${what} title not found: ${parseString(v)}`);
      return hit;
    }
    if (!Number.isInteger(v)) throw new NeonaicIllegalArgumentError(`${what} must be an integer or a known title, got ${parseString(v)}`);
    const real = v < 0 ? size + v : v;
    if (real < 0 || real >= size) throw new NeonaicIllegalArgumentError(`${what} index out of range: ${v} (size ${size})`);
    return real;
  }

  /**
   * 解析单个或多个行列下标
   * @param {number|string|(number|string)[]} v 下标或标题
   * @param {number} size 该维度长度
   * @param {string[]|null} titles 该维度标题
   * @param {string} what 维度名称
   * @returns {number[]} 规整后的下标数组
   */
  #indices(v, size, titles, what) {
    return (Array.isArray(v) ? v : [v]).map((i) => this.#index(i, size, titles, what));
  }

  /**
   * 获取单元格内容
   * @param {number|string} row 行下标（负数自末尾计）或行标题
   * @param {number|string} col 列下标（负数自末尾计）或列标题
   * @returns {T} 内容
   */
  getCell(row, col) {
    const r = this.#index(row, this.#payload.rows, this.#payload.rowTitle, 'row');
    const c = this.#index(col, this.#payload.cols, this.#payload.colTitle, 'col');
    return this.#payload.cells[r][c];
  }

  /**
   * 获取指定行列范围的单元格
   * @param {number|string|(number|string)[]} rows 行下标/标题
   * @param {number|string|(number|string)[]|undefined} [cols] 列下标/标题，省略时为全部列
   * @returns {T[][]} 二维单元格文本，外层为行
   */
  getCells(rows, cols = undefined) {
    const rs = this.#indices(rows, this.#payload.rows, this.#payload.rowTitle, 'row');
    const cs = cols === undefined
      ? Array.from({ length: this.#payload.cols }, (_, i) => i)
      : this.#indices(cols, this.#payload.cols, this.#payload.colTitle, 'col');
    return rs.map((r) => cs.map((c) => this.#payload.cells[r][c]));
  }

  /**
   * 获取一行
   * @param {number|string} row 行下标或行标题
   * @returns {T[]} 该行单元格副本
   */
  getRow(row) {
    const r = this.#index(row, this.#payload.rows, this.#payload.rowTitle, 'row');
    return this.#payload.cells[r].slice();
  }

  /**
   * 获取多行
   * @param {number|string|(number|string)[]} rows 行下标或行标题
   * @returns {T[][]} 多行单元格副本
   */
  getRows(rows) {
    return this.#indices(rows, this.#payload.rows, this.#payload.rowTitle, 'row').map((r) => this.#payload.cells[r].slice());
  }

  /**
   * 获取一列
   * @param {number|string} col 列下标或列标题
   * @returns {T[]} 该列单元格副本
   */
  getCol(col) {
    const c = this.#index(col, this.#payload.cols, this.#payload.colTitle, 'col');
    return this.#payload.cells.map((line) => line[c]);
  }

  /**
   * 获取多列
   * @param {number|string|(number|string)[]} cols 列下标或列标题
   * @returns {T[][]} 多列单元格副本，外层为列
   */
  getCols(cols) {
    const cs = this.#indices(cols, this.#payload.cols, this.#payload.colTitle, 'col');
    return cs.map((c) => this.#payload.cells.map((line) => line[c]));
  }

  /**
   * 替换单元格内容
   * @param {number|string|(number|string)[]} row 行下标/标题，传入数组时将写入多行
   * @param {number|string|(number|string)[]} col 列下标/标题，传入数组时将写入多列
   * @param {T} value 新内容；行列均为数组时可为二维数组，否则按标量广播
   * @returns {this} 本实例，便于链式调用
   */
  setCell(row, col, value) {
    const rs = this.#indices(row, this.#payload.rows, this.#payload.rowTitle, 'row');
    const cs = this.#indices(col, this.#payload.cols, this.#payload.colTitle, 'col');
    const isMatrix = Array.isArray(value) && value.some((v) => Array.isArray(v));
    for (let i = 0; i < rs.length; i++) {
      for (let j = 0; j < cs.length; j++) {
        const v = isMatrix ? value[i]?.[j] : (Array.isArray(value) && value.length !== 0 && rs.length * cs.length > 1 ? value[i * cs.length + j] : value);
        this.#payload.cells[rs[i]][cs[j]] = tableCellValue(v);
      }
    }
    return this;
  }

  /**
   * 快速替换整行
   * @param {number|string} row 行下标或行标题
   * @param {T[]} values 新行内容，长度不足时保留原值，超出部分忽略
   * @returns {this} 本实例，便于链式调用
   */
  setRow(row, values) {
    const r = this.#index(row, this.#payload.rows, this.#payload.rowTitle, 'row');
    if (!Array.isArray(values)) throw new NeonaicIllegalArgumentError(`values must be an array, got ${parseString(values)}`);
    for (let c = 0; c < Math.min(values.length, this.#payload.cols); c++) {
      this.#payload.cells[r][c] = tableCellValue(values[c]);
    }
    return this;
  }

  /**
   * 快速替换整列
   * @param {number|string} col 列下标或列标题
   * @param {T[]} values 新列内容，长度不足时保留原值，超出部分忽略
   * @returns {this} 本实例，便于链式调用
   */
  setCol(col, values) {
    const c = this.#index(col, this.#payload.cols, this.#payload.colTitle, 'col');
    if (!Array.isArray(values)) throw new NeonaicIllegalArgumentError(`values must be an array, got ${parseString(values)}`);
    for (let r = 0; r < Math.min(values.length, this.#payload.rows); r++) {
      this.#payload.cells[r][c] = tableCellValue(values[r]);
    }
    return this;
  }

  /**
   * 按方向遍历表格
   * @param {(value: T, row: number, col: number, table: NeonaicTable<T>) => void} callback 处理函数；方向为 row 时 value 为整行副本、col 为列下标，方向为 col 时 value 为整列副本、row 为行下标，方向为 cell 时为单元格文本
   * @param {'row'|'col'|'cell'} [direction='row'] 遍历方向
   * @param {any} [thisArg] 可选的 this 值，默认为本实例
   * @returns {void}
   * @throws {NeonaicIllegalArgumentError} callback 不是函数或方向不合法
   */
  forEach(callback, direction = 'row', thisArg = this) {
    if (typeof callback !== 'function') throw new NeonaicIllegalArgumentError('callback must be a function');
    const d = assertTableDirection(direction);
    const { cells, rows, cols } = this.#payload;
    if (d === 'row') {
      for (let r = 0; r < rows; r++) callback.call(thisArg, cells[r].slice(), r, undefined, this);
    } else if (d === 'col') {
      for (let c = 0; c < cols; c++) callback.call(thisArg, this.getCol(c), undefined, c, this);
    } else {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) callback.call(thisArg, cells[r][c], r, c, this);
      }
    }
  }

  /**
   * 按方向遍历表格并收集返回值
   * @template T
   * @param {(value: T, row: number, col: number, table: NeonaicTable<T>) => T} callback 处理函数，参数含义同 {@link NeonaicTable#forEach}
   * @param {'row'|'col'|'cell'} [direction='row'] 遍历方向；`cell` 时逐格映射，输出尺寸不变
   * @param {any} [thisArg] 可选的 this 值，默认为本实例
  * @returns {NeonaicTable<T>} 映射后的新表格
   * @throws {NeonaicIllegalArgumentError} callback 不是函数或方向不合法
   */
  map(callback, direction = 'row', thisArg = this) {
    if (typeof callback !== 'function') throw new NeonaicIllegalArgumentError('callback must be a function');
    const d = assertTableDirection(direction);
    const { cells, rows, cols, colTitle, rowTitle } = this.#payload;
    const options = {
      colTitle: colTitle ? colTitle.slice() : null,
      rowTitle: rowTitle ? rowTitle.slice() : null,
    };
    if (d === 'row') {
      return new NeonaicTable(cells.map((line, r) => callback.call(thisArg, line.slice(), r, undefined, this)), 'array[]', {
        ...options,
        rows,
        cols,
      });
    }
    if (d === 'col') {
      const mapped = [];
      for (let c = 0; c < cols; c++) mapped.push(callback.call(thisArg, this.getCol(c), undefined, c, this));
      return new NeonaicTable(Array.from({ length: rows }, (_, r) => mapped.map((line) => line[r])), 'array[]', {
        ...options,
        rows,
        cols,
      });
    }
    return new NeonaicTable(cells.map((line, r) => line.map((value, c) => callback.call(thisArg, value, r, c, this))), 'array[]', {
      ...options,
      rows,
      cols,
    });
  }

  /**
   * 按方向遍历表格并收集返回值
   * @template T
   * @param {(value: T, row: number, col: number, table: NeonaicTable<T>) => T} callback 处理函数，参数含义同 {@link NeonaicTable#forEach}
   * @param {'row'|'col'|'cell'} [direction='row'] 遍历方向
   * @param {any} [thisArg] 可选的 this 值，默认为本实例
   * @returns {T[]} 方向为 row/col 时为每行/每列的返回值，方向为 cell 时为每个单元格的返回值
   * @throws {NeonaicIllegalArgumentError} callback 不是函数或方向不合法
   */
  mapThenCollect(callback, direction = 'row', thisArg = this) {
    if (typeof callback !== 'function') throw new NeonaicIllegalArgumentError('callback must be a function');
    const out = [];
    this.forEach((value, r, c) => { out.push(callback.call(thisArg, value, r, c, this)); }, direction, thisArg);
    return out;
  }

  /**
   * 按方向筛选表格，保留回调为真的行或列
   * @param {(value: T, row: number, col: number, table: NeonaicTable<T>) => boolean} predicate 判定函数，参数含义同 {@link NeonaicTable#forEach}
   * @param {'row'|'col'} [direction='row'] 筛选方向
   * @param {any} [thisArg] 可选的 this 值，默认为本实例
   * @returns {NeonaicTable<T>} 新表格，标题随之保留
   * @throws {NeonaicIllegalArgumentError} predicate 不是函数或方向不合法
   */
  filter(predicate, direction = 'row', thisArg = this) {
    if (typeof predicate !== 'function') throw new NeonaicIllegalArgumentError('predicate must be a function');
    const d = assertTableDirection(direction, true);
    const { cells, rows, cols, colTitle, rowTitle } = this.#payload;
    const keep = [];
    if (d === 'row') {
      for (let r = 0; r < rows; r++) if (predicate.call(thisArg, cells[r].slice(), r, undefined, this)) keep.push(r);
      return new NeonaicTable(keep.map((r) => cells[r].slice()), 'array[]', {
        rows: keep.length,
        cols,
        colTitle: colTitle ? colTitle.slice() : null,
        rowTitle: rowTitle ? keep.map((r) => rowTitle[r]) : null,
      });
    }
    for (let c = 0; c < cols; c++) if (predicate.call(thisArg, this.getCol(c), undefined, c, this)) keep.push(c);
    return new NeonaicTable(cells.map((line) => keep.map((c) => line[c])), 'array[]', {
      rows,
      cols: keep.length,
      colTitle: colTitle ? keep.map((c) => colTitle[c]) : null,
      rowTitle: rowTitle ? rowTitle.slice() : null,
    });
  }

  /**
   * 转置表格，行列标题互换
   * @returns {NeonaicTable<T>} 转置后的新表格
   */
  transpose() {
    const { cells, rows, cols, colTitle, rowTitle } = this.#payload;
    const matrix = [];
    for (let c = 0; c < cols; c++) matrix.push(cells.map((line) => line[c]));
    return new NeonaicTable(matrix, 'array[]', {
      rows: cols,
      cols: rows,
      colTitle: rowTitle ? rowTitle.slice() : null,
      rowTitle: colTitle ? colTitle.slice() : null,
    });
  }

  /**
   * 导出为二维数组
   * @returns {T[][]} 单元格副本
   */
  toArray() { return this.matrix; }

  /**
   * 导出为 CSV 文本
   * @returns {string} CSV 文本，含列标题行（标题全空时省略）
   * @apiNote 因为 CSV 的首行没有语法标记，本方法输出标题行后，重新解析时**必须**显式传
   *          `option.header: true`，否则标题行会被当成一行数据。
   */
  toCsv() {
    const esc = (v) => parseString(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    const lines = [];
    const { colTitle, cells } = this.#payload;
    if (colTitle && colTitle.some((v) => v !== '')) lines.push(colTitle.map(esc).join(','));
    for (const line of cells) lines.push(line.map(esc).join(','));
    return lines.join('\n');
  }

  /**
   * 导出为 Markdown 表格
   * @returns {string} Markdown 表格文本
   */
  get markdown() {
    const { cells, rows, cols, colTitle, rowTitle } = this.#payload;

    // 没有列，Markdown 表格无法成立（至少需要表头和分隔行）
    if (cols === 0) return '';

    // Markdown 表格用 | 分隔单元格，内容里的 | 必须转义；
    // 真实换行会终止表格行，必须替换成空格（GFM 不支持单元格内换行）。
    const esc = (v) => parseString(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

    // 是否存在行标题列。用 length 判断，避免空数组 [] 被当成 truthy，
    // 导致表头多一列但数据行取不到值。
    const hasRowTitle = Array.isArray(rowTitle) && rowTitle.length > 0;

    // 构建表头单元格数组。
    // 有行标题列时，第一列是行标题列的表头，留空。
    const head = [];
    if (hasRowTitle) head.push('');
    for (let c = 0; c < cols; c++) {
      // colTitle 可能比 cols 短，用 ?? '' 兜底，避免 esc(undefined)。
      head.push(esc(colTitle?.[c] ?? ''));
    }

    // Markdown 表格前两行：表头行 + 分隔行。
    // 分隔行的数量必须和表头单元格数量一致，否则表格结构会错位。
    const lines = [
      `| ${head.join(' | ')} |`,
      `| ${head.map(() => '---').join(' | ')} |`,
    ];

    // 逐行构建数据行。
    for (let r = 0; r < rows; r++) {
      const line = [];
      // 有行标题列时，先放行标题。
      if (hasRowTitle) line.push(esc(rowTitle[r]));
      for (let c = 0; c < cols; c++) {
        // cells[r] 或 cells[r][c] 可能缺失，用 ?? '' 兜底。
        line.push(esc(cells?.[r]?.[c] ?? ''));
      }
      lines.push(`| ${line.join(' | ')} |`);
    }

    // 所有行用换行符连接，返回完整 Markdown 表格。
    return lines.join('\n');
  }

  /** @returns {string} Markdown 表格文本 */
  toString() { return this.markdown; }
}

/**
 * @extends {NeonaicTable<number>} 数学矩阵，但每个单元格必须是数字
 */
export class NeonaicMatrix extends NeonaicTable {
  /**
   * 新建或解析一个矩阵
   * @param {number[][]|string} data 数据源
   * @param {'array[]'|'csv'|'markdown'} type 数据源类型
   * @param {object} [option] 配置
   * @param {number} [option.cols] 允许列数，不存在自动大小；小于实际列数时将被截断，大于时以 0 补齐
   * @param {number} [option.rows] 允许行数，不存在自动大小；小于实际行数时将被截断，大于时以 0 补齐
   * @throws {NeonaicIllegalArgumentError} 数据源类型或数据格式不合法；参数不合法
   * @throws {NeonaicArithmeticError} 矩阵单元格中存在 NaN
   */
  constructor(data, type, option = {}) {
    if (option === null || typeof option !== 'object') throw new NeonaicIllegalArgumentError(`option must be an object, got ${parseString(option)}`);
    super(data, type, {...option, header: false});
    // 检查所有单元格是否为 NaN，非数字的解析为数字
    this.forEach((value, r, c) => {
      neonaicMath.assertNoNaN(value, `matrix cell at row ${r}, col ${c} is NaN`);
      this.setCell(r, c, neonaicMath.toNumber(value, false));
    }, 'cell');
  }

  /**
   * 获取矩阵的转置
   * @returns {NeonaicMatrix} 转置后的矩阵
   */
  transpose() {
    const transposed = new NeonaicMatrix(Array.from({ length: this.cols }, (_, c) => Array.from({ length: this.rows }, (_, r) => this.getCell(r, c))), 'array[]');
    return transposed;
  }

  /** 判断矩阵是否为方阵 */
  get squared() {
    return this.rows === this.cols;
  }

  /**
   * 判断方阵是否奇异
   * @returns {boolean} true 表示奇异矩阵，false 表示非奇异矩阵或不是方阵
   */
  get singular() {
    return this.squared && this.det() === 0;
  }

  setCell(row, col, value) { return super.setCell(row, col, neonaicMath.toNumber(value)); }
  setRow(row, values) { return super.setRow(row, values.map(neonaicMath.toNumber)); }
  setCol(col, values) { return super.setCol(col, values.map(neonaicMath.toNumber)); }

  /**
   * 计算矩阵的行列式
   * @returns {number} 行列式的值
   * @throws {NeonaicIllegalArgumentError} 矩阵必须是方阵才能计算行列式
   */
  det() {
    if (!this.squared) throw new NeonaicIllegalArgumentError(`matrix must be square to calculate determinant, got ${this.rows}x${this.cols}`);
    const n = this.rows;
    if (n === 0) return 1; // 0x0 矩阵的行列式定义为 1
    if (n === 1) return this.getCell(0, 0);
    if (n === 2) return this.getCell(0, 0) * this.getCell(1, 1) - this.getCell(0, 1) * this.getCell(1, 0);
    if (n === 3) {
      const a = this.getCell(0, 0), b = this.getCell(0, 1), c = this.getCell(0, 2);
      const d = this.getCell(1, 0), e = this.getCell(1, 1), f = this.getCell(1, 2);
      const g = this.getCell(2, 0), h = this.getCell(2, 1), i = this.getCell(2, 2);
      return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    }
    // n > 3 时使用递归展开
    let det = 0;
    for (let c = 0; c < n; c++) {
      const subMatrix = new NeonaicMatrix(this.getCells(Array.from({ length: n - 1 }, (_, r) => r + 1), Array.from({ length: n }, (_, col) => col !== c ? col : null).filter((col) => col !== null)), 'array[]');
      det += ((c % 2 === 0 ? 1 : -1) * this.getCell(0, c) * subMatrix.det());
    }
    return det;
  }

  /**
   * 计算矩阵的逆矩阵
   * @returns {NeonaicMatrix|NaN} 逆矩阵；若不可求逆则为 NaN
   * @throws {NeonaicIllegalArgumentError} 矩阵必须是方阵才能计算逆矩阵
   */
  inverse() {
    if (!this.squared) throw new NeonaicIllegalArgumentError(`matrix must be square to calculate inverse, got ${this.rows}x${this.cols}`);
    const n = this.rows;
    const det = this.det();
    if (det === 0) return NaN; // 奇异矩阵无法求逆
    const adjugate = new NeonaicMatrix(Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => {
      const subMatrix = new NeonaicMatrix(this.getCells(Array.from({ length: n }, (_, row) => row !== r ? row : null).filter((row) => row !== null), Array.from({ length: n }, (_, col) => col !== c ? col : null).filter((col) => col !== null)), 'array[]');
      return ((r + c) % 2 === 0 ? 1 : -1) * subMatrix.det();
    })), 'array[]');
    // 逐格除以行列式。这里直接构造 NeonaicMatrix，而不是走 map：基类的 map 返回的是
    // 普通 NeonaicTable，会把 det()/inverse()/squared 这些矩形能力丢掉。
    return new NeonaicMatrix(
      adjugate.transpose().matrix.map((line) => line.map((v) => v / det)),
      'array[]',
    );
  }

  /** 判断矩阵是否满秩 */
  get fullrank() {
    return this.rank === Math.min(this.rows, this.cols);
  }

  /**
   * 获取矩阵的秩（高斯消元化成行阶梯形，按列选绝对值最大的主元以抑制浮点误差）
   * @returns {number} 矩阵的秩
   */
  get rank() {
    // this.matrix 本身就是副本，可以就地消元
    const matrix = this.matrix;
    const rowCount = matrix.length;
    const colCount = rowCount === 0 ? 0 : matrix[0].length;
    // 容差按元素最大绝对值缩放：既不把「本来就很小的数」当成 0，也不会被浮点残差骗到
    const scale = matrix.reduce((m, line) => line.reduce((n, v) => Math.max(n, Math.abs(v)), m), 0);
    const eps = scale === 0 ? 0 : scale * 1e-9;

    let rank = 0;
    for (let c = 0; c < colCount && rank < rowCount; c++) {
      // 部分主元法：在当前列剩余行里挑绝对值最大的一行
      let pivot = rank;
      for (let r = rank + 1; r < rowCount; r++) {
        if (Math.abs(matrix[r][c]) > Math.abs(matrix[pivot][c])) pivot = r;
      }
      if (Math.abs(matrix[pivot][c]) <= eps) continue; // 该列剩余部分全为 0
      [matrix[rank], matrix[pivot]] = [matrix[pivot], matrix[rank]];
      for (let r = rank + 1; r < rowCount; r++) {
        const factor = matrix[r][c] / matrix[rank][c];
        if (factor === 0) continue;
        for (let k = c; k < colCount; k++) matrix[r][k] -= factor * matrix[rank][k];
      }
      rank++;
    }
    return rank;
  }
}

// --- 其他 ---

function getNaNException(where) {
  return new NeonaicArithmeticError(where ? `在${parseString(where)}发现意外的 NaN` : '发现意外的 NaN', where ? where : null);
}

/**
 * @typedef {Object} NeonaicTDecimalStore 防止浮点误差的整指存储
 * @property {number|BigInt} mantissa 放缩出的整数部分
 * @property {number|BigInt} exponent x10的指数部分。将整数乘以 10^exp 即得值。
 */

/**
 * 常用科学常量（浮点表）：**全部是 `number`**，可直接参与浮点运算，也供 `toNumber` 使用。
 *
 * 只收「double 里有效数字够用」的常量。像 `h = 6.62607015e-34` 这种值，浮点只剩约 16 位有效数字，
 * 升到定点后第 17 位起全是二进制转十进制的噪声，因此放进 {@link HIGH_PRECISION_CONSTANTS}，
 * 由高精模式按十进制字面量精确解析。高精表覆盖浮点表的**全部名字**（浮点表是清单，高精表是权威值）。
 *
 * 数值来源：CODATA 2022（NIST SP 959，2024-05）。
 * 名称区分大小写；常用符号都配了 ASCII 别名（`π`/`pi`、`φ`/`phi`、`α`/`a`）。
 */
const PHYSICAL_CONSTANTS = Object.freeze({
  /** 圆周率 */ "π": Math.PI,
  /** 圆周率（ASCII 别名） */ "pi": Math.PI,
  /** 自然对数底 */ "e": Math.E,
  /** 黄金比例 */ "φ": (1 + Math.sqrt(5)) / 2,
  /** 黄金比例（ASCII 别名） */ "phi": (1 + Math.sqrt(5)) / 2,
  /** 光速 m/s（精确值） */ "c": 299792458,
  /** 普适气体常数 J/(mol*K)（= k·N_A，精确值；高精版多留位数） */ "R": 8.314462618,
  /** 标况理想气体摩尔体积 m^3/mol（273.15 K，101.325 kPa；R·T/p） */ "VM": 22.413969545014138e-3,
  /** 标况理想气体摩尔体积 m^3/mol */ "Vm": 22.413969545014138e-3,
  /** 标况理想气体摩尔体积 m^3/mol */ "V_M": 22.413969545014138e-3,
  /** 标况理想气体摩尔体积 m^3/mol */ "V_m": 22.413969545014138e-3,
  /** 法拉第常数 C/mol（= e·N_A，精确值） */ "F": 96485.3321233100184,
  /** 精细结构常数（无单位） */ "α": 7.2973525643e-3,
  /** 精细结构常数（ASCII 别名） */ "a": 7.2973525643e-3,
  /** 质子电子质量比 */ "mppme": 1836.152673426,
});

const HP_PI = '3.14159265358979323846264338327950288419716939937510';
const HP_E = '2.71828182845904523536028747135266249775724709369995';
const HP_PHI = '1.61803398874989484820458683436563811772030917980576';
/**
 * 高精科学常量（CODATA 2022）：值是**十进制字面量字符串**，允许负号与 `e` 指数。
 *
 * 为什么不从浮点表升精度：`number` 只有约 16 位有效数字，且 `String(n)` 在小数末段是
 * 二进制舍入噪声；拿它当高精常量，看着有 40 位，其实第 17 位就错了。
 * 高精模式直接按字符串移位、不经过浮点，于是同一个常量在 science=20 与 science=100 下是同一个数。
 *
 * 数学常量（π/e/φ）取 50 位；物理常量取 CODATA 公布的全部有效数字。
 * 精确值（c、h、e0、k、N_A、R、F）按定义写全；其余为中心值（公布值括号里的不确定度不参与运算）。
 */
const HIGH_PRECISION_CONSTANTS = Object.freeze({
  /** 圆周率 */ 'π': HP_PI,
  /** 圆周率（ASCII 别名） */ 'pi': HP_PI,
  /** 自然对数底 */ 'e': HP_E,
  /** 黄金比例 */ 'φ': HP_PHI,
  /** 黄金比例（ASCII 别名） */ 'phi': HP_PHI,
  /** 光速 m/s（精确值） */ 'c': '299792458',
  /** 普适气体常数 J/(mol*K)（= k·N_A，精确值） */ 'R': '8.31446261815324',
  /** 标况理想气体摩尔体积 m^3/mol（273.15 K，101.325 kPa；R·T/p） */ 'VM': '0.0224139695450141377350111028867505551443',
  /** 标况理想气体摩尔体积 m^3/mol */ 'Vm': '0.0224139695450141377350111028867505551443',
  /** 标况理想气体摩尔体积 m^3/mol */ 'V_M': '0.0224139695450141377350111028867505551443',
  /** 标况理想气体摩尔体积 m^3/mol */ 'V_m': '0.0224139695450141377350111028867505551443',
  /** 法拉第常数 C/mol（= e·N_A，精确值） */ 'F': '96485.3321233100184',
  /** 精细结构常数（无单位） */ 'α': '0.0072973525643',
  /** 精细结构常数（ASCII 别名） */ 'a': '0.0072973525643',
  /** 质子电子质量比 */ 'mppme': '1836.152673426',
  /** 阿伏加德罗(Avogadro)常数 mol^-1（精确值） */ 'NA': '6.02214076e23',
  /** 阿伏加德罗常数（ASCII 别名） */ 'Na': '6.02214076e23',
  /** 阿伏加德罗常数（ASCII 别名） */ 'N_A': '6.02214076e23',
  /** 阿伏加德罗常数（ASCII 别名） */ 'N_a': '6.02214076e23',
  /** 玻尔兹曼(Boltzmann)常数 J/K（精确值） */ 'k': '1.380649e-23',
  /** 基本电荷(元电荷) C（精确值） */ 'e0': '1.602176634e-19',
  /** 原子质量单位 kg */ 'u': '1.66053906892e-27',
  /** 电子静止质量 kg */ 'me': '9.1093837139e-31',
  /** 电子荷质比 C/kg */ 'epme': '1.75882000838e11',
  /** 质子静止质量 kg */ 'mp': '1.67262192595e-27',
  /** 中子静止质量 kg */ 'mn': '1.67492750056e-27',
  /** 真空电容率 F/m */ 'ε0': '8.8541878188e-12',
  /** 真空电容率 F/m（ASCII 别名） */ 'E0': '8.8541878188e-12',
  /** 真空磁导率 N/A² */ 'μ0': '1.25663706127e-6',
  /** 真空磁导率 N/A²（ASCII 别名） */ 'mu0': '1.25663706127e-6',
  /** 电子磁矩 J/T（负值，与自旋反向） */ 'μe': '-9.2847646917e-24',
  /** 质子磁矩 J/T */ 'μp': '1.41060679545e-26',
  /** 玻尔(Bohr)半径 m */ 'α0': '5.29177210544e-11',
  /** 玻尔半径 m（ASCII 别名） */ 'a0': '5.29177210544e-11',
  /** 玻尔(Bohr)磁子 J/T */ 'μB': '9.2740100657e-24',
  /** 玻尔磁子 J/T（ASCII 别名） */ 'muB': '9.2740100657e-24',
  /** 核磁子 J/T */ 'μN': '5.0507837393e-27',
  /** 核磁子 J/T（ASCII 别名） */ 'muN': '5.0507837393e-27',
  /** 普朗克常数 J·s（精确值） */ 'h': '6.62607015e-34',
  /** 约化普朗克常数 J·s（h/2π，由精确的 h 与 π 推出） */ 'ħ': '1.054571817646156391262428003302280744722e-34',
  /** 约化普朗克常数 J·s（ASCII 别名） */ 'hbar': '1.054571817646156391262428003302280744722e-34',
});

// 两张表必须覆盖同一批名字：浮点表是「有哪些常量」的清单，高精表缺项会让同一个名字在
// science 模式里突然变成「未知常量」。宁可启动即炸，也别等用户输入时才发现。
for (const name of Object.keys(PHYSICAL_CONSTANTS)) {
  if (!Object.prototype.hasOwnProperty.call(HIGH_PRECISION_CONSTANTS, name)) {
    throw new NeonaicIllegalStateError(`高精常量表缺少“${name}”：两张常量表的名字必须一一对应`);
  }
}

/**
 * 取浮点常量。
 * @param {string} name 常量名（区分大小写）
 * @returns {number|undefined} 未定义时为 undefined
 * @apiNote 用 `hasOwnProperty` 而不是直接下标：否则 `constructor`、`toString`、`__proto__` 这类
 *          原型链上的键会被当成「存在」并返回函数/对象，污染 `toNumber` 与算式求值。
 */
function resolveConstant(name) {
  return Object.prototype.hasOwnProperty.call(PHYSICAL_CONSTANTS, name)
    ? PHYSICAL_CONSTANTS[name]
    : undefined;
}

/**
 * 取高精常量的十进制字面量。
 * @param {string} name 常量名（区分大小写）
 * @returns {string|undefined} 未定义时为 undefined
 */
function resolveHighPrecisionConstant(name) {
  return Object.prototype.hasOwnProperty.call(HIGH_PRECISION_CONSTANTS, name)
    ? HIGH_PRECISION_CONSTANTS[name]
    : undefined;
}

/**
 * 把整指存储换算成浮点数（显式的精度降级；求值/展示时才用，内部运算别悄悄调用）。
 * @param {Readonly<NeonaicTDecimalStore>} store 整指存储
 * @returns {number}
 */
function decimalToNumber(store) {
  return Number(store.mantissa) * (10 ** Number(store.exponent));
}

/**
 * 把整指存储格式化成十进制文本（用于回话/工具输出）。
 * @param {Readonly<NeonaicTDecimalStore>} store 整指存储
 * @returns {string} 定点或科学记数法文本
 */
function decimalToString(store) {
  const raw = BigInt(store.mantissa);
  const exponent = Number(store.exponent);
  const negative = raw < 0n;
  const digits = (negative ? -raw : raw).toString();
  let body;
  if (exponent >= 0) {
    body = digits + '0'.repeat(exponent);
  } else {
    const point = digits.length + exponent;
    if (point > 0) body = `${digits.slice(0, point)}.${digits.slice(point)}`;
    // 与 JS 的 Number#toString 对齐：小数点后超过 6 个 0 就用科学记数法
    else if (point > -7) body = `0.${'0'.repeat(-point)}${digits}`;
    else body = `${digits[0]}${digits.length > 1 ? `.${digits.slice(1)}` : ''}e${point - 1}`;
  }
  return negative ? `-${body}` : body;
}

// ---- 高精定点（science 模式）----
// 约定：内部值 = 真实值 × 10^scale 的 BigInt，scale 在整条算式里固定不变。

/** 10 的 n 次幂（n ≥ 0） @param {number} n @returns {BigInt} */
function bigPow10(n) { return 10n ** BigInt(n); }

/**
 * 除数为「四舍五入」的整除（远离零取整），符号自动处理。
 * @param {BigInt} a 被除数
 * @param {BigInt} b 除数
 * @returns {BigInt}
 * @throws {NeonaicArithmeticError} 除数为零
 */
function bigRoundDiv(a, b) {
  if (b === 0n) throw new NeonaicArithmeticError('除数不能为零');
  const negative = (a < 0n) !== (b < 0n);
  const absA = a < 0n ? -a : a;
  const absB = b < 0n ? -b : b;
  const q = (absA + absB / 2n) / absB;
  return negative ? -q : q;
}

/**
 * 数字字面量（如 `"2.5"`）→ 定点，按字符串移位，不经浮点。
 * @param {string} text 字面量（`CALC_NUMBER` 已保证格式）
 * @param {number} scale 小数位数
 * @returns {BigInt}
 */
function scaledFromLiteral(text, scale) {
  const matched = text.match(/^(\d*)(?:\.(\d*))?$/);
  const digits = BigInt((matched?.[1] || '0') + (matched?.[2] || ''));
  const shift = scale - (matched?.[2] || '').length;
  return shift >= 0 ? digits * bigPow10(shift) : bigRoundDiv(digits, bigPow10(-shift));
}

/**
 * 十进制字面量（如 `"-9.2847646917e-24"`）→ 定点。按字符串移位，**不经过浮点**。
 * @param {string} text 字面量：可选负号、可选小数、可选 `e` 指数
 * @param {number} scale 小数位数
 * @param {string} [name] 常量名，仅用于报错
 * @returns {BigInt}
 * @throws {NeonaicIllegalArgumentError} 字面量格式非法，或该值在当前 scale 下会被舍入为 0
 */
function scaledFromDecimal(text, scale, name) {
  const matched = text.match(/^(-?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/);
  if (!matched || ((matched[2] || '') === '' && (matched[3] || '') === '')) {
    throw new NeonaicIllegalArgumentError(`无法解析的常量字面量：${text}`);
  }
  const intPart = matched[2] || '';
  const fracPart = matched[3] || '';
  const digitsText = intPart + fracPart;
  const digits = BigInt(digitsText);
  if (digits === 0n) return 0n;
  const shift = (matched[4] ? Number(matched[4]) : 0) - fracPart.length + scale;
  const magnitude = shift >= 0 ? digits * bigPow10(shift) : bigRoundDiv(digits, bigPow10(-shift));
  const value = matched[1] === '-' ? -magnitude : magnitude;
  if (value === 0n) {
    // 定点表示不了这么小的量。静默变 0 会让 h、μB 这类常量整条算式失效，宁可明确报错。
    const leading = decimalLeadingExponent(intPart, fracPart, matched[4]);
    const needed = -leading;
    const keepAll = needed + decimalSignificantDigits(digitsText) - 1;
    throw new NeonaicIllegalArgumentError(
      `常量${name ? `“${name}”` : ''}（${text}）在 science=${scale} 下会舍入为 0；`
      + `请把 science 提到至少 ${needed} 位（保留全部有效数字需 ${keepAll} 位）`,
    );
  }
  return value;
}

/**
 * 十进制字面量首位有效数字的量级（`6.62607015e-34` → -34）。
 * @param {string} intPart 整数部分
 * @param {string} fracPart 小数部分
 * @param {string} [exponentText] `e` 之后的指数
 * @returns {number}
 */
function decimalLeadingExponent(intPart, fracPart, exponentText) {
  const digits = intPart + fracPart;
  const first = digits.search(/[1-9]/);
  return (digits.length - 1 - first) + (exponentText ? Number(exponentText) : 0) - fracPart.length;
}

/**
 * 有效数字位数（去掉前导/尾随零），用于提示「保留全部有效数字需要多少位小数」。
 * @param {string} digits 全部数字
 * @returns {number}
 */
function decimalSignificantDigits(digits) {
  const trimmed = digits.replace(/^0+/, '').replace(/0+$/, '');
  return trimmed.length || 1;
}

/**
 * 定点 → 整指存储（去掉尾随零后返回最小表示）。
 * @param {BigInt} value 定点值
 * @param {number} scale 小数位数
 * @returns {NeonaicTDecimalStore} `mantissa` 能放进安全整数时用 number，否则保留 BigInt
 */
function scaledToStore(value, scale) {
  if (value === 0n) return { mantissa: 0, exponent: 0 };
  let mantissa = value;
  let exponent = -scale;
  while (mantissa % 10n === 0n) { mantissa /= 10n; exponent++; }
  const asNumber = Number(mantissa);
  return { mantissa: Number.isSafeInteger(asNumber) ? asNumber : mantissa, exponent };
}

/** 定点乘法 @returns {BigInt} */
function decMul(a, b, scale) { return bigRoundDiv(a * b, bigPow10(scale)); }

/** 定点除法 @returns {BigInt} */
function decDiv(a, b, scale) {
  if (b === 0n) throw new NeonaicArithmeticError('除数不能为零');
  return bigRoundDiv(a * bigPow10(scale), b);
}

/** 定点取模（a - trunc(a/b)·b） @returns {BigInt} */
function decMod(a, b, scale) {
  if (b === 0n) throw new NeonaicArithmeticError('取模的除数不能为零');
  // 两个操作数同 scale，比值就是 a/b；BigInt 除法本身就是向零截断，直接还原余数即精确
  return a - (a / b) * b;
}

/**
 * 定点整数次幂（快速幂，每步按 scale 舍入）。
 * @param {BigInt} a 底数（定点）
 * @param {BigInt} exponent 指数（**已经是整数**，非定点）
 * @param {number} scale 小数位数
 * @returns {BigInt}
 */
function decPow(a, exponent, scale) {
  const one = bigPow10(scale);
  if (exponent === 0n) return one;
  const negative = exponent < 0n;
  if (negative && a === 0n) throw new NeonaicArithmeticError('0 的负数次幂无意义');
  let k = negative ? -exponent : exponent;
  let base = a;
  let result = one;
  while (k > 0n) {
    if ((k & 1n) === 1n) result = decMul(result, base, scale);
    k >>= 1n;
    if (k > 0n) base = decMul(base, base, scale);
  }
  return negative ? decDiv(one, result, scale) : result;
}

/**
 * 整数 n 次根（牛顿迭代 + 末位修正）。
 * @param {BigInt} A 被开方数
 * @param {number} n 次数（≥ 1 的整数）
 * @returns {BigInt} floor(A^(1/n))
 */
function integerRoot(A, n) {
  if (A < 0n) throw new NeonaicArithmeticError('负数在实数域内没有偶次方根');
  if (n === 1 || A < 2n) return A;
  const times = BigInt(n);
  const bits = A.toString(2).length;
  let x = 1n << BigInt(Math.ceil(bits / n) + 1);
  for (;;) {
    const next = ((times - 1n) * x + A / (x ** (times - 1n))) / times;
    if (next >= x) break;
    x = next;
  }
  while (x ** times > A) x -= 1n;
  return x;
}

/**
 * 定点 n 次根。
 * @param {BigInt} a 被开方数（定点）
 * @param {number} n 次数
 * @param {number} scale 小数位数
 * @returns {BigInt}
 */
function decRoot(a, n, scale) {
  const negative = a < 0n;
  if (negative && n % 2 === 0) throw new NeonaicArithmeticError('负数在实数域内没有偶次方根');
  const abs = negative ? -a : a;
  // 多算一位再四舍五入：整数根只能取 floor，直接用它会让末位总是偏小。
  // 记 R 为 10^scale 缩放的根，则 R^n = a·10^(scale(n-1))；多要一位就把指数补 n：
  // R'^n = a·10^(scale(n-1)+n)，R' = 10R。
  const root = integerRoot(abs * bigPow10(scale * (n - 1) + n), n);
  const rounded = bigRoundDiv(root, 10n);
  return negative ? -rounded : rounded;
}

/** ln 级数与常数缓存：键为工作精度 W @type {Map<number, {ln2: BigInt, ln10: BigInt}>} */
const LN_CACHE = new Map();

/**
 * ln(m)，要求 `m/10^W` ∈ [1, 2]（越界会慢但结果仍正确）。
 * 用 `ln m = 2·atanh((m-1)/(m+1))` 的级数，y ≤ 1/3 时每项缩到 1/9，收敛很快。
 * @param {BigInt} m 定点（W 位小数）
 * @param {number} W 工作精度
 * @returns {BigInt} ln 值（W 位小数）
 */
function lnNearOne(m, W) {
  const one = bigPow10(W);
  const y = bigRoundDiv((m - one) * one, m + one);
  const y2 = bigRoundDiv(y * y, one);
  let sum = y;
  let term = y;
  for (let k = 1n; k <= 100000n; k++) {
    term = bigRoundDiv(term * y2, one);
    if (term === 0n) break;
    sum += bigRoundDiv(term, 2n * k + 1n);
  }
  return 2n * sum;
}

/** 取（并缓存）W 位精度下的 ln2 与 ln10 @returns {{ln2: BigInt, ln10: BigInt}} */
function lnConstants(W) {
  let cached = LN_CACHE.get(W);
  if (!cached) {
    const one = bigPow10(W);
    const ln2 = lnNearOne(2n * one, W);            // y = 1/3
    const ln10 = 3n * ln2 + lnNearOne(bigRoundDiv(125n * one, 100n), W); // ln10 = 3ln2 + ln(5/4)
    cached = { ln2, ln10 };
    LN_CACHE.set(W, cached);
  }
  return cached;
}

/**
 * 定点自然对数的内部实现：在 W 位工作精度下求值，**不做最终舍入**。
 * 先把值归一化到 [1,10)，再用 ln(x) = ln(m) + k·ln2 + e·ln10。
 * @param {BigInt} a 真数（定点，须 > 0）
 * @param {number} scale 调用方的小数位数
 * @param {number} W 工作精度（W ≥ scale）
 * @returns {BigInt} W 位小数下的 ln 值
 * @throws {NeonaicArithmeticError} 真数非正
 */
function lnAtPrecision(a, scale, W) {
  if (a <= 0n) throw new NeonaicArithmeticError('对数的真数必须为正');
  const one = bigPow10(W);
  const { ln2, ln10 } = lnConstants(W);
  const x = a * bigPow10(W - scale);          // 升精度
  const decimalExponent = x.toString().length - 1 - W;
  let m = decimalExponent >= 0
    ? bigRoundDiv(x, bigPow10(decimalExponent))
    : x * bigPow10(-decimalExponent);
  let halvings = 0n;
  while (m >= 2n * one) { m = bigRoundDiv(m, 2n); halvings++; }
  return lnNearOne(m, W) + halvings * ln2 + BigInt(decimalExponent) * ln10;
}

/**
 * 定点自然对数。工作精度多留 12 位吸收级数截断误差，只在最后舍入一次。
 * @param {BigInt} a 真数（定点，须 > 0）
 * @param {number} scale 小数位数
 * @returns {BigInt}
 */
function decLn(a, scale) {
  const W = scale + 12;
  return bigRoundDiv(lnAtPrecision(a, scale, W), bigPow10(W - scale));
}

/**
 * 定点常用对数（换底）。分子分母都取到工作精度再相除，避免「先各自舍入再相除」
 * 让商在末位漂移（否则 `lg8/lg2` 会得到 3.00000000000000000003）。
 * @param {BigInt} a 真数（定点，须 > 0）
 * @param {number} scale 小数位数
 * @returns {BigInt}
 */
function decLg(a, scale) {
  const W = scale + 12;
  const lnW = lnAtPrecision(a, scale, W);
  const ln10W = lnConstants(W).ln10;
  // (lnW/10^W) ÷ (ln10W/10^W) 再缩放到 W 位
  const ratio = bigRoundDiv(lnW * bigPow10(W), ln10W);
  return bigRoundDiv(ratio, bigPow10(W - scale));
}

// --- 导出 ---

export const neonaicMath = Object.freeze({
  /**
   * 将传入值尽可能地转为数字，遇到多个小数点时只保留第一个
   * @implNote 先强转为文本；**整串等于某个常量名时直接返回该常量**（允许前置负号，如 `"-π"`），
   *           否则删掉非数字部分（保留前导正负号）再解析。
   *           只认 `number` 型常量；高精常量（{@link NeonaicTDecimalStore}）**不转换** ——
   *           把整指存储降级成浮点会抹掉它存在的意义。
   * @param {any} v 传入值
   * @param {boolean} allowNaN 是否接受返回 NaN，为 false 时返回 0
   * @returns {number|NaN} 结果，当转出字符串不含数字时为 NaN
   */
  toNumber: (v, allowNaN = true) => {
    if (typeof v === 'number') return v;
    const text = parseString(v).trim();
    // 前导负号（含 U+2212 减号）单独记下来，不要参与「只保留数字和点」的清洗
    const sign = (text.startsWith('-') || text.startsWith('−')) ? -1 : 1;
    // 常量名要求**整串匹配**：否则 "help" 里的 "e" 会被误当成自然常数
    // 浮点表里全是 number，无需判类型；高精常量不在这里降级（那等于抹掉它存在的意义）
    const constant = resolveConstant(sign < 0 ? text.slice(1).trim() : text);
    if (constant !== undefined) return sign * constant;
    // 只保留数字和点
    const s = text.replace(/[^0-9.]/g, '');
    // 拆出整数部分 + 其余全部当小数
    const parts = s.split('.');
    const int = parts[0];
    const dec = parts.slice(1).join('');   // 去掉后面多余的点
    if (int === "") return allowNaN ? NaN : 0;
    return sign * Number(`${int}.${dec}`);
  },

  /**
   * 将输入钳制到一个范围里面
   * @param {number} v 输入值
   * @param {number} min 最小值，默认无限制
   * @param {number} max 最大值，默认无限制
   * @returns {number|NaN} 如果输入是 NaN 或者 min > max 时返回 NaN，其余返回钳制值。
   */
  clamp: (v, min, max) => {
    min = Number.isFinite(min) ? min : Number.NEGATIVE_INFINITY;
    max = Number.isFinite(max) ? max : Number.POSITIVE_INFINITY;
    if (neonaicMath.isNaN(v, min, max).length != 0 || min > max) return NaN;
    return v < min ? min : v > max ? max : v;
  },

  /**
   * 将输入映射到一个范围里面，算法为取模（余数）。
   * @param {number} v 输入值
   * @param {number} min 最小值
   * @param {number} max 最大值
   * @returns {number|NaN} 如果输入是 NaN 或者 min > max 时返回 NaN，其余返回映射值。
   */
  warp: (v, min, max) => {
    min = Number.isFinite(min) ? min : Number.NEGATIVE_INFINITY;
    max = Number.isFinite(max) ? max : Number.POSITIVE_INFINITY;
    if (neonaicMath.isNaN(v, min, max).length != 0 || min > max) return NaN;
    const range = max - min;
    return ((v - min) % range + range) % range + min;
  },

  /**
   * 获取一个随机数
   * @implNote 用 `Math.floor` 而不是 `Math.round`：后者会让 min 与 max 各只占半个区间，
   *           例如 `random(1, 13)` 里 1 和 13 的概率只有其它点数的一半。
   * @param {number} min 最小值，不得小于0
   * @param {number} max 最大值
   * @returns {number} 之间的随机整数，如果发生意外会返回 NaN，如最小值比最大值大
   */
  random: (min, max = Number.MAX_SAFE_INTEGER) => {
    min = neonaicMath.clamp(Number.isFinite(min) ? min : 0, 0, undefined);
    max = Number.isFinite(max) ? max : Number.MAX_SAFE_INTEGER;
    if (neonaicMath.isNaN(min, max).length != 0 || min > max) return NaN;
    return min + Math.floor(Math.random() * (max - min + 1));
  },

  /** 取一个数字的整位数 @param {number} n 自动转整数，传入非 number 会导致意外发生 */
  digitCount: (n) => String(Math.abs(Math.trunc(neonaicMath.assertNoNaN(n)))).length,

  /**
   * 断言一个或一些数值不是 NaN，否则将抛出{@link NeonaicArithmeticError}。
   * @param {number[]|number} v 要断言的数据
   * @param {String} cause 可选：断言失败，说明 NaN 的来源用
   * @returns {number} 断言成功返回数字
   * @see {@link neonaicMath.isNaN} 不抛错误的版本
   */
  assertNoNaN: (v, cause) => {
    if (!Array.isArray(v)) v = [v];
    v.forEach((i) => {
      if (Number.isNaN(i)) throw getNaNException(cause);
    })
    return v;
  },

  /**
   * 断言一个或一些数值不是 NaN，否则使用默认值。
   * @template T
   * @param {number} v 要断言的数据
   * @param {T} d 断言失败返回值
   * @returns {T|number}
   */
  assertNoNaNOrElse: (v, d) => {
    return Number.isNaN(v) ? d : v;
  },

  /**
   * 断言一个函数返回值不是 NaN，否则将抛出{@link NeonaicArithmeticError}。
   * @template T
   * @param {(...any) => T} operation 函数
   * @param {any} args 函数参数
   * @returns {T} 断言成功返回函数结果
   */
  assertResultNoNaN: (operation, ...args) => {
    if (typeof operation !== 'function') throw new NeonaicIllegalArgumentError("期待的传入值不是函数：" + parseString(operation));
    const v = operation.apply(this, args);
    return neonaicMath.assertNoNaN(v, "断言函数结果非 NaN 时");
  },

  /**
   * 断言一个函数返回值不是 NaN，否则将返回回退值。
   * @template T
   * @template V
   * @param {(...any) => T} operation 函数
   * @param {V} fallback 回退值
   * @param {any} args 函数参数
   * @returns {V|T}
   */
  assertResultNoNaNOrElse: (operation, fallback, ...args) => {
    if (typeof operation !== 'function') throw new NeonaicIllegalArgumentError("期待的传入值不是函数：" + parseString(operation));
    const v = operation.apply(this, args);
    return Number.isNaN(v) ? fallback : v;
  },

  /**
   * 判断一个或一些数值是不是 NaN
   * @param {number} v 要判断的数据
   * @returns {number[]} NaN 数据的索引，都不是则为空
   * @see {@link neonaicMath.assertNoNaN} 抛错误的版本
   */
  isNaN: (...v) => {
    let result = [];
    for (let i = 0; i < v.length; i++) {
      if (Number.isNaN(v[i])) result.push(i);
    }
    return result;
  },

  /**
   * 判断一个或一些数值是不是 Inf
   * @param {number} v 要判断的数据，非数字不会转换
   * @returns {number[]} 目标数据的索引，都不是则为空
   */
  isInfinite: (...v) => {
    let result = [];
    for (let i = 0; i < v.length; i++) {
      if (!Number.isFinite(v[i])) result.push(i);
    }
    return result;
  },

  /**
   * 判断一个或一些数值是不是整数
   * @param {number} v 要判断的数据，非数字不会转换
   * @returns {number[]} 目标数据的索引，都不是则为空
   */
  isInt: (...v) => {
    let result = [];
    for (let i = 0; i < v.length; i++) {
      if (Number.isInteger(v[i])) result.push(i);
    }
    return result;
  },

  /**
   * 判断一个或一些数值是不是有误差的大整数
   * @param {number} v 要判断的数据，非数字不会转换
   * @returns {number[]} 目标数据的索引，都不是则为空
   */
  isUnsafeInt: (...v) => {
    let result = [];
    for (let i = 0; i < v.length; i++) {
      if (!Number.isSafeInteger(v[i])) result.push(i);
    }
    return result;
  },

  /**
   * 解析并计算一个算式。
   * @implNote 递归下降，优先级由低到高为：加减 → 乘除模（含隐式乘法）→ 一元正负 → 幂 → 根号 → 对数 → 阶乘 → 常量/括号/数字。
   *           `^` 右结合（`2^3^2` = 512），且比一元负号更紧（`-2^2` = -4），但指数位置上允许带符号（`2^-3`）。
   *           阶乘是后缀运算符，比 `^` 更紧：`2^3!` = 2^6 = 64、`-3!` = -6；`3!!` 读作 `(3!)!`。
   *           隐式乘法支持 `2π`、`3(1+2)`、`(1+2)(3+4)`；但 `2 3` 仍视为错误（不猜）。
   * @implNote 除号 `/` 与 `÷` 等价，乘号还额外接受 `×` 与 `·`，全角符号会被自动折算。
   * @param {String} expr 算式文本，例如 `(13-9)*7-4`
   * @param {{power?: boolean, root?: boolean, mod?: boolean, log?: boolean, factorial?: boolean, basicConstant?: boolean, science?: number}} [options] 可选开启的特性
   *        `power` 开启 `^` 与 `**`；`root` 开启 `√`、`∛`、`3√8`、`³√8`、`^3√8`；`mod` 开启 `%`；
   *        `log` 开启 `ln`/`lg`（自定义底用换底公式，如 `lg8/lg2`）；`factorial` 开启后缀 `!`。
   *        以上五项默认 false，即默认只解析四则运算。
   *        `basicConstant` 默认 **true**，控制是否解析 {@link PHYSICAL_CONSTANTS} / {@link HIGH_PRECISION_CONSTANTS} 里的常量。
   *        `science` 设为 1..200 的整数即启用**高精定点模式**，该数字是**小数位数**：
   *        运算改用 BigInt 定点（`+ - * /`、整数次幂、n 次根、`ln`/`lg`、阶乘），高精常量
   *        （NA、h、ε0…）按十进制字面量精确解析，返回值变为 {@link NeonaicTDecimalStore}。
   *        代价是慢，且只支持整数指数（非整数指数会明确报错）。
   *        每一步运算都会按 `scale` 舍入，长链运算（尤其连续除法/换底）末位可能累积 1 ulp——
   *        例如 `lg8/lg2` 会得到 `3.00000000000000000003` 而不是精确的 3，这是定点的固有行为。
   *        常量若在给定 `scale` 下会被舍入为 0（如 `science=20` 时的 `h`），会明确报错并给出所需位数，
   *        而不是静默变成 0。
   *        不传（或 0）走浮点路径，返回 `number`；此时只有高精版本的常量会明确报错，不偷偷降级。
   * @returns {number|NeonaicTDecimalStore} 浮点模式返回 number；高精模式返回整指存储
   * @throws {NeonaicIllegalArgumentError} 算式语法错误、使用了未开启的运算符、未知常量、`science` 取值非法或精度不足
   * @throws {NeonaicArithmeticError} 除数为零、负数开偶次方、对数的真数非正、阶乘参数非整数等
   */
  calc: calcExpression,

  /**
   * 把整指存储（{@link NeonaicTDecimalStore}）换算成浮点数。
   * @param {Readonly<NeonaicTDecimalStore>} store 整指存储
   * @returns {number} 浮点近似值（精度受 Number 限制，这是**显式**的降级）
   */
  decimalToNumber: decimalToNumber,

  /**
   * 把整指存储格式化成十进制文本（|值| 极小或极大时用科学记数法）。
   * @param {Readonly<NeonaicTDecimalStore>} store 整指存储
   * @returns {string} 如 `"1.5"`、`"5.059824e-27"`
   */
  decimalToString: decimalToString,

  /** 浮点科学常量表（只读），键为可用名字，值**全部是 number**；见 {@link PHYSICAL_CONSTANTS} */
  constants: PHYSICAL_CONSTANTS,

  /**
   * 高精科学常量表（只读），键与 {@link neonaicMath.constants} 一一对应，
   * 值为 CODATA 2022 的十进制字面量字符串（供 `science` 模式按 scale 精确解析）。
   */
  highPrecisionConstants: HIGH_PRECISION_CONSTANTS,

  solve24: dfs24solution,
});

/**
 * 递归求解 24 点及类似问题
 * @implNote 逐个挑出两个数、用 `+ - * /` 合并成一个新数后递归，等价于枚举二叉表达式树的全部形态。
 *           `+` 与 `*` 满足交换律，两个子算式会先按字典序排好再拼接，于是 `a+b` 与 `b+a` 只会记一条；
 *           `-` 与 `/` 不满足交换律，两种顺序都保留。最终用 Set 对算式文本去重。
 * @param {number[]} numbers 源数字
 * @param {number} [target=24] 求解目标，默认 24
 * @returns {String[]} 全部解法（已去掉最外层多余括号）
 */
function dfs24solution(numbers, target = 24) {
  /** 可接受误差 */
  const EPS = 1e-6;
  /** 已找到的解 @param {Set<string>} */
  const SOLUTIONS = new Set();

  if (!Array.isArray(numbers)) throw new NeonaicIllegalArgumentError('求解器期待传入数组，但发现了:' + parseString(numbers));
  numbers = numbers.map((n) => Math.floor(neonaicMath.clamp(neonaicMath.toNumber(n), 1, Number.MAX_SAFE_INTEGER)));
  target = Math.floor(neonaicMath.clamp(neonaicMath.toNumber(target), 1, Number.MAX_SAFE_INTEGER));
  neonaicMath.assertNoNaN([...numbers, target], '传入非法参数：NaN');

  /**
   * 剥掉包裹整个算式的最外层括号
   * @param {String} e 算式
   * @returns {String}
   */
  function unwrap(e) {
    if (!(e.startsWith('(') && e.endsWith(')'))) return e;
    let depth = 0;
    for (let k = 0; k < e.length; k++) {
      if (e[k] === '(') depth++;
      else if (e[k] === ')') {
        depth--;
        // 括号在此处闭合：只有它是最后一对才说明这里包住了整体
        if (depth === 0) return k === e.length - 1 ? unwrap(e.slice(1, -1)) : e;
      }
    }
    return e;
  }

  /**
   * @param {number[]} values 当前的数字
   * @param {String[]} expries 与 values 一一对应的算式
   */
  function dfs(values, expries) {
    if (values.length === 1) {
      if (Math.abs(values[0] - target) <= EPS) SOLUTIONS.add(unwrap(expries[0]));
      return;
    }

    for (let i = 0; i < values.length; i++) {
      for (let j = i + 1; j < values.length; j++) {
        // 剩下的数字，按原顺序保留
        const restValues = [];
        const restExpries = [];
        for (let k = 0; k < values.length; k++) {
          if (k !== i && k !== j) {
            restValues.push(values[k]);
            restExpries.push(expries[k]);
          }
        }

        const a = values[i], b = values[j];
        const ea = expries[i], eb = expries[j];
        // 交换律的规范序：把两个子算式按字典序排好，避免 (a+b) 与 (b+a) 各记一条
        const [ca, cb] = ea > eb ? [eb, ea] : [ea, eb];

        /** 本次可以派生出的全部情况 */
        const branches = [
          [a + b, `(${ca}+${cb})`],
          [a * b, `(${ca}*${cb})`],
          [a - b, `(${ea}-${eb})`],
          [b - a, `(${eb}-${ea})`],
        ];
        if (b !== 0) branches.push([a / b, `(${ea}/${eb})`]);
        if (a !== 0) branches.push([b / a, `(${eb}/${ea})`]);

        for (const [value, expry] of branches) {
          // 中间结果允许为负，但出现 Infinity/NaN 的分支直接剪掉
          if (!Number.isFinite(value)) continue;
          dfs([...restValues, value], [...restExpries, expry]);
        }
      }
    }
  }

  dfs(numbers.slice(), numbers.map(parseString));
  return [...SOLUTIONS.values()];
}

// ---- 算式解析 ----

/** 全角与常见数学符号 → 可解析的半角符号 */
const CALC_SYMBOLS = Object.freeze({
  '（': '(', '）': ')', '＋': '+', '－': '-', '−': '-',
  '＊': '*', '×': '*', '·': '*', '／': '/', '÷': '/',
  '％': '%', '＾': '^', '！': '!',
  // 微符号（U+00B5）与希腊字母 μ（U+03BC）外观相同、码位不同，统一折成后者，否则常量名查不到
  'µ': 'μ',
  '０': '0', '１': '1', '２': '2', '３': '3', '４': '4',
  '５': '5', '６': '6', '７': '7', '８': '8', '９': '9', '．': '.',
});

/** 上标数字 → 半角数字，用于「³√8」这类根号次数 */
const CALC_SUPERSCRIPTS = Object.freeze({
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
  '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
});

/** 根号字符 → 不带次数时的默认次数 */
const CALC_RADICALS = Object.freeze({ '√': 2, '∛': 3 });

/** 根号次数可以用的字符（半角数字 + 上标数字） */
const CALC_INDEX_CHARS = `0-9${Object.keys(CALC_SUPERSCRIPTS).join('')}`;

/** 带次数的根号：`3√8`、`³√8`、`^3√8` */
const CALC_INDEXED_RADICAL = new RegExp(`^\\^?([${CALC_INDEX_CHARS}]+)\\s*(√|∛)`);

/** 数字字面量 */
const CALC_NUMBER = /^(?:\d+(?:\.\d+)?|\.\d+)/;

/**
 * 科学常量的名字：字母（含希腊字母）或下划线开头，后续允许字母、数字、下划线。
 * 覆盖 `π`、`ε0`、`N_A`、`muB`、`ħ` 这类写法；匹配是贪婪的，`ε0` 不会被拆成 `ε` + `0`。
 */
const CALC_CONSTANT_NAME = /^[\p{L}_][\p{L}\p{N}_]*/u;

/** 对数函数前缀：`ln`（自然对数）、`lg`（常用对数）；允许省略括号，如 `ln2`、`lg 100` */
const CALC_LOG_FN = /^(ln|lg)/;

/**
 * 开方。对完全 n 次方数做整数回代修正，避免 `27^(1/3)` = 3.0000000000000004 这类浮点误差。
 * @param {number} value 被开方数
 * @param {number} n 次数
 * @returns {number}
 * @throws {NeonaicArithmeticError} 负数开偶次方
 */
function nthRootOf(value, n) {
  if (!Number.isInteger(n) || n < 1) throw new NeonaicIllegalArgumentError(`根号的次数必须是不小于 1 的整数：${parseString(n)}`);
  if (n === 1) return value;
  if (value < 0 && n % 2 === 0) throw new NeonaicArithmeticError(`${parseString(value)} 在实数域内没有偶次方根`);
  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);
  let r;
  if (n === 2) r = Math.sqrt(abs);
  else if (n === 3) r = Math.cbrt(abs);
  else {
    r = Math.pow(abs, 1 / n);
    // 浮点误差会把 4√16 算成 2.0000000000000004，用「整数回代」修回来
    const rounded = Math.round(r);
    if (rounded > 1 && Math.abs(Math.pow(rounded, n) - abs) <= 1e-6 * Math.max(1, abs)) r = rounded;
  }
  return sign * r;
}

/** 安全除法 @throws {NeonaicArithmeticError} 除数为零 */
function safeDivide(a, b) {
  if (b === 0) throw new NeonaicArithmeticError(`除数不能为零：${parseString(a)} ÷ 0`);
  return a / b;
}

/** 安全取模 @throws {NeonaicArithmeticError} 除数为零 */
function safeModulo(a, b) {
  if (b === 0) throw new NeonaicArithmeticError(`取模的除数不能为零：${parseString(a)} % 0`);
  return a % b;
}

/**
 * 阶乘（浮点模式）。只接受非负整数。
 * @param {number} n 参数
 * @returns {number} n!
 * @throws {NeonaicIllegalArgumentError} 不是非负整数
 * @throws {NeonaicArithmeticError} 参数超过 170（double 已放不下）
 */
function factorialOf(n) {
  if (!Number.isInteger(n) || n < 0) throw new NeonaicIllegalArgumentError(`阶乘只接受非负整数：${parseString(n)}`);
  if (n > 170) throw new NeonaicArithmeticError(`${n}! 超出双精度浮点范围，请改用 science 高精模式`);
  let result = 1;
  for (let i = 2; i <= n; i++) result *= i;
  return result;
}

/**
 * 阶乘（定点模式）。参数必须是定点表示的**非负整数**。
 * @param {BigInt} value 定点值
 * @param {number} scale 小数位数
 * @returns {BigInt} n! 的定点表示
 * @throws {NeonaicIllegalArgumentError} 不是非负整数
 * @throws {NeonaicArithmeticError} 参数超过 10000（防止一次输入把内存吃满）
 */
function decFactorial(value, scale) {
  const one = bigPow10(scale);
  if (value < 0n || value % one !== 0n) throw new NeonaicIllegalArgumentError('阶乘只接受非负整数');
  const n = value / one;
  if (n > 10000n) throw new NeonaicArithmeticError(`阶乘参数过大（上限 10000）：${n}`);
  let result = 1n;
  for (let i = 2n; i <= n; i++) result *= i;
  return result * one;
}

/**
 * 递归下降地解析并计算一个算式（{@link neonaicMath.calc} 的实现）
 * @param {String} expr 算式文本
 * @param {{power?: boolean, root?: boolean, mod?: boolean, log?: boolean, factorial?: boolean, basicConstant?: boolean, science?: number}} [options] 可选开启的特性
 * @returns {number|NeonaicTDecimalStore} 浮点模式为 number，`science` 模式为整指存储
 */
function calcExpression(expr, options) {
  if (options !== undefined && options !== null && typeof options !== 'object') {
    throw new NeonaicIllegalArgumentError(`算式的选项应该是一个对象或留空：${parseString(options)}`);
  }
  const { power = false, root = false, mod = false, log = false, factorial = false, basicConstant = true, science } = options ?? {};
  // science = 小数位数；null 表示走原来的浮点路径
  const scale = (science === undefined || science === null || science === 0 || science === false) ? null : science;
  if (scale !== null && (!Number.isInteger(scale) || scale < 1 || scale > 200)) {
    throw new NeonaicIllegalArgumentError(`option.science 必须是 1..200 的整数（小数位数）：${parseString(science)}`);
  }
  const high = scale !== null;

  // 归一化：折算全角与数学符号，`**` 与 `^` 等价
  const source = parseString(expr);
  let text = '';
  for (const ch of source) text += CALC_SYMBOLS[ch] ?? ch;
  text = text.replace(/\*\*/g, '^');

  /** 当前解析位置 */
  let at = 0;
  const skipSpace = () => { while (at < text.length && /\s/.test(text[at])) at++; };
  /** 造一个语法错误，附带出错位置；提示里同时给出归一化后的文本便于对照 */
  const fail = (why) => new NeonaicIllegalArgumentError(`${why}（第 ${at + 1} 个字符处）：${parseString(source)}`);
  const requireRoot = () => { if (!root) throw fail('未启用根号解析，无法使用“√”“∛”或带次数的根号'); };

  /** 高精模式下「1」的定点表示 */
  const one = high ? bigPow10(scale) : 1;
  // 两套算子：语法完全一致，只有数值语义不同（高精走 BigInt 定点）
  const mul = high ? (a, b) => decMul(a, b, scale) : (a, b) => a * b;
  const div = high ? (a, b) => decDiv(a, b, scale) : safeDivide;
  const modulo = high ? (a, b) => decMod(a, b, scale) : safeModulo;
  const rootOf = high ? (a, n) => decRoot(a, n, scale) : nthRootOf;
  const lnOf = high ? (a) => decLn(a, scale) : (a) => {
    if (!(a > 0)) throw new NeonaicArithmeticError(`对数的真数必须为正：${parseString(source)}`);
    return Math.log(a);
  };
  const lgOf = high ? (a) => decLg(a, scale) : (a) => {
    if (!(a > 0)) throw new NeonaicArithmeticError(`对数的真数必须为正：${parseString(source)}`);
    return Math.log10(a);
  };

  /** 括号、数字或科学常量 */
  function parsePrimary() {
    skipSpace();
    if (text[at] === '(') {
      at++;
      const v = parseAdditive();
      skipSpace();
      if (text[at] !== ')') throw fail('括号没有闭合');
      at++;
      return v;
    }
    const matched = text.slice(at).match(CALC_NUMBER);
    if (matched) {
      at += matched[0].length;
      return high ? scaledFromLiteral(matched[0], scale) : Number(matched[0]);
    }
    // 科学常量：整段标识符作为名字去查表（这样 ε0 / N_A / muB 不会被拆错）
    const name = text.slice(at).match(CALC_CONSTANT_NAME);
    if (!name) throw fail('期待一个数字、科学常量或括号');
    const symbol = name[0];
    if (high) {
      // 高精模式只认十进制字面量：从 number 升精度会「后面补零」，看着像高精其实是假的
      const literal = resolveHighPrecisionConstant(symbol);
      if (literal === undefined) {
        if (resolveConstant(symbol) !== undefined) throw fail(`常量“${symbol}”没有高精版本，无法在 science 模式下使用`);
        throw fail(`未知的常量“${symbol}”（可用名字见 neonaicMath.highPrecisionConstants）`);
      }
      if (!basicConstant) throw fail(`未启用科学常量解析，无法使用“${symbol}”`);
      at += symbol.length;
      return scaledFromDecimal(literal, scale, symbol);
    }
    const value = resolveConstant(symbol);
    if (value === undefined) {
      // 高精常量在浮点里只能降到 16 位，等于抹掉它存在的意义 —— 宁可报错并告诉用户怎么开
      if (resolveHighPrecisionConstant(symbol) !== undefined) {
        throw fail(`常量“${symbol}”只有高精版本，需要 science 高精模式才能使用`);
      }
      throw fail(`未知的常量“${symbol}”（可用名字见 neonaicMath.constants）`);
    }
    if (!basicConstant) throw fail(`未启用科学常量解析，无法使用“${symbol}”`);
    at += symbol.length;
    return value;
  }

  /**
   * 后缀阶乘：`5!`、`(1+2)!`、`3!!`（重复求阶乘）。
   * @apiNote 位于优先级链最高处（比 `^` 更紧），于是 `2^3!` = 2^6 = 64、`-3!` = -(3!) = -6，
   *          与常见计算器一致。`3!!` 读作 `(3!)!`，**不是**数学里的双阶乘。
   */
  function parsePostfix() {
    let v = parsePrimary();
    for (;;) {
      skipSpace();
      if (text[at] !== '!') return v;
      if (!factorial) throw fail('未启用阶乘解析，无法使用“!”');
      at++;
      v = high ? decFactorial(v, scale) : factorialOf(v);
    }
  }

  /**
   * 对数：`ln<expr>` / `lg<expr>`（也接受括号形式 `ln(1+2)`）
   * @apiNote 操作数取一元表达式，于是 `ln2^2` 读作 `ln(2^2)`，而 `ln(2)^2` 读作 `(ln 2)^2`。
   */
  function parseLog() {
    skipSpace();
    const matched = text.slice(at).match(CALC_LOG_FN);
    if (!matched) return parsePostfix();
    if (!log) throw fail(`未启用对数解析，无法使用“${matched[1]}”`);
    at += matched[0].length;
    skipSpace();
    const operand = (text[at] === '(') ? parsePrimary() : parseUnary();
    if (!high && !(operand > 0)) throw new NeonaicArithmeticError(`对数的真数必须为正：${parseString(source)}`);
    return matched[1] === 'ln' ? lnOf(operand) : lgOf(operand);
  }

  /** 根号：`√9`、`∛8`、`3√8`、`³√8`、`^3√8` */
  function parseRadical() {
    skipSpace();
    const ch = text[at];
    // 不带次数的前缀根号
    if (ch !== undefined && CALC_RADICALS[ch]) {
      requireRoot();
      at++;
      // 操作数取一元表达式，于是 `∛-27` 也能解析（负数只允许开奇次方）
      return rootOf(parseUnary(), CALC_RADICALS[ch]);
    }
    // 带次数的根号。注意 `^3√8` 里的 `^` 是根号次数，不是幂运算符
    const indexed = text.slice(at).match(CALC_INDEXED_RADICAL);
    if (indexed) {
      requireRoot();
      const times = Number([...indexed[1]].map((c) => CALC_SUPERSCRIPTS[c] ?? c).join(''));
      at += indexed[0].length;
      return rootOf(parseUnary(), times);
    }
    return parseLog();
  }

  /** 幂：右结合，指数位置允许带符号 */
  function parsePower() {
    const base = parseRadical();
    skipSpace();
    if (text[at] === '^') {
      if (!power) throw fail('未启用幂运算解析，无法使用“^”或“**”');
      at++;
      const exponent = parseUnary();
      if (!high) return Math.pow(base, exponent);
      // 高精模式只做整数次幂：非整数指数要走 exp(y·ln x)，尚未实现
      if (exponent % one !== 0n) throw fail('高精模式（science）暂不支持非整数指数');
      return decPow(base, exponent / one, scale);
    }
    return base;
  }

  /** 一元正负号 */
  function parseUnary() {
    skipSpace();
    const ch = text[at];
    if (ch === '+') { at++; return parseUnary(); }
    if (ch === '-') { at++; return -parseUnary(); }
    return parsePower();
  }

  /**
   * 当前位置是否紧跟一个可以「隐式相乘」的因子：科学常量或左括号。
   *
   * 只认这两种，**不认数字** —— 否则 `2 3` 会被当成 `2*3`，把明显的输入错误吞掉。
   */
  function startsImplicitFactor() {
    skipSpace();
    const ch = text[at];
    if (ch === undefined) return false;
    if (ch === '(') return true;
    return CALC_CONSTANT_NAME.test(text.slice(at));
  }

  /** 乘、除、取模，以及隐式乘法（`2π`、`3(1+2)`、`(1+2)(3+4)`） */
  function parseMultiplicative() {
    let v = parseUnary();
    for (;;) {
      skipSpace();
      const ch = text[at];
      if (ch === '*') { at++; v = mul(v, parseUnary()); }
      else if (ch === '/') { at++; v = div(v, parseUnary()); }
      else if (ch === '%') {
        if (!mod) throw fail('未启用模运算解析，无法使用“%”');
        at++;
        v = modulo(v, parseUnary());
      }
      else if (startsImplicitFactor()) { v = mul(v, parseUnary()); }
      else break;
    }
    return v;
  }

  /** 加、减（BigInt 与 number 的加减写法一致，无需分派） */
  function parseAdditive() {
    let v = parseMultiplicative();
    for (;;) {
      skipSpace();
      const ch = text[at];
      if (ch === '+') { at++; v += parseMultiplicative(); }
      else if (ch === '-') { at++; v -= parseMultiplicative(); }
      else break;
    }
    return v;
  }

  const result = parseAdditive();
  skipSpace();
  if (at < text.length) throw fail(`无法识别的字符“${text[at]}”`);
  if (high) return scaledToStore(result, scale);
  if (!Number.isFinite(result)) throw new NeonaicArithmeticError(`算式的结果不是有限数：${parseString(source)}`);
  return result;
}