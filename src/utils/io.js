import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstatSync, realpathSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';

import { NeonaicIllegalArgumentError, NeonaicIOError, NeonaicNetworkError } from "./NeonaicNewableError.js";
import { parseString } from "./text.js";

/**
 * Neonaic 网络相关工具
 */
export const neonaicNetwork = {
  /**
   * 带有超时地请求一个地址
   * @param {String|URL|Request} url 请求地址
   * @param {number} [timeout=10000] 默认超时时间，单位 ms
   * @returns {Promise<Response>}
   */
  fetch: async function (url, timeout = 10 * 1e3) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.abs(parseInt(timeout)));
    try {
      return await fetch(url, { signal: controller.signal });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        // 被超时中断
        throw new NeonaicNetworkError("Timeout for fetch", e);
      } else {
        throw new NeonaicNetworkError('Failed to fetch: ' + parseString(e), e);
      }
    } finally {
      clearTimeout(timer);
    }
  },
};

/** 项目根路径 */
const ROOT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * 把输入路径按“虚拟根”语义转换为绝对路径：去掉前导分隔符后，相对基准目录解析
 * @param {*} p 输入路径
 * @param {String} [base] 基准目录，默认项目根目录
 * @returns {String} 绝对路径
 */
function absolutize(p, base = ROOT_PATH) {
  // 去掉前导分隔符，这样 /a.js 会求值为 <base>/a.js，而不是重置到文件系统根
  return resolve(base, parseString(p).replace(/^[/\\]+/, ''));
}

/**
 * 判断路径在文本层面是否越出基准目录，**不解析软链接**
 * @param {String} target 目标绝对路径
 * @param {String} [base] 基准目录，默认项目根目录
 * @returns {boolean}
 */
function isOutsideLexical(target, base = ROOT_PATH) {
  const rel = relative(base, target);
  // 第一段是 '..' 才算越界；isAbsolute(rel) 兜 Windows 跨盘
  return rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel);
}

/**
 * 获取路径的 lstat 结果，不跟随最后一段软链接
 * @param {String} p 绝对路径
 * @returns {import('node:fs').Stats|null} 路径不存在时返回 null
 * @throws {NeonaicIOError} 无权限等 IO 错误
 */
function lstatOrNullSync(p) {
  try {
    return lstatSync(p);
  } catch (e) {
    if (e.code === 'ENOENT') return null;// 不存在
    throw new NeonaicIOError("无法访问目标文件(夹)", e);
  }
}

/** @see lstatOrNullSync */
async function lstatOrNull(p) {
  try {
    return await lstat(p);
  } catch (e) {
    if (e.code === 'ENOENT') return null;// 不存在
    throw new NeonaicIOError("无法访问目标文件(夹)", e);
  }
}

/**
 * 获取路径的真实路径（自动跟随软链接）
 * @param {String} p 绝对路径
 * @returns {String|null} 路径不存在时返回 null
 * @throws {NeonaicIOError} 无权限等 IO 错误
 */
function realpathOrNullSync(p) {
  try {
    return realpathSync(p);
  } catch (e) {
    if (e.code === 'ENOENT') return null;// 不存在
    throw new NeonaicIOError("无法访问目标文件(夹)", e);
  }
}

/** @see realpathOrNullSync */
async function realpathOrNull(p) {
  try {
    return await realpath(p);
  } catch (e) {
    if (e.code === 'ENOENT') return null;// 不存在
    throw new NeonaicIOError("无法访问目标文件(夹)", e);
  }
}

/**
 * 判断目标路径是否越出基准目录，**自动解析软链接**；目标尚不存在时回溯到最近的存在祖先参与比较
 * @param {String} target 目标绝对路径
 * @param {String} [base] 基准目录，默认项目根目录
 * @returns {boolean}
 * @throws {NeonaicIOError} 无权限等 IO 错误
 */
function isOutsideResolvedSync(target, base = ROOT_PATH) {
  const realBase = realpathOrNullSync(base) ?? base;

  let current = target;
  let realTarget = realpathOrNullSync(current);
  while (realTarget === null) {
    // 目标（或其父目录）尚不存在，向上回溯到最近的存在祖先
    const parent = dirname(current);
    if (parent === current) return false;// 回溯到文件系统根仍不存在，谈不上越界
    current = parent;
    realTarget = realpathOrNullSync(current);
  }

  return isOutsideLexical(realTarget, realBase);
}

/** @see isOutsideResolvedSync */
async function isOutsideResolved(target, base = ROOT_PATH) {
  const realBase = (await realpathOrNull(base)) ?? base;

  let current = target;
  let realTarget = await realpathOrNull(current);
  while (realTarget === null) {
    // 目标（或其父目录）尚不存在，向上回溯到最近的存在祖先
    const parent = dirname(current);
    if (parent === current) return false;// 回溯到文件系统根仍不存在，谈不上越界
    current = parent;
    realTarget = await realpathOrNull(current);
  }

  return isOutsideLexical(realTarget, realBase);
}

/**
 * 判断路径中是否存在软链接
 * @param {String} p 绝对路径
 * @param {Boolean} [everySegment=false] true 则从项目根开始逐段下探；false 只检查最后一段
 * @returns {boolean}
 * @throws {NeonaicIOError} 无权限等 IO 错误
 */
function containsSymlinkSync(p, everySegment = false) {
  const stats = lstatOrNullSync(p);
  if (!everySegment) return stats !== null && stats.isSymbolicLink();

  const rel = relative(ROOT_PATH, p);
  // 不在项目内则没有可逐段检查的起点，退化为只检查最后一段
  if (rel === '' || isOutsideLexical(p)) return stats !== null && stats.isSymbolicLink();

  let current = ROOT_PATH;
  for (const segment of rel.split(sep)) {
    if (segment === '' || segment === '.') continue;
    current = join(current, segment);
    const layer = lstatOrNullSync(current);
    if (layer === null) return false;// 这一段都不存在，后面的更不存在
    if (layer.isSymbolicLink()) return true;
  }
  return false;
}

/** @see containsSymlinkSync */
async function containsSymlink(p, everySegment = false) {
  const stats = await lstatOrNull(p);
  if (!everySegment) return stats !== null && stats.isSymbolicLink();

  const rel = relative(ROOT_PATH, p);
  // 不在项目内则没有可逐段检查的起点，退化为只检查最后一段
  if (rel === '' || isOutsideLexical(p)) return stats !== null && stats.isSymbolicLink();

  let current = ROOT_PATH;
  for (const segment of rel.split(sep)) {
    if (segment === '' || segment === '.') continue;
    current = join(current, segment);
    const layer = await lstatOrNull(current);
    if (layer === null) return false;// 这一段都不存在，后面的更不存在
    if (layer.isSymbolicLink()) return true;
  }
  return false;
}

/**
 * Neonaic 磁盘相关工具
 */
export const neonaicFileSystem = {
  /**
   * 安全解析路径，自动阻止路径穿越，**不会处理软链接，无论软链接指向哪里**
   * @apiNote 本方法会将首个参数虚拟为文件系统根目录进行求值，这样路径将始终维持在项目路径内。**如果需要得知发生路径穿越请用{@link neonaicFileSystem.resolveStrict}。**
   * @param {String} root 父路径，默认为项目根路径，自动以项目根路径进行解析
   * @param {String[]|*[]} path 路径符
   * @returns {String} 返回求值后路径
   */
  resolve: function (root = ROOT_PATH, ...path) {
    if (typeof root !== 'string') throw new NeonaicIllegalArgumentError("无法解析路径，因为根路径不是有效的字符串。");
    root = resolve(ROOT_PATH, root);
    /** 递归逐层求值 */
    function digAndEnsure(input, next) {
      if (Array.isArray(next)) {
        // next 是一个数组，逐项递归
        let pending = input;
        for (let index = 0; index < next.length; index++) {
          pending = digAndEnsure(pending, next[index]);
        }
        return pending;
      } else if (next === "" || next === null || next === undefined) {
        // 如果没有下一步就直接返回
        return input;
        // 本闭包函数的 input 始终不是用户输入，因此无需穿越检测
      } else {
        // 非数组：把 next 当“相对片段”，去掉前导分隔符，
        // 这样 /a.js 在虚拟根下解析为 $root/a.js，而不是重置到文件系统根
        const seg = parseString(next).replace(/^[/\\]+/, '');

        // 用 join 而非 resolve：join 不会因绝对段重置基准
        const pending = join(input, seg);

        const rel = relative(root, pending);

        // 第一段是 '..' 才算越界；isAbsolute(rel) 兜 Windows 跨盘
        if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
          return root;
        }
        return pending;
      };
    }
    return digAndEnsure(root, path);
  },

  /**
   * 安全解析路径，路径穿越自动抛错，**包括任何形式的软链接，无论软链接指向哪里**
   * @param {String} root 父路径，默认为项目根路径，自动以项目根路径进行解析
   * @param {String[]|*[]} path 路径符
   * @throws {NeonaicIOError} 发生路径穿越
   * @returns {String} 返回求值后路径
   */
  resolveStrict: function (root = ROOT_PATH, ...path) {
    if (typeof root !== 'string') throw new NeonaicIllegalArgumentError("无法解析路径，因为根路径不是有效的字符串。");
    root = resolve(ROOT_PATH, root);
    /** 递归逐层求值 */
    function digAndEnsure(input, next) {
      if (Array.isArray(next)) {
        // next 是一个数组，逐项递归
        let pending = input;
        for (let index = 0; index < next.length; index++) {
          pending = digAndEnsure(pending, next[index]);
        }
        return pending;
      } else if (next === "" || next === null || next === undefined) {
        // 如果没有下一步就直接返回
        return input;
        // 本闭包函数的 input 始终不是用户输入，因此无需穿越检测
      } else {
        // 非数组：把 next 当“相对片段”，去掉前导分隔符，
        // 这样 /a.js 在虚拟根下解析为 $root/a.js，而不是重置到文件系统根
        const seg = parseString(next).replace(/^[/\\]+/, '');

        // 用 join 而非 resolve：join 不会因绝对段重置基准
        const pending = join(input, seg);

        // 复用下方 isTraversalSync 的 realpath 方案：软链接指向项目外同样算穿越；
        // 另外软链接无论指向哪里（哪怕指向项目内）也一律拒绝
        if (neonaicFileSystem.isTraversalSync(pending) || containsSymlinkSync(pending, true)) {
          throw new NeonaicIOError("访问非法路径");
        }
        return pending;
      };
    }
    return digAndEnsure(root, path);
  },

  /**
   * 判断一个文件是否是符号链接
   * @apiNote 参数按虚拟根语义解析；越出项目根的输入按“不存在”处理（返回 false），
   *          避免因为绝对路径或 `..` 而去访问项目外的目录项。
   * @param {String} p 目标路径，相对于项目目录
   * @returns {Promise<boolean>}
   * @throws {NeonaicIOError} 无权限等 IO 错误
   */
  isSymlink: async function (p) {
    const target = absolutize(p);
    if (isOutsideLexical(target)) return false;// 越界输入按不存在处理
    return containsSymlink(target);
  },

  /**
   * 判断一个文件是否是符号链接
   * @apiNote 参数按虚拟根语义解析；越出项目根的输入按“不存在”处理（返回 false），
   *          避免因为绝对路径或 `..` 而去访问项目外的目录项。
   * @param {String} p 目标路径，相对于项目目录
   * @returns {boolean}
   * @throws {NeonaicIOError} 无权限等 IO 错误
   */
  isSymlinkSync: function (p) {
    const target = absolutize(p);
    if (isOutsideLexical(target)) return false;// 越界输入按不存在处理
    return containsSymlinkSync(target);
  },

  /**
   * 判断一个路径是否指向了指定目录之外，自动处理软链接；目标尚不存在时会回溯到最近的存在祖先参与比较
   * @apiNote 参数按 `path.resolve` 语义解析（绝对路径按字面处理，不做虚拟根映射），
   *          因此可以直接用来校验已经求值过的绝对路径，例如{@link neonaicFileSystem.resolveStrict}内部的结果。
   * @param {String} p 要判断的路径
   * @param {String} [t] “指定目录”，默认项目目录
   * @returns {Promise<boolean>}
   * @throws {NeonaicIOError} 无权限等 IO 错误
   */
  isTraversal: async function (p, t = ROOT_PATH) {
    return isOutsideResolved(resolve(t, parseString(p)), resolve(t));
  },

  /**
   * 判断一个路径是否指向了指定目录之外，自动处理软链接；目标尚不存在时会回溯到最近的存在祖先参与比较
   * @apiNote 参数按 `path.resolve` 语义解析（绝对路径按字面处理，不做虚拟根映射），
   *          因此可以直接用来校验已经求值过的绝对路径，例如{@link neonaicFileSystem.resolveStrict}内部的结果。
   * @param {String} p 要判断的路径
   * @param {String} [t] “指定目录”，默认项目目录
   * @returns {boolean}
   * @throws {NeonaicIOError} 无权限等 IO 错误
   */
  isTraversalSync: function (p, t = ROOT_PATH) {
    return isOutsideResolvedSync(resolve(t, parseString(p)), resolve(t));
  },
};