import { getLogger } from '#src/logger/Logger.js';

import { hackerConsoleConfig } from './config.js';
import { hackerConsoleServer } from './server.js';

/**
 * 拓展启用钩子：起一个只监听回环的 HTTP 服务。
 *
 * 配置在 `onEnable` 时读一次；改了 `config.json` 需要重载并重启拓展。
 *
 * @this {import('#src/extension/extLoader.js').NeonaicExtItem}
 * @param {{ manifest: Object, pwd: String, ext_item_id: String, ext_item_timestamp: Number }} _extCtx
 */
export async function onEnable(_extCtx) {
  const config = hackerConsoleConfig.load();
  for (const issue of config.issues) {
    getLogger().ext.warn(`[hacker-console] 配置问题：${issue}`);
  }

  const info = await hackerConsoleServer.start(config);

  getLogger().ext.warn(`[hacker-console] 测试控制台已启动：${info.url}`);
  getLogger().ext.warn(
    '[hacker-console] 它会把页面上的任意代码直接送进 aicode 沙箱执行 —— 仅供安全测试，用完请卸载本拓展',
  );
}

/**
 * 拓展卸载钩子：关服务、断开所有连接、回收自己授出的权限。幂等。
 *
 * @this {import('#src/extension/extLoader.js').NeonaicExtItem}
 */
export async function onDisable() {
  await hackerConsoleServer.stop();
}
