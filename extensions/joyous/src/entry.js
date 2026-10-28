/**
 * extensions/joyous — Streack Joyous for Neonaic
 *
 * JoyousPlugin（Minecraft 服务端的 Java 插件）与 Neonaic 之间的衔接层。
 *
 * ── 本文件只做四件事（组合根）──
 *   1. 读配置（{@link joyousConfig}）
 *   2. 装配传输通道（{@link JoyousHttpClient} / {@link JoyousHttpServer}
 *      / {@link JoyousUdsLink}）与 V2 业务层（{@link joyousMethods.createBridgeLayer}）
 *   3. 注册对外能力（命令与 AI 工具）—— 命令/AI 工具用**惰性运行期解析**，
 *      所以在通道未启用时会给出可读提示而不是抛错
 *   4. 优雅关闭
 *
 * ── 分层（谁不依赖谁）──
 *   entry.js      组合根：唯一同时认识「配置 / 传输 / 业务」的地方
 *   config.js     配置读取与归一化
 *   identity.js   MC ↔ 聊天身份绑定表（V2 `identity.*` 的数据）
 *   status.js     状态业务：只依赖注入的 query(address)
 *   protocol/     通信层与业务层：不认识彼此的内部实现
 *     dispatch.js 接缝一：认识命令系统，但不认识具体传输
 *     methods.js  接缝二：认识平台 / AI / 身份，但不认识具体传输
 *
 * 协议文档：../PROTOCOL.md（V1）、../PROTOCOL-V2.md（V2）。
 */

import z from 'zod';

import { neonaicAI } from '../../../src/message/ai.js';
import { neonaicCommandInterface } from '../../../src/command/commandInterface.js';
import { neonaicCommandServer } from '../../../src/command/commandServer.js';
import { neonaicPermissionServer } from '../../../src/command/permissionServer.js';
import { neonaicConfManager } from '../../../src/system/confManager.js';
import { neonaicEventBus } from '../../../src/event/neonaicEventBus.js';
import { NeonaicMessageEvent } from '../../../src/event/neonaicEventInterface.js';
import { getLogger } from '../../../src/logger/Logger.js';

import { joyousConfig } from './config.js';
import { joyousIdentity } from './identity.js';
import { JoyousStatusReader } from './status.js';
import { joyousDispatcher } from './protocol/dispatch.js';
import { joyousMethods } from './protocol/methods.js';
import { BUSINESS_METHODS, METHODS, NEONAI_CAPABILITIES } from './protocol/constants.js';
import { JoyousHttpClient, JoyousHttpServer } from './protocol/http.js';
import { JoyousUdsLink } from './protocol/uds.js';
import { neonaicChore, parseString } from '../../../src/utils/chore.js';

/**
 * 拓展停用时要摘掉的事件订阅。
 * @type {Array<() => void>}
 */
let detachers = [];

/**
 * 运行期状态。`null` 表示拓展尚未启用（或已被停用）。
 * @type {{
 *   cfg: object, logger: object, httpClient: JoyousHttpClient,
 *   httpServer: JoyousHttpServer|null, uds: JoyousUdsLink|null,
 *   statusReader: JoyousStatusReader, bridge: object
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
  description: '查询 Minecraft 服务器在线状态，需要 JoyousStatusAPI',
  usage: 'mc [address]',
  permissions: ['joyous.command.mc'],
  permissionDefault: true
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

/**
 * `/joyous:bind <code>` —— 用游戏内取得的绑定代码，把自己的聊天账号与 MC 玩家绑定。
 * `/joyous:bind clear` —— 解除自己的绑定。
 *
 * @apiNote 关联的权威持有方在本端；对端只持一次性、短时效的「代码 → UUID」映射
 *          （PROTOCOL-V2 §5.7）。因此成功后**必须**把结果落到本地绑定表。
 */
neonaicCommandServer.registerCommand('joyous', 'bind', async function (...args) {
  const rt = runtime;
  if (!rt) return disabledNotice();

  const self = requireSelfExecutor(this);
  if (!self.ok) return self.message;

  if (!args.length) {
    return '用法：/joyous:bind <绑定代码>（在游戏内执行 /neonaicbindidentity 取得）'
      + '，或 /joyous:bind clear 解除自己的绑定。';
  }

  if (String(args[0]).toLowerCase() === 'clear') {
    return clearOwnBinding(rt, self.chatId);
  }

  // 代码可能被平台分词（"K7M 2QP"）或因可读性写成 "K7M-2QP"，这里拼回去交给对端归一化
  const code = args.join('').trim();
  const profile = pickProfileFor(rt.cfg, self.chatId);
  if (!profile) return profileAmbiguityMessage(rt.cfg);

  let result;
  try {
    result = await rt.bridge.claimIdentity({
      code,
      chatId: self.chatId,
      profile,
      // 昵称对端只存档用；取不到可读名就留空，绝不传原始代号当名字
      user: { name: joyousMethods.readableNameOf(self.chatId), subname: '' },
    });
  } catch (e) {
    return claimFailureMessage(e, code);
  }

  const mc = {
    name: String(result?.mc?.name ?? '').trim(),
    uuid: String(result?.mc?.uuid ?? '').trim(),
  };
  if (!mc.uuid && !mc.name) {
    return '绑定未完成：对端没有返回有效的 MC 身份。';
  }

  const binding = joyousIdentity.bind(profile, mc, String(result?.chatId ?? self.chatId).trim());
  rt.bridge.notifyIdentityChanged({ profile, mc, chatId: binding.chatId, bound: true });
  rt.logger?.info?.(`[joyous] /joyous:bind：${mc.name || mc.uuid} ↔ ${binding.chatId}（profile ${profile}）`);

  return `已绑定到 MC 玩家 ${mc.name || mc.uuid}。`
    + `\n如需解除，可在游戏内执行 /neonaicunbindidentity，或在此执行 /joyous:bind clear 。`;
}, {
  description: '用游戏内取得的绑定代码，把自己的聊天账号与 MC 玩家绑定（自助）',
  usage: 'bind <code> | bind clear',
  permissions: ['joyous.bind'],
  permissionDefault: true,
});

/**
 * `/joyous:chatsync [on|off]` —— 自助设置「是否允许把自己的聊天同步到游戏服务器侧」。
 *
 * @apiNote 只允许改**调用者自己**的那一项权限（`joyous.chatsync.disabled`），
 *          不提供任何改他人或改其它权限的能力，因此可以放心下发给所有用户。
 */
neonaicCommandServer.registerCommand('joyous', 'chatsync', function (...args) {
  const rt = runtime;
  if (!rt) return disabledNotice();

  const self = requireSelfExecutor(this);
  if (!self.ok) return self.message;

  const disabled = joyousMethods.isChatSyncDisabled(self.chatId);
  const state = () => (joyousMethods.isChatSyncDisabled(self.chatId)
    ? '当前**不会**把你的聊天同步到服务器侧。'
    : '当前**会**把你的聊天同步到服务器侧。');
  const usage = '用法：/joyous:chatsync on 允许同步，/joyous:chatsync off 停止同步。';

  const sub = String(args[0] ?? '').toLowerCase();
  if (!sub) return `${state()}\n${usage}`;

  const enableWords = ['on', 'enable', 'open', '开', '开启', '允许'];
  const disableWords = ['off', 'disable', 'close', '关', '关闭', '停止'];
  if (enableWords.includes(sub)) {
    neonaicPermissionServer.clearPermission(self.chatId, joyousMethods.CHAT_SYNC_DISABLED_PERMISSION);
  } else if (disableWords.includes(sub)) {
    neonaicPermissionServer.setPermission(self.chatId, joyousMethods.CHAT_SYNC_DISABLED_PERMISSION, true);
  } else {
    return `${state()}\n${usage}`;
  }

  rt.logger?.info?.(`[joyous] /joyous:chatsync ${sub}：${self.chatId}`);
  return state();
}, {
  description: '设置是否允许把自己的聊天同步到游戏服务器侧（只影响自己）',
  usage: 'chatsync [on|off]',
  permissions: ['joyous.chatsync'],
  permissionDefault: true,
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
    // 副名：拓展配置优先，缺省回退到本体 main.json 的 subname。
    // 对端（Joyous）在「自己的配置 > 对端握手帧 > 占位」三级里取用本字段。
    subname: cfg.bridge.subname || neonaicConfManager.getBotSubName() || '',
    version: readExtensionVersion(ctx),
    capabilities: [...NEONAI_CAPABILITIES],
  };

  const httpClient = new JoyousHttpClient({ timeoutMs: cfg.status.timeoutMs, log: logger });

  /** @type {NonNullable<typeof runtime>} */
  const rt = {
    cfg,
    logger,
    self,
    httpClient,
    httpServer: null,
    uds: null,
    statusReader: null,
    bridge: null,
  };
  // 先挂上运行期，query 里才能看到后续建立的 UDS 链路
  runtime = rt;

  // V2 业务层（chat.publish / ai.request / identity.* + 出站 chat.broadcast）。
  // 它在内部**惰性**读取 rt.uds / rt.httpClient，所以放在通道装配之前也安全。
  rt.bridge = joyousMethods.createBridgeLayer(rt);

  rt.statusReader = new JoyousStatusReader({
    query: createStatusQuery(rt),
    serverName: cfg.status.serverName,
    maxPlayerListed: cfg.status.maxPlayerListed,
  });

  const commandHandler = (request) => joyousDispatcher.execute(request, {
    timeoutMs: cfg.dispatch.commandTimeoutMs,
  });

  try {
    if (cfg.httpServer.enabled) {
      rt.httpServer = new JoyousHttpServer({
        handler: commandHandler,
        invokeHandler: (method, payload) => rt.bridge.dispatch(method, payload),
        host: cfg.httpServer.host,
        port: cfg.httpServer.port,
        path: cfg.httpServer.path,
        invokePath: cfg.httpServer.invokePath,
        healthPath: cfg.httpServer.healthPath,
        token: cfg.httpServer.token,
        selfName: self.name,
        selfSubname: self.subname,
        selfVersion: self.version,
        capabilities: self.capabilities,
        log: logger,
      });
      await rt.httpServer.start();
    } else {
      logger.info('[joyous] 未启用 HTTP 命令服务端（httpServer.enabled = false）');
    }

    if (cfg.uds.enabled) {
      rt.uds = new JoyousUdsLink({
        path: cfg.uds.path,
        pipe: cfg.uds.pipe,
        mode: cfg.uds.handshake,
        self,
        methods: {
          [METHODS.COMMAND_EXECUTE]: commandHandler,
          [METHODS.STATUS_QUERY]: (payload) => queryStatusOverUds(rt, payload),
          // V2 业务方法：已带业务闸（总闸 + 配置白名单 + 分项）
          ...rt.bridge.gated,
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

    // 出/入两个方向都靠事件：内核消息事件 → 内播到 MC；UDS 事件帧 → 业务方法
    detachers = [
      subscribeOutboundChat(rt),
      subscribeUdsEvents(rt),
    ].filter(Boolean);
  } catch (e) {
    // 半启动状态比不启动更糟：回滚干净再把错误抛给拓展管理器
    await shutdown(rt, '启用过程中出错');
    runtime = null;
    throw e;
  }

  logger.info(
    `[joyous] 拓展已启用：状态查询传输 ${cfg.status.transport}，`
    + `目标 ${cfg.status.address}，HTTP 服务端 ${cfg.httpServer.enabled ? '开' : '关'}，`
    + `UDS ${cfg.uds.enabled ? '开' : '关'}，内播到 MC ${describeBroadcastTargets(cfg).length ? '开' : '关'}`,
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

// =====================================================================
// V2：外部聊天内播到 MC（chat.broadcast）
// =====================================================================

/**
 * 订阅内核的消息事件，把**外部聊天**经 `chat.broadcast` 内播到 MC。
 *
 * 判定方式刻意做成「按配置的频道白名单匹配执行者链」，而不是硬编码某个平台的标识前缀：
 * `bridge.profiles[*].channels` 里写了哪些标识，就只转发哪些场景——扩展平台无需改代码。
 *
 * @param {NonNullable<typeof runtime>} rt
 * @returns {(() => void)|null} 摘除订阅的函数；未启用时返回 null
 */
function subscribeOutboundChat(rt) {
  const { cfg, logger } = rt;

  if (!cfg.bridge.broadcast.enabled) {
    logger.info('[joyous] 未启用「外部消息内播」（bridge.broadcast.enabled = false）');
    return null;
  }
  const targets = describeBroadcastTargets(cfg);
  if (!targets.length) {
    logger.info('[joyous] 尚未配置 bridge.profiles，外部消息内播要配置 profile/频道后才会生效');
    return null;
  }

  const listener = (event) => {
    void handleInboundChat(rt, targets, event).catch((e) => {
      logger.warn(`[joyous] 内播外部消息失败：${e?.message ?? e}`);
    });
  };
  neonaicEventBus.addEventListener(NeonaicMessageEvent.EVENT_TYPE, listener);
  logger.info(
    `[joyous] 已监听外部聊天：${targets.length} 个 profile 映射到 MC` +
    `（频道 ${targets.reduce((n, t) => n + t.channels.length, 0)} 个）`,
  );
  return () => neonaicEventBus.removeEventListener(NeonaicMessageEvent.EVENT_TYPE, listener);
}

/**
 * 订阅 UDS 上的单向事件帧，转发给业务层。
 *
 * PROTOCOL-V2 §6 允许对端用 `event` 帧承载 `chat.publish`（「发出即忘」写法），
 * 因此这里不能把事件帧当噪声丢弃；未实现的方法名由 {@link joyousMethods} 的
 * 方法表判定并忽略。
 *
 * @param {NonNullable<typeof runtime>} rt
 * @returns {(() => void)|null}
 */
function subscribeUdsEvents(rt) {
  const uds = rt.uds;
  if (!uds) return null;

  const known = new Set(BUSINESS_METHODS);
  const listener = (frame) => {
    const method = typeof frame?.method === 'string' ? frame.method : '';
    if (!known.has(method)) {
      rt.logger.debug?.(`[joyous] 忽略未知事件帧：${method || '(无方法名)'}`);
      return;
    }
    void (async () => {
      try {
        await rt.bridge.dispatch(method, frame.payload ?? {});
        rt.logger.debug?.(`[joyous] 已处理事件帧 ${method}`);
      } catch (e) {
        rt.logger.warn?.(`[joyous] 处理事件帧 ${method} 失败（${e?.code ?? 'unknown'}）：${e?.message ?? e}`);
      }
    })();
  };
  uds.on('event', listener);
  return () => uds.off('event', listener);
}

/**
 * 处理一条内核消息事件，必要时内播到 MC。
 * @param {NonNullable<typeof runtime>} rt
 * @param {Array<{ joyousKey: string, platform: string, channels: string[] }>} targets
 * @param {NeonaicMessageEvent} event
 * @returns {Promise<void>}
 */
async function handleInboundChat(rt, targets, event) {
  const detail = event?.detail;
  if (!detail) return;
  // 内核内部也会用同一事件类型做「可取消的消息门」，那种事件不带任何上下文
  const codes = (Array.isArray(detail.user) ? detail.user : [detail.user])
    .map((c) => (typeof c === 'string' ? c : parseString(c)))
    .filter(Boolean);
  if (!codes.length) return;

  const hit = matchChannel(targets, codes);
  if (!hit) return;

  const message = normalizeBroadcastText(detail.message.toMarkdown());
  if (!message) return;

  // 执行者链里越靠前越近，故第一个不是该频道的标识即说话者
  const senderCode = codes.find((c) => c !== hit.channel) ?? codes[0];

  // 逐用户开关：发言者自己可以关掉「把我的聊天同步到服务器侧」
  if (joyousMethods.isChatSyncDisabled(senderCode)) {
    rt.logger.debug?.(`[joyous] ${senderCode} 已关闭聊天同步，跳过内播`);
    return;
  }

  try {
    await rt.bridge.broadcast(rt.bridge.buildChatBroadcast({
      profile: hit.joyousKey,
      channel: hit.channel,
      chatId: senderCode,
      text: message,
    }));
  } catch (e) {
    if (e?.code === 'not_handshaken') {
      // 没有可用通道是常态（桥接未启用 / 对端不在线），不值得刷警告
      rt.logger.debug?.(`[joyous] 暂时无法内播外部消息：${e.message}`);
      return;
    }
    throw e;
  }
}

/**
 * 在执行者链里找出「属于某个已配置频道」的那一项。
 * @param {Array<{ joyousKey: string, platform: string, channels: string[] }>} targets
 * @param {string[]} codes
 * @returns {{ joyousKey: string, channel: string }|null}
 */
function matchChannel(targets, codes) {
  for (const code of codes) {
    for (const target of targets) {
      if (target.channels.includes(code)) return { joyousKey: target.joyousKey, channel: code };
    }
  }
  return null;
}

/**
 * 归一化要内播的文本。
 * @apiNote MC 的聊天行是单行的，多行文本在被对端渲染时会断得很难看，故折叠换行。
 * @param {*} message
 * @returns {string}
 */
function normalizeBroadcastText(message) {
  return parseString(message ?? '').replace(/\s*\n\s*/g, ' ').trim();
}

/**
 * 汇总「Joyous 侧 profile → Neonaic 平台 Profile / 频道」的映射，供内播与状态展示使用。
 * @param {object} cfg
 * @returns {Array<{ joyousKey: string, platform: string, channels: string[] }>}
 */
function describeBroadcastTargets(cfg) {
  const profiles = cfg?.bridge?.profiles ?? {};
  return Object.entries(profiles).map(([joyousKey, value]) => ({
    joyousKey,
    platform: value.platform || joyousKey,
    channels: Array.isArray(value.channels) ? value.channels : [],
  }));
}

/**
 * 停止运行期的全部通道。
 * @param {NonNullable<typeof runtime>} rt
 * @param {string} reason
 * @returns {Promise<void>}
 */
async function shutdown(rt, reason) {
  const jobs = [];

  for (const detach of detachers) {
    try {
      detach();
    } catch (e) {
      rt.logger.warn(`[joyous] 摘除事件订阅时出错：${e?.message ?? e}`);
    }
  }
  detachers = [];

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

// =====================================================================
// 内部：自助命令的辅助
// =====================================================================

/**
 * 取「调用者自己」的聊天侧稳定标识。
 *
 * @apiNote 两条自助命令（`/joyous:bind`、`/joyous:chatsync`）都只能作用于**调用者自己**：
 *          一律拒绝内部调用（没有聊天身份）与 `$` 开头的合成执行者（桥接/控制台），
 *          这样既不需要额外权限，也不存在越权改他人数据的可能。
 * @param {import('../../../src/command/commandServer.js').NeonaicCommandContext} ctx
 * @returns {{ ok: true, chatId: string } | { ok: false, message: string }}
 */
function requireSelfExecutor(ctx) {
  if (ctx?.internalCall) {
    return { ok: false, message: '该命令只能由聊天侧的用户自己执行（控制台与内部调用不适用）。' };
  }
  const chatId = parseString(ctx?.executor?.[0] ?? '').trim();
  if (!chatId) return { ok: false, message: '无法识别你的聊天账号，请从聊天平台发起该命令。' };
  if (chatId.startsWith('$')) {
    return { ok: false, message: '该命令不接受桥接/内部身份（合成执行者）。' };
  }
  return { ok: true, chatId };
}

/**
 * 推断某聊天账号属于哪个 Joyous profile 键。
 *
 * @apiNote 只配了一个 profile 时无需推断（绝大多数部署）；配了多个时，
 *          用「账号后缀」区分——群标识 `qGRP#<群>@<机器人>` 与用户标识
 *          `qUSR#<用户>@<机器人>` 共享同一段 `@<机器人>`，因此不必硬编码任何平台的标识前缀。
 * @param {object} cfg
 * @param {string} chatId
 * @returns {string|null} null 表示无法唯一确定
 */
function pickProfileFor(cfg, chatId) {
  const profiles = cfg?.bridge?.profiles ?? {};
  const keys = Object.keys(profiles);
  if (keys.length === 1) return keys[0];
  if (!keys.length) return null;

  const at = chatId.indexOf('@');
  const suffix = at >= 0 ? chatId.slice(at) : '';
  if (!suffix) return null;
  const hits = keys.filter((key) => (profiles[key]?.channels ?? [])
    .some((channel) => String(channel).endsWith(suffix)));
  return hits.length === 1 ? hits[0] : null;
}

/**
 * 无法确定 profile 时的可读说明。
 * @param {object} cfg
 * @returns {string}
 */
function profileAmbiguityMessage(cfg) {
  const keys = Object.keys(cfg?.bridge?.profiles ?? {});
  if (!keys.length) {
    return '绑定失败：尚未配置 bridge.profiles（请在拓展配置里登记 profile 与频道后重启拓展）。';
  }
  return `绑定失败：无法确定你的聊天账号属于哪个 profile（候选：${keys.join('、')}）。`
    + '请让对应 profile 的 channels 覆盖你所在的频道（/joyous:bridge 可查看当前映射）。';
}

/**
 * 解除调用者自己的全部绑定。
 * @param {NonNullable<typeof runtime>} rt
 * @param {string} chatId
 * @returns {string}
 */
function clearOwnBinding(rt, chatId) {
  const hits = joyousIdentity.findByChatId(chatId);
  if (!hits.length) return '你当前没有已登记的绑定。';

  joyousIdentity.removeByChatId(chatId);
  for (const hit of hits) {
    rt.bridge.notifyIdentityChanged({
      profile: hit.profile,
      mc: { name: hit.name, uuid: hit.uuid ?? '' },
      chatId: hit.chatId,
      bound: false,
    });
  }
  rt.logger?.info?.(`[joyous] /joyous:bind clear：解除了 ${hits.length} 处绑定`);
  return `已解除你的绑定（${hits.map((h) => h.profile).join('、')}）。`;
}

/**
 * 把 `identity.claim` 的失败翻译成给用户看的话。
 * @param {Error} error
 * @param {string} code 用户输入的代码（仅用于提示格式问题）
 * @returns {string}
 */
function claimFailureMessage(error, code) {
  switch (error?.code) {
    case 'not_bound':
      // 对端刻意不区分「无效 / 已被使用 / 已过期」，此处也不区分（避免探测）
      return '绑定失败：代码无效或已过期。请在游戏内重新执行 /neonaicbindidentity 取得新代码。';
    case 'invalid_argument':
      return `绑定失败：代码格式不正确（收到 ${code}）。用法：/joyous:bind <绑定代码>`;
    case 'not_handshaken':
      return '绑定失败：与 Minecraft 服务器侧的桥接通道未就绪，请稍后再试'
        + '（管理员可用 /joyous:bridge 查看通道状态）。';
    default:
      return `绑定失败：${error?.message ?? String(error)}`;
  }
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
  return '0.4.0';
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
      `· HTTP 服务端：监听 http://${addr.host}:${addr.port}`
      + `（命令端点 ${rt.httpServer.commandPath}`
      + `${rt.httpServer.hasInvokeEndpoint ? `，通用调用端点 ${rt.httpServer.invokePath}` : ''}）`
      + `${cfg.httpServer.token ? '（已启用令牌校验）' : '（未配置令牌）'}`,
    );
  } else {
    lines.push('· HTTP 服务端：未启用');
  }
  if (cfg.httpServer.joyousInvokeUrl) {
    lines.push(`· HTTP 出站目标：${cfg.httpServer.joyousInvokeUrl}`);
  }

  // UDS
  if (rt.uds) {
    const s = rt.uds.status;
    lines.push(
      `· UDS 链路：${s.state}${s.ready ? '' : '（未就绪）'}，端点 ${s.endpoint}（平台 ${s.platform}）`
      + `${s.attempts > 0 ? `，累计失败 ${s.attempts} 次` : ''}`,
    );
    if (s.peer) {
      lines.push(
        `  对端：${s.peer.role}/${s.peer.name} v${s.peer.version}`
        + `（副名 ${s.peer.subname || '无'}，能力 ${s.peer.capabilities.join(', ') || '无'}）`,
      );
    }
    if (s.lastError) lines.push(`  最近错误：${s.lastError}`);
    if (s.nextRetryAt) lines.push(`  下次重连：${neonaicChore.parseCnDatetime(new Date(s.nextRetryAt))}`);
  } else {
    lines.push('· UDS 链路：未启用');
  }

  lines.push(`· 状态查询传输：${cfg.status.transport}（目标 ${cfg.status.address}）`);
  lines.push(
    `· 本端自述：${rt.self.name}${rt.self.subname ? `（${rt.self.subname}）` : ''} v${rt.self.version}`
    + `，申报能力 ${rt.self.capabilities.length} 项`,
  );

  // 授权：命令与业务是两套独立闸门
  const executor = joyousDispatcher.BRIDGE_EXECUTOR;
  const gateOk = neonaicPermissionServer.checkSinglePermission(
    executor,
    joyousDispatcher.BRIDGE_GATE_PERMISSION,
  );
  lines.push(
    `· 执行授权（${executor}）：总闸 ${joyousDispatcher.BRIDGE_GATE_PERMISSION} `
    + `${gateOk ? '✓ 已授予' : '× 未授予（对端将无法执行任何命令）'}`,
  );
  if (!gateOk) {
    lines.push(
      '  如需放行，请执行：'
      + `/neonaic:permission set ${executor} ${joyousDispatcher.BRIDGE_GATE_PERMISSION} true`,
    );
  }

  const allowed = Array.isArray(cfg.bridge.allowedMethods) ? cfg.bridge.allowedMethods : [];
  const businessOk = neonaicPermissionServer.checkSinglePermission(
    executor,
    joyousMethods.BRIDGE_BUSINESS_GATE_PERMISSION,
  );
  lines.push(
    `· 业务授权（${executor}）：总闸 ${joyousMethods.BRIDGE_BUSINESS_GATE_PERMISSION} `
    + `${businessOk ? '✓ 已授予' : '× 未授予（对端将无法聊天 / AI / 绑定）'}`
    + `，配置白名单 ${allowed.length} 项`,
  );
  if (!businessOk) {
    lines.push(
      '  如需放行，请执行：'
      + `/neonaic:permission set ${executor} ${joyousMethods.BRIDGE_BUSINESS_GATE_PERMISSION} true`,
    );
  }
  for (const method of allowed) {
    const key = joyousMethods.businessPermissionKey(method);
    const denied = !neonaicPermissionServer.checkPermission(executor, key, true);
    if (denied) lines.push(`  × ${method} 被 ${key} 显式拒绝`);
  }

  // 群服互联映射
  const targets = describeBroadcastTargets(cfg);
  if (!targets.length) {
    lines.push('· 群服互联：未配置 bridge.profiles（chat.publish 会被拒绝，外部消息也不会内播）');
  } else {
    lines.push(
      `· 群服互联：出站传输 ${cfg.bridge.transport}，`
      + `内播到 MC ${cfg.bridge.broadcast.enabled ? '已启用' : '已停用'}`,
    );
    for (const target of targets) {
      lines.push(`  ${target.joyousKey} → ${target.platform}：${target.channels.join('、') || '（未授权任何频道）'}`);
    }
  }
  lines.push(
    `· 已登记身份绑定：${joyousIdentity.size()} 条`
    + `（管理员直接设置的校验码 ${cfg.bridge.identity.code ? '已设置' : '未设置'}）`,
  );
  lines.push(
    '· 自助命令：/joyous:bind <code> 绑定自己的聊天账号，/joyous:bind clear 解除；'
    + `/joyous:chatsync on|off 切换「是否把自己的聊天同步到服务器侧」`
    + `（权限 ${joyousMethods.CHAT_SYNC_DISABLED_PERMISSION}）`,
  );

  return lines.join('\n');
}
