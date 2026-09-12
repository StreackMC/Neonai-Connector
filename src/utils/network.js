import { NeonaicError } from "./NeonaicNewableError.js";

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
  fetch: async function (url, [timeout = 10 * 1e3]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.abs(parseInt(timeout)));
    try {
      return await fetch(url, { signal: controller.signal });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        // 被超时中断
        throw new NeonaicError("Timeout for fetch");
      }
    } finally {
      clearTimeout(timer);
    }
  }
}