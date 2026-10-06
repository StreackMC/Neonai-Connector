/**
 * extensions/joyous — Streack Joyous for Neonaic
 *
 * JoyousPlugin（Minecraft 服务端的 Java 插件）与 Neonaic 之间的衔接层。
 *
 * ── 本文件只做四件事（组合根）──
 *   1. 读配置（{@link joyousConfig}）
 *   2. 装配传输通道（{@link NeonaicJoyousHttpClient} / {@link NeonaicJoyousHttpServer}
 *      / {@link NeonaicJoyousUdsLink}）
 *   3. 注册对外能力（命令与 AI 工具）—— 命令/AI 工具用**惰性运行期解析**，
 *      所以在通道未启用时会给出可读提示而不是抛错
 *   4. 优雅关闭
 *
 * ── 分层（谁不依赖谁）──
 *   entry.js      组合根：唯一同时认识「配置 / 传输 / 业务」的地方
 *   config.js     配置读取与归一化
 *   status.js     状态业务：只依赖注入的 query(address)
 *   protocol/     通信层：不认识命令系统
 *     dispatch.js 唯一接缝：认识命令系统，但不认识具体传输
 *
 * 协议文档见 ../PROTOCOL.md 。
 */

import z from 'zod';

import { neonaicAI } from '../../../src/message/ai.js';
import { neonaicCommandInterface } from '../../../src/command/commandInterface.js';
import { neonaicCommandServer } from '../../../src/command/commandServer.js';
import { neonaicPermissionServer } from '../../../src/command/permissionServer.js';
import { neonaicConfManager } from '../../../src/system/confManager.js';
import { getLogger } from '../../../src/logger/Logger.js';

import { joyousConfig } from './config.js';
import { NeonaicStatusReader } from './status.js';
import { joyousDispatcher } from './protocol/dispatch.js';
import { CAPABILITIES, METHODS } from './protocol/constants.js';
import { NeonaicJoyousHttpClient, NeonaicJoyousHttpServer } from './protocol/http.js';
import { NeonaicJoyousUdsLink } from './protocol/uds.js';

/**
 * 运行期状态。`null` 表示拓展尚未启用（或已被停用）。
 * @type {{
 *   cfg: object, logger: object, httpClient: NeonaicJoyousHttpClient,
 *   httpServer: NeonaicJoyousHttpServer|null, uds: NeonaicJoyousUdsLink|null,
 *   statusReader: NeonaicStatusReader
 * }|null}
 */
let runtime = null;

// =====================================================================
// 对外能力：命令
// =====================================================================

neonaicCommandServer.registerCommand('joyous', 'mc', async function (address) {
  const rt = runtime;
  if (!rt) return disabledNotice();
  return rt.statusReader.describeServer(address);
}, {
  description: '查询 Minecraft 服务器在线状态',
  usage: 'mc [address]',
  permissions: [],
});

neonaicCommandServer.registerCommand('joyous', 'bridge', function () {
  const rt = runtime;
  if (!rt) return disabledNotice();
  return renderBridgeStatus(rt);
}, {
  description: '查看 Joyous 桥接（HTTP / UDS 通道）的运行状态与授权情况',
  usage: 'bridge',
  permissions: [[
    neonaicCommandInterface.COMMAND_ENUMS.PERM_ADMIN,
    neonaicCommandInterface.COMMAND_ENUMS.PERM_SUPERADMIN,
  ]],
});

// =====================================================================
// 对外能力：AI 工具
// =====================================================================

neonaicAI.registerAITool('joyous', 'worldMeta', {
  description: '查询 Minecraft 世界天气状况与时间情况。缺省从拓展配置的 status.address 处获取数据。',
  inputSchema: z.object({
    address: z.string().optional().describe('数据来源，需要是 Joyous StatusAPI 格式；缺省时使用配置中的默认地址。'),
  }),
  execute: async ({ address }) => {
    const rt = runtime;
    if (!rt) return disabledNotice();
    return rt.statusReader.describeWorld(address);
  },
});

neonaicAI.registerAITool('joyous', 'serverStatus', {
  description: '查询 Minecraft 服务器在线状态（TPS、在线玩家数、玩家列表、下次更新时间等）。'
    + '缺省从拓展配置的 status.address 处获取数据。',
  inputSchema: z.object({
    address: z.string().optional().describe('数据来源地址，需符合 Joyous StatusAPI 格式；缺省时使用配置中的默认地址。'),
  }),
  execute: async ({ address }) => {
    const rt = runtime;
    if (!rt) return disabledNotice();
    return rt.statusReader.describeServer(address);
  },
});

// =====================================================================
// 生命周期
// =====================================================================

/**
 * 拓展启用钩子。
 * @this {import('../../../src/extension/extLoader.js').NeonaicExtItem}
 * @param {{ manifest: Object, pwd: String, ext_item_id: String, ext_item_timestamp: Number }} [ctx] 拓展上下文
 */
export async function onEnable(ctx) {
  const logger = getLogger().ext;

  // 幂等：loader 在某些路径下可能重复调用，重复启动会抢端口 / 建两条 UDS 连接
  if (runtime) {
    logger.warn('[joyous] 拓展已处于启用状态，忽略重复的启用请求');
    return;
  }

  const cfg = joyousConfig.load();
  for (const issue of cfg.issues) logger.warn(`[joyous] 配置问题：${issue}`);

  const self = {
    name: neonaicConfManager.getBotName(),
    version: readExtensionVersion(ctx),
    capabilities: [CAPABILITIES.COMMAND_EXECUTE, CAPABILITIES.STATUS_QUERY],
  };

  const httpClient = new NeonaicJoyousHttpClient({ timeoutMs: cfg.status.timeoutMs, log: logger });

  /** @type {NonNullable<typeof runtime>} */
  const rt = {
    cfg,
    logger,
    httpClient,
    httpServer: null,
    uds: null,
    statusReader: null,
  };
  // 先挂上运行期，query 里才能看到后续建立的 UDS 链路
  runtime = rt;

  rt.statusReader = new NeonaicStatusReader({
    query: createStatusQuery(rt),
    serverName: cfg.status.serverName,
    maxPlayerListed: cfg.status.maxPlayerListed,
  });

  const commandHandler = (request) => joyousDispatcher.execute(request, {
    timeoutMs: cfg.dispatch.commandTimeoutMs,
  });

  try {
    if (cfg.httpServer.enabled) {
      rt.httpServer = new NeonaicJoyousHttpServer({
        handler: commandHandler,
        host: cfg.httpServer.host,
        port: cfg.httpServer.port,
        path: cfg.httpServer.path,
        healthPath: cfg.httpServer.healthPath,
        token: cfg.httpServer.token,
        selfName: self.name,
        selfVersion: self.version,
        log: logger,
      });
      await rt.httpServer.start();
    } else {
      logger.info('[joyous] 未启用 HTTP 命令服务端（httpServer.enabled = false）');
    }

    if (cfg.uds.enabled) {
      rt.uds = new NeonaicJoyousUdsLink({
        path: cfg.uds.path,
        pipe: cfg.uds.pipe,
        mode: cfg.uds.handshake,
        self,
        methods: {
          [METHODS.COMMAND_EXECUTE]: commandHandler,
          [METHODS.STATUS_QUERY]: (payload) => queryStatusOverUds(rt, payload),
        },
        timeouts: {
          CONNECT: cfg.uds.connectTimeoutMs,
          HANDSHAKE: cfg.uds.handshakeTimeoutMs,
          REQUEST: cfg.uds.requestTimeoutMs,
          HEARTBEAT: cfg.uds.heartbeatMs,
        },
        reconnect: cfg.uds.reconnect,
        log: logger,
      });
      rt.uds.start();
    } else {
      logger.info('[joyous] 未启用 UDS 链路（uds.enabled = false）');
    }
  } catch (e) {
    // 半启动状态比不启动更糟：回滚干净再把错误抛给拓展管理器
    await shutdown(rt, '启用过程中出错');
    runtime = null;
    throw e;
  }

  logger.info(
    `[joyous] 拓展已启用：状态查询传输 ${cfg.status.transport}，`
    + `目标 ${cfg.status.address}，HTTP 服务端 ${cfg.httpServer.enabled ? '开' : '关'}，`
    + `UDS ${cfg.uds.enabled ? '开' : '关'}`,
  );
}

/**
 * 拓展卸载钩子。幂等：未启用时静默返回。
 * @this {import('../../../src/extension/extLoader.js').NeonaicExtItem}
 */
export async function onDisable() {
  const rt = runtime;
  if (!rt) return;
  runtime = null;
  await shutdown(rt, '拓展被停用');
}

// =====================================================================
// 内部：装配
// =====================================================================

/**
 * 构造状态查询函数。
 * 依据 `status.transport` 决定走 UDS 还是 HTTP：
 *   - `'http'`：始终走 HTTP StatusAPI
 *   - `'uds'` ：始终走 UDS（失败即失败，不静默回退）
 *   - `'auto'`：UDS 就绪则优先走 UDS，失败或未就绪则回退 HTTP
 * @param {NonNullable<typeof runtime>} rt
 * @returns {(address: string) => Promise<{ok: true, data: object}|{ok: false, reason: string}>}
 */
function createStatusQuery(rt) {
  const { cfg, logger, httpClient } = rt;

  return async function query(address) {
    const target = address || cfg.status.address;
    const uds = rt.uds;

    if (cfg.status.transport !== 'http' && uds?.ready) {
      try {
        const payload = await uds.request(
          METHODS.STATUS_QUERY,
          { address: target },
          cfg.uds.requestTimeoutMs,
        );
        if (payload?.ok === true) return { ok: true, data: payload.data };
        if (payload?.ok === false) return { ok: false, reason: String(payload.reason ?? 'unknown') };
        // 对端若直接回传状态体，也接受
        return { ok: true, data: payload };
      } catch (e) {
        if (cfg.status.transport === 'uds') {
          return { ok: false, reason: e?.message ?? String(e) };
        }
        logger.warn(`[joyous] 经 UDS 查询状态失败，回退 HTTP：${e?.message ?? e}`);
      }
    }

    return httpClient.fetchStatus(target);
  };
}

/**
 * `status.query` 方法的实现（供对端经 UDS 调用）。
 * @param {NonNullable<typeof runtime>} rt
 * @param {object} payload `{ address? }`
 * @returns {Promise<{ok: true, data: object}|{ok: false, reason: string}>}
 */
async function queryStatusOverUds(rt, payload) {
  const result = await rt.statusReader.read(payload?.address);
  return result.ok
    ? { ok: true, data: result.data }
    : { ok: false, reason: result.reason };
}

/**
 * 停止运行期的全部通道。
 * @param {NonNullable<typeof runtime>} rt
 * @param {string} reason
 * @returns {Promise<void>}
 */
async function shutdown(rt, reason) {
  const jobs = [];

  if (rt.uds) {
    try {
      rt.uds.stop();
    } catch (e) {
      rt.logger.error(`[joyous] 关闭 UDS 链路时出错：${e?.message ?? e}`);
    }
  }

  if (rt.httpServer) {
    jobs.push(
      rt.httpServer.stop().catch((e) => {
        rt.logger.error(`[joyous] 关闭 HTTP 服务端时出错：${e?.message ?? e}`);
      }),
    );
  }

  await Promise.all(jobs);
  rt.logger.info(`[joyous] 桥接已关闭（${reason}）`);
}

/**
 * 从拓展上下文读取版本号用于自述。
 * @param {{ manifest?: Object }|undefined} ctx
 * @returns {string}
 */
function readExtensionVersion(ctx) {
  try {
    const manifest = ctx?.manifest;
    const meta = (typeof manifest?.getSection === 'function')
      ? manifest.getSection('meta')
      : manifest?.meta;
    const version = meta?.version;
    if (Array.isArray(version) && version.length > 1) return String(version[1]);
  } catch {
    // 仅用于自述，读不到就用兜底值
  }
  return '0.2.0';
}

/**
 * 拓展未启用时的统一提示。
 * @returns {string}
 */
function disabledNotice() {
  return `“${neonaicConfManager.getBotName()}”的 Joyous 桥接尚未启用，无法完成该操作。`;
}

/**
 * 渲染桥接状态文本。
 * @param {NonNullable<typeof runtime>} rt
 * @returns {string}
 */
function renderBridgeStatus(rt) {
  const { cfg } = rt;
  const lines = ['Joyous 桥接状态：'];

  // HTTP 服务端
  if (rt.httpServer?.running) {
    const addr = rt.httpServer.address;
    lines.push(
      `· HTTP 命令服务端：监听 http://${addr.host}:${addr.port}${rt.httpServer.commandPath}`
      + `${cfg.httpServer.token ? '（已启用令牌校验）' : '（未配置令牌）'}`,
    );
  } else {
    lines.push('· HTTP 命令服务端：未启用');
  }

  // UDS
  if (rt.uds) {
    const s = rt.uds.status;
    lines.push(
      `· UDS 链路：${s.state}${s.ready ? '' : '（未就绪）'}，端点 ${s.endpoint}（平台 ${s.platform}）`
      + `${s.attempts > 0 ? `，累计失败 ${s.attempts} 次` : ''}`,
    );
    if (s.peer) {
      lines.push(`  对端：${s.peer.role}/${s.peer.name} v${s.peer.version}，能力 ${s.peer.capabilities.join(', ') || '无'}`);
    }
    if (s.lastError) lines.push(`  最近错误：${s.lastError}`);
    if (s.nextRetryAt) lines.push(`  下次重连：${new Date(s.nextRetryAt).toLocaleString()}`);
  } else {
    lines.push('· UDS 链路：未启用');
  }

  // 授权
  const gateOk = neonaicPermissionServer.checkSinglePermission(
    joyousDispatcher.BRIDGE_EXECUTOR,
    joyousDispatcher.BRIDGE_GATE_PERMISSION,
  );
  lines.push(`· 状态查询传输：${cfg.status.transport}（目标 ${cfg.status.address}）`);
  lines.push(
    `· 执行授权（${joyousDispatcher.BRIDGE_EXECUTOR}）：总闸 ${joyousDispatcher.BRIDGE_GATE_PERMISSION} `
    + `${gateOk ? '✓ 已授予' : '× 未授予（对端将无法执行任何命令）'}`,
  );
  if (!gateOk) {
    lines.push(
      '  如需放行，请执行：'
      + `/neonaic:permission set ${joyousDispatcher.BRIDGE_EXECUTOR} ${joyousDispatcher.BRIDGE_GATE_PERMISSION} true`,
    );
  }

  return lines.join('\n');
}
