/**
 * 为 Profile 组件提供预定义的 API 能力
 * 
 * @module PlatformUtils
 * @author kdxiaoyi
 * @since 0.1.0
 */

/**
 * @typedef {Object} NeonaicUriOptions
 * @property {boolean} [resolveRealAddress=false] 如果传入域名，尝试解析IP地址（耗时操作，**将使得函数返回 Promise**）
 * @property {boolean} [lookupBindedDomain=false] 如果传入IP地址，尝试反查对应域名（耗时操作，**将使得函数返回 Promise**）
 * @since 0.1.0
 */

/**
 * 判断主机地址的格式类型
 * @param {string} host 主机地址
 * @return {'ipv4'|'ipv6'|'string'} 主机地址格式
 */
function classifyHost(host) {
  const value = host.replace(/^\[|\]$/g, '');
  if (!value) return 'string';
  if (value.includes(':')) return 'ipv6';
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) return 'ipv4';
  return 'string';
}

/**
 * 判断指定主机是否为内网/本地资源
 * @param {string} host 主机地址
 * @param {'ipv4'|'ipv6'|'string'} type 主机地址格式
 * @return {boolean} 是否为内网资源
 */
function isPrivateHost(host, type) {
  const value = host.replace(/^\[|\]$/g, '');
  if (type === 'ipv4') {
    // 10.0.0.0/8、127.0.0.0/8、0.0.0.0/8、169.254.0.0/16、192.168.0.0/16、172.16.0.0/12
    return /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(value);
  }
  if (type === 'ipv6') {
    // ::1 回环地址、fc00::/7 唯一本地地址、fe80::/10 链路本地地址
    const lower = value.toLowerCase();
    return /^::1$/.test(lower) || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
  }
  // 域名形式：localhost 以及常见的内网域名后缀
  return value === 'localhost' || /\.(local|internal|lan|localdomain|home|corp|private)$/i.test(value);
}

/**
 * 将 URLSearchParams 转为 Map 形式
 * @param {URLSearchParams} searchParams URL 查询参数
 * @return {Map<string, Array<string>>} 查询字符串的键值映射
 */
function parseQuery(searchParams) {
  const map = new Map();
  for (const [key, value] of searchParams.entries()) {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  }
  return map;
}

/**
 * 将原始 URI 规范化为 {@link URL} 对象，缺失协议头时自动补全为 http
 * @param {string|URL} uri 原始 URI
 * @return {URL} 标准化后的 URL 对象
 */
function normalizeUrl(uri) {
  if (uri instanceof URL) return new URL(uri.href);
  let str = String(uri).trim();
  if (str.startsWith('//')) str = `http:${str}`;
  else if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(str)) str = `http://${str}`;
  return new URL(str);
}

/**
 * NeonaiConnector URI 标准传递协议
 *
 * 解析并标准化一个 URI，统一提供协议头、主机、端口、路径、查询、锚点等信息的访问方式。
 * 该类仅负责同步解析，DNS 相关的异步能力（{@link NeonaicUriOptions.resolveRealAddress}、
 * {@link NeonaicUriOptions.lookupBindedDomain}）由 {@link resolveUri} 负责。
 *
 * @class NeonaicUriMeta
 * @since 0.1.0
 */
export class NeonaicUriMeta {
  /**
   * 该 URI 是否尝试访问内网资源，推荐开启 {@link NeonaicUriOptions.resolveRealAddress} 提高准确性
   * @type {boolean}
   */
  isAccessingIntranet = false;

  /**
   * 协议头（scheme），例如 "http"、"https"、"ws"，不含冒号
   * @type {string}
   */
  scheme = '';

  /**
   * 账号（明文）
   * @deprecated 不推荐使用明文账号密码
   * @type {string}
   */
  username = '';

  /**
   * 密码（明文）
   * @deprecated 不推荐使用明文账号密码
   * @type {string}
   */
  password = '';

  /**
   * 主机地址
   * @type {string}
   */
  host = '';

  /**
   * 另一种格式的主机地址，需要开启 {@link NeonaicUriOptions.lookupBindedDomain}，
   * 未开启返回 undefined，查询失败返回空字符串
   * @type {string|undefined}
   */
  host2 = undefined;

  /**
   * 主机地址格式
   * @type {'ipv4'|'ipv6'|'string'}
   */
  type = 'string';

  /**
   * 主机端口，无返回 0
   * @type {number}
   */
  port = 0;

  /**
   * URI 的地址（路径部分），不含查询字符串与锚点
   * @type {string}
   */
  path = '';

  /**
   * URI 的查询字符串，以键值对形式存储，一个键可能对应多个值
   * @type {Map<string, Array<string>>}
   */
  query = new Map();

  /**
   * URI 的片段(Fragment) 或 锚点(Hash)，通常不发送到服务器，返回值不含 "#"
   * @type {string}
   */
  hash = '';

  /**
   * 可以直接使用的 {@link URL} 对象，如果缺失协议头将自动设为 http
   * @type {URL}
   */
  url = null;

  /**
   * 创建一个 URI 元信息实例
   * @param {string|URL} uri 原始 URI
   * @apiNote 不推荐直接新建本类，请改用{@link resolveUri}获取更多功能
   */
  constructor(uri) {
    const url = normalizeUrl(uri);

    this.url = url;
    this.scheme = url.protocol.replace(/:$/, '');
    this.username = decodeURIComponent(url.username || '');
    this.password = decodeURIComponent(url.password || '');
    this.host = url.hostname;
    this.port = url.port ? Number(url.port) : 0;
    this.path = url.pathname;
    this.query = parseQuery(url.searchParams);
    this.hash = url.hash ? url.hash.slice(1) : '';

    this.type = classifyHost(this.host);
    this.isAccessingIntranet = isPrivateHost(this.host, this.type);
  }

  /**
   * 将本对象转为一个可用的 URI 文本
   * @return {string} 可用的 URI 文本
   */
  toString() {
    const scheme = this.scheme || 'http';
    let host = this.host;
    if (this.type === 'ipv6' && !host.startsWith('[')) {
      host = `[${host}]`;
    }
    const auth =
      this.username || this.password
        ? `${encodeURIComponent(this.username)}:${encodeURIComponent(this.password)}@`
        : '';
    const port = this.port ? `:${this.port}` : '';
    const query = [...this.query.entries()]
      .map(([key, values]) =>
        values.map((value) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&'),
      )
      .join('&');
    return `${scheme}://${auth}${host}${port}${this.path}${query ? `?${query}` : ''}${this.hash ? `#${this.hash}` : ''}`;
  }
}

/**
 * 解析 URI 的 IP 地址（仅当传入的是域名时有效），结果写入 host 与 type
 * @param {NeonaicUriMeta} meta 元信息实例
 * @return {Promise<void>} 解析完成
 */
async function resolveRealAddress(meta) {
  if (meta.type !== 'string') return;
  try {
    const dns = await import('node:dns');
    const { address, family } = await dns.promises.lookup(meta.host);
    meta.host = address;
    meta.type = family === 6 ? 'ipv6' : 'ipv4';
    meta.isAccessingIntranet = isPrivateHost(meta.host, meta.type);
  } catch (err) {
    // DNS 解析失败时保留原主机地址
  }
}

/**
 * 反查 IP 地址绑定的域名，结果写入 host2
 * @param {NeonaicUriMeta} meta 元信息实例
 * @return {Promise<void>} 反查完成
 */
async function lookupBindedDomain(meta) {
  if (meta.type === 'string') return;
  try {
    const dns = await import('node:dns');
    const hostnames = await dns.promises.reverse(meta.host);
    meta.host2 = hostnames[0] || '';
  } catch (err) {
    meta.host2 = '';
  }
}

/**
 * 解析并返回一个 URL 的信息
 * @param {string|URL} uri 原始 URI
 * @param {NeonaicUriOptions} options 参数
 * @return {NeonaicUriMeta|Promise<NeonaicUriMeta>} 返回是否为 Promise 取决于参数
 * @since 0.1.0
 */
export function resolveUri(uri, options = {}) {
  const { resolveRealAddress = false, lookupBindedDomain = false } = options;
  const meta = new NeonaicUriMeta(uri, options);

  // 未开启异步解析能力时直接同步返回
  if (!resolveRealAddress && !lookupBindedDomain) {
    return meta;
  }

  // 需要 DNS 解析，返回 Promise
  return (async () => {
    if (resolveRealAddress) await resolveRealAddress(meta);
    if (lookupBindedDomain) await lookupBindedDomain(meta);
    return meta;
  })();
}