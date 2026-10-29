/**
 * protocol/methods.js — V2 业务方法层（协议 ↔ 内核业务系统的接缝）
 *
 * 职责边界（与 dispatch.js 对称，各管一侧）：
 *   - {@link ./dispatch.js} 是「通信 ↔ 命令系统」的接缝，只管 `command.execute`；
 *   - 本文件是「通信 ↔ 平台 / AI / 身份」的接缝，管 V2 的四个业务方法。
 * 两者都**只认识内核的业务接口，不认识具体传输** —— http.js 与 uds.js 依旧不知道
 * 「聊天」「AI」「绑定」是什么，它们只会把 `{ method, payload }` 交给本层。
 *
 * ── 实现的方法（均为 Joyous 发起、Neonaic 应答）──
 *   `chat.publish`      把 MC 聊天外发到配置的聊天频道
 *   `ai.request`        基于给定上下文生成一段 AI 回复
 *   `identity.bind`     绑定 MC 身份与聊天身份
 *   `identity.resolve`  按 MC 身份查询绑定
 * 反向的 `chat.broadcast`（Neonaic 发起、Joyous 应答）也在这里出站，因为只有本层同时
 * 知道「业务语义」与「该发给谁」。
 *
 * ── 业务授权模型（PROTOCOL-V2 §7）──
 * 与 `command.execute` 的三层白名单**相互独立**，三层叠加：
 *   1. 配置白名单 `bridge.allowedMethods`（静态，写在 config.json 里）
 *   2. 总闸 `joyous.bridge.business`（动态，默认不授予 ⇒ 开箱即全关）
 *   3. 分项 `joyous.bridge.<method>`（可选，**显式设为 false 才拒绝**，便于逐方法收窄）
 * 授权示例（管理员在 CLI 执行）：
 *   /neonaic:permission set $joyous joyous.bridge.business true
 */

import { neonaicPermissionServer } from '#/command/permissionServer.js';
import { neonaicAI } from '#/message/ai.js';
import { neonaicUserDirectory } from '#/message/userDirectory.js';
import { neonaicPlatformManager } from '#/platform/platformManager.js';
import { parseString } from '#/utils/chore.js';
import {
  NeonaicIllegalArgumentError,
  NeonaicIllegalStateError,
} from '#/utils/NeonaicNewableError.js';

import { joyousIdentity } from '../identity.js';
import { ERROR_CODES, EVENTS, METHODS, TRANSPORTS } from './constants.js';
import { BRIDGE_EXECUTOR, fail, withTimeout } from './dispatch.js';

/** 业务方法总闸权限名：未授予时任何 V2 业务方法都不可调用 */
export const BRIDGE_BUSINESS_GATE_PERMISSION = 'joyous.bridge.business';

/**
 * 「把自己的聊天同步到服务器侧」的**逐用户开关**（内播方向 `to-mc` 的过滤条件）。
 *
 * 语义沿用对端 `Neonaic.yml` 的既有说明：**持有该权限 = 不同步**。
 * 由 `/joyous:chatsync` 自助切换；管理员也可直接
 * `/neonaic:permission set <用户> joyous.chatsync.disabled true`。
 */
export const CHAT_SYNC_DISABLED_PERMISSION = 'joyous.chatsync.disabled';

/**
 * 业务方法的「分项」权限名。
 * @param {string} method 方法名，如 `chat.publish`
 * @returns {string} 如 `joyous.bridge.chat.publish`
 */
export function businessPermissionKey(method) {
  return `joyous.bridge.${method}`;
}

/**
 * 该用户是否已关闭「聊天同步到服务器」。
 * @param {string|string[]|null} users 单个执行者或执行者链
 * @returns {boolean}
 */
export function isChatSyncDisabled(users) {
  return neonaicPermissionServer.checkSinglePermission(users, CHAT_SYNC_DISABLED_PERMISSION);
}

/**
 * `trigger` 取值 → 给模型的场景说明。
 * @apiNote PROTOCOL-V2 §5.3 明确「`visibility` 供 Neonaic 决定是否附带额外说明」，
 *          故这里只补充**事实性**的场景信息，不写任何人设或风格要求（那属于 AI Profile 的提示词）。
 */
const TRIGGER_NOTES = Object.freeze({
  'random': '你没有被人点名，是随机插话；可以简短回应，也可以选择不回应。',
  'at-name': '有玩家点名找你，请正面回应他。',
  'by-cmd': '有玩家用命令向你提问，请正面回答。',
});

/**
 * 滑动窗口限流器（用于 `rate_limited`，防止 MC 聊天风暴灌进聊天软件 / AI）。
 * @apiNote 只保留窗口内的时刻，天然随对话停止而收缩，不需要额外的定时清理。
 */
class SlidingWindowLimiter {
  /** @type {number} */
  #limit;
  /** @type {Map<string, number[]>} */
  #hits = new Map();

  /**
   * @param {number} perMinute 每分钟允许的次数；非正数表示不限
   */
  constructor(perMinute) {
    this.#limit = Number.isFinite(perMinute) ? perMinute : 0;
  }

  /** 是否启用 @returns {boolean} */
  get enabled() { return this.#limit > 0; }

  /**
   * 记一次调用并判定是否放行。
   * @param {string} key 限流维度（当前按方法名）
   * @returns {boolean} false 表示应回 `rate_limited`
   */
  allow(key) {
    if (!this.enabled) return true;
    const now = Date.now();
    const cutoff = now - 60_000;
    const kept = (this.#hits.get(key) ?? []).filter((t) => t > cutoff);
    if (kept.length >= this.#limit) {
      this.#hits.set(key, kept);
      return false;
    }
    kept.push(now);
    this.#hits.set(key, kept);
    return true;
  }
}

/**
 * 装配 V2 业务层。
 *
 * @param {object} rt 拓展运行期（组合根持有）
 * @param {object} rt.cfg 归一化后的拓展配置
 * @param {object} [rt.logger] 日志器
 * @param {object} [rt.uds] UDS 链路（用于出站优先与事件发送）
 * @param {object} [rt.httpClient] HTTP 客户端（用于出站回退）
 * @returns {{
 *   methods: Record<string, (payload: object) => Promise<object>>,
 *   gated: Record<string, (payload: object) => Promise<object>>,
 *   dispatch: (method: string, payload: object) => Promise<object>,
 *   outbound: (method: string, payload: object, timeoutMs?: number) => Promise<object>,
 *   broadcast: (payload: object) => Promise<object>,
 *   buildChatBroadcast: (input: object) => object,
 *   claimIdentity: (input: object) => Promise<object>,
 *   notifyIdentityChanged: (payload: object) => boolean,
 * }}
 */
export function createBridgeLayer(rt) {
  const cfg = rt?.cfg ?? {};
  const limiter = new SlidingWindowLimiter(cfg?.bridge?.rateLimit?.perMinute ?? 0);
  const outbound = createOutbound(rt);

  /** 本端应答的业务方法（不含授权，授权在 gated/dispatch 上） */
  const methods = {
    [METHODS.CHAT_PUBLISH]: (payload) => chatPublish(rt, payload, limiter),
    [METHODS.AI_REQUEST]: (payload) => aiRequest(rt, payload, limiter),
    [METHODS.IDENTITY_BIND]: (payload) => identityBind(rt, payload),
    [METHODS.IDENTITY_RESOLVE]: (payload) => identityResolve(rt, payload),
    [METHODS.IDENTITY_UNBIND]: (payload) => identityUnbind(rt, payload),
  };

  /** 带授权的同一批方法：UDS 直接注册这张表，HTTP 走 dispatch 查这张表 */
  const gated = {};
  for (const [method, handler] of Object.entries(methods)) {
    gated[method] = async (payload) => {
      authorizeBusiness(cfg, method);
      return handler(payload);
    };
  }

  return {
    methods,
    gated,
    /**
     * 按方法名分发（HTTP 通用端点与 `event` 帧都走这里）。
     * @param {string} method
     * @param {object} [payload]
     * @returns {Promise<object>}
     */
    async dispatch(method, payload) {
      const handler = gated[method];
      if (!handler) throw fail(ERROR_CODES.UNKNOWN_METHOD, `未实现的方法：${String(method)}`);
      return handler(payload ?? {});
    },
    outbound,
    /** 把一条外部聊天内播到 MC（`chat.broadcast`） */
    broadcast(payload) { return outbound(METHODS.CHAT_BROADCAST, payload); },
    /** 组装一条 `chat.broadcast` 载荷（含绑定解析后的 `user`，见 PROTOCOL-V2 §5.3.1） */
    buildChatBroadcast(input) { return buildChatBroadcast(rt, input); },
    /** 用绑定代码向对端换取 MC 身份（`identity.claim`，PROTOCOL-V2 §5.7.2） */
    claimIdentity(input) { return claimIdentity(rt, input); },
    /** 告知对端绑定关系已变更（单向事件；不可用时静默跳过） */
    notifyIdentityChanged(payload) { return notifyEvent(rt, EVENTS.IDENTITY_CHANGED, payload); },
  };
}

// =====================================================================
// 业务授权
// =====================================================================

/**
 * 校验业务方法是否放行。不通过一律抛带 `permission_denied` 的异常。
 * @param {object} cfg
 * @param {string} method
 * @throws {NeonaicCommandError} `permission_denied`
 */
function authorizeBusiness(cfg, method) {
  const allowed = cfg?.bridge?.allowedMethods;
  if (Array.isArray(allowed) && !allowed.includes(method)) {
    throw fail(ERROR_CODES.PERMISSION_DENIED, `方法 ${method} 不在 bridge.allowedMethods 内`);
  }
  if (!neonaicPermissionServer.checkSinglePermission(BRIDGE_EXECUTOR, BRIDGE_BUSINESS_GATE_PERMISSION)) {
    throw fail(
      ERROR_CODES.PERMISSION_DENIED,
      `身份 ${BRIDGE_EXECUTOR} 未获授权：缺少 ${BRIDGE_BUSINESS_GATE_PERMISSION}`,
    );
  }
  // 分项闸是**可选的收窄**：没设置就放行，显式 false（或 `!` 语义）才拒绝。
  if (!neonaicPermissionServer.checkPermission(BRIDGE_EXECUTOR, businessPermissionKey(method), true)) {
    throw fail(
      ERROR_CODES.PERMISSION_DENIED,
      `方法 ${method} 被显式拒绝（${businessPermissionKey(method)}）`,
    );
  }
}

// =====================================================================
// chat.publish：MC 聊天 → 聊天软件
// =====================================================================

/**
 * @param {object} rt
 * @param {object} payload `{ profile, channel, sender, message, ts }`
 * @param {SlidingWindowLimiter} limiter
 * @returns {Promise<object>}
 */
async function chatPublish(rt, payload, limiter) {
  const { profile, channel, sender, message } = payload ?? {};
  if (typeof profile !== 'string' || !profile.trim()
    || typeof channel !== 'string' || !channel.trim()
    || !sender || typeof sender !== 'object'
    || typeof message !== 'string') {
    throw fail(ERROR_CODES.INVALID_ARGUMENT, 'chat.publish 缺少 profile / channel / sender / message');
  }

  const target = findProfileTarget(rt.cfg, profile);
  if (!target.channels.includes(channel)) {
    throw fail(
      ERROR_CODES.PERMISSION_DENIED,
      `profile “${profile}” 未授权频道 ${channel}（bridge.profiles 的 channels 白名单）`,
    );
  }

  if (!limiter.allow(METHODS.CHAT_PUBLISH)) {
    throw fail(ERROR_CODES.RATE_LIMITED, `chat.publish 触发频率限制`);
  }

  const text = normalizeChatText(message);
  if (!text) throw fail(ERROR_CODES.INVALID_ARGUMENT, 'chat.publish 的 message 为空白');

  // 玩家名快照保鲜（PROTOCOL-V2 §5.7.4）：sender 已带 { name, uuid }，
  // 于是「改名后聊天软件侧仍显示旧名」这件事不需要任何新增协议方法——
  // 名称随聊天流自然更新。未绑定的 uuid 不会被匹配到，天然忽略。
  refreshSenderName(sender);

  const platform = resolvePlatform(target.platform);
  await platform.sendMsg(channel, text);

  const who = [parseString(sender?.name ?? '').trim(), parseString(sender?.uuid ?? '').trim()]
    .filter(Boolean).join(' / ');
  rt.logger?.info?.(`[joyous] chat.publish：${who || '未知玩家'} → ${target.platform}/${channel}：${text}`);

  return { delivered: true, channel, ts: Date.now() };
}

/**
 * 按 `sender.uuid` 刷新绑定记录里的玩家名快照。
 * @apiNote 这里刻意**不让任何异常逸出**：名称保鲜是「顺手做」的副作用，
 *          不该因为它失败而让一条正常聊天发不出去。
 * @param {{ name?: string, uuid?: string }} sender
 */
function refreshSenderName(sender) {
  try {
    const uuid = parseString(sender?.uuid ?? '').trim();
    const name = parseString(sender?.name ?? '').trim();
    if (!uuid || !name) return;
    joyousIdentity.refreshNameByUuid(uuid, name);
  } catch {
    // 忽略：快照过期只影响显示，不影响消息投递
  }
}

/**
 * 找 Joyous 侧 profile 键对应的投递目标。
 * @param {object} cfg
 * @param {string} profile
 * @returns {{ platform: string, channels: string[] }}
 * @throws {NeonaicCommandError} `permission_denied`
 */
function findProfileTarget(cfg, profile) {
  const section = cfg?.bridge?.profiles?.[profile];
  if (!section || typeof section !== 'object') {
    throw fail(
      ERROR_CODES.PERMISSION_DENIED,
      `profile “${profile}” 未在 bridge.profiles 中登记` +
      '（键需与 Joyous 侧 Neonaic.yml 的 group-chat-sync.profile 一致）',
    );
  }
  return {
    // 允许 Joyous 侧的 profile 键与 Neonaic 的平台 Profile 名不同，由 platform 字段显式对应
    platform: section.platform || profile,
    channels: Array.isArray(section.channels) ? section.channels.map(String) : [],
  };
}

/**
 * 取平台实例。
 * @param {string} name Neonaic 的平台 Profile 名
 * @returns {import('#/platform/platformInterface.js').NeonaiPlatform}
 * @throws {NeonaicCommandError} `internal_error`
 */
function resolvePlatform(name) {
  const pm = neonaicPlatformManager.getPlatformManager();
  const platform = pm?.getPlatform(name);
  if (!platform) {
    throw fail(ERROR_CODES.INTERNAL_ERROR, `平台 Profile “${name}” 不存在或未注册`);
  }
  return platform;
}

/**
 * 归一化要外发的聊天文本。
 * @apiNote 聊天软件的一条消息在视觉上没有多行，MC 聊天本身也逐行产生，
 *          因此把换行折叠为空格，避免在接收端出现半截消息。
 * @param {string} message
 * @returns {string}
 */
function normalizeChatText(message) {
  return parseString(message).replace(/\s*\n\s*/g, ' ').trim();
}

// =====================================================================
// ai.request：Joyous → Neonaic 的 AI 生成
// =====================================================================

/**
 * @param {object} rt
 * @param {object} payload `{ profile?, trigger, actor, prompt, context?, visibility?, maxOutputChars? }`
 * @param {SlidingWindowLimiter} limiter
 * @returns {Promise<object>}
 */
async function aiRequest(rt, payload, limiter) {
  const { profile, trigger, actor, prompt, context, visibility, maxOutputChars } = payload ?? {};
  if (typeof trigger !== 'string' || !trigger.trim()
    || !actor || typeof actor !== 'object'
    || typeof prompt !== 'string' || !prompt.trim()) {
    throw fail(ERROR_CODES.INVALID_ARGUMENT, 'ai.request 缺少 trigger / actor / prompt');
  }

  if (!limiter.allow(METHODS.AI_REQUEST)) {
    throw fail(ERROR_CODES.RATE_LIMITED, 'ai.request 触发频率限制');
  }

  const aiCfg = rt.cfg?.bridge?.ai ?? {};
  const AIlist = (typeof profile === 'string' && profile.trim()) ? [profile.trim()] : aiCfg.AIlist;

  let text;
  try {
    text = await withTimeout(
      neonaicAI.askAI(composeAiRequest({ prompt, context, trigger, visibility }), {
        AIlist,
        // 调用方是外部身份：封禁检查按 $joyous 判定（未显式封禁即允许）
        caller: [BRIDGE_EXECUTOR],
        // MC 玩家的可读名是免费的（由 Joyous 提供），直接交给内核的说话者机制
        speaker: speakerOf(actor),
        preprocessWilling: false,
      }),
      Number(aiCfg.timeoutMs ?? 0),
      'ai.request',
    );
  } catch (e) {
    throw classifyAiError(e);
  }

  const full = text == null ? '' : String(text);
  const limit = Number(maxOutputChars) > 0 ? Math.floor(Number(maxOutputChars)) : full.length;
  return {
    output: full.slice(0, limit),
    profile: (typeof profile === 'string' && profile.trim()) ? profile.trim() : null,
    truncated: full.length > limit,
  };
}

/**
 * 组装交给模型的用户消息：历史上下文（若有）+ 本轮提示 + 场景说明。
 * @param {{ prompt: string, context?: object[], trigger: string, visibility?: string }} input
 * @returns {string}
 */
function composeAiRequest({ prompt, context, trigger, visibility }) {
  const lines = [];

  const history = Array.isArray(context) ? context : [];
  if (history.length) {
    lines.push('【近期的服务器聊天记录（按时间升序）】');
    for (const item of history) {
      const message = parseString(item?.message ?? '').trim();
      if (!message) continue;
      const speaker = parseString(item?.speaker ?? '').trim() || '某人';
      lines.push(`${speaker}: ${message}`);
    }
    lines.push('【以上是历史记录，以下是需要你回应的内容】');
  }

  lines.push(parseString(prompt).trim());

  const notes = [];
  if (TRIGGER_NOTES[trigger]) notes.push(TRIGGER_NOTES[trigger]);
  notes.push(visibility === 'private'
    ? '这条回复只有提问者本人能看到。'
    : '这条回复会广播给服务器内的所有人。');
  lines.push(`【补充说明】${notes.join('')}`);

  return lines.join('\n');
}

/**
 * 把 MC 玩家信息交给内核的说话者机制。
 * @param {object} actor
 * @returns {{ name: string, note?: string }|null} null 表示不投递身份
 */
function speakerOf(actor) {
  const name = parseString(actor?.name ?? '').trim();
  if (!name) return null;
  const note = parseString(actor?.subname ?? '').trim();
  return note ? { name, note } : { name };
}

/**
 * 把 AI 调用链的异常映射为协议错误码。
 * @param {Error} error
 * @returns {Error} 带 `code` 的异常
 */
function classifyAiError(error) {
  if (error?.code && typeof error.code === 'string') return error; // withTimeout / 协议错误
  if (error instanceof NeonaicIllegalArgumentError) {
    // 常见于「指定的 AI Profile 不存在 / 全被 available:false 禁用」
    return fail(ERROR_CODES.INVALID_ARGUMENT, `ai.request 无法生成：${error.message}`, error);
  }
  if (error instanceof NeonaicIllegalStateError) {
    // 常见于 $joyous 被封禁
    return fail(ERROR_CODES.PERMISSION_DENIED, `ai.request 被拒绝：${error.message}`, error);
  }
  return fail(ERROR_CODES.INTERNAL_ERROR, `ai.request 失败：${error?.message ?? String(error)}`, error);
}

// =====================================================================
// identity.bind / identity.resolve
// =====================================================================

/**
 * @param {object} rt
 * @param {object} payload `{ profile, mc, chatId, code? }`
 * @returns {Promise<object>}
 */
async function identityBind(rt, payload) {
  const { profile, mc, chatId, code } = payload ?? {};
  if (typeof profile !== 'string' || !profile.trim()
    || !mc || typeof mc !== 'object'
    || typeof chatId !== 'string' || !chatId.trim()) {
    throw fail(ERROR_CODES.INVALID_ARGUMENT, 'identity.bind 缺少 profile / mc / chatId');
  }

  // profile 必须在 bridge.profiles 内：否则等于允许对端给任意平台写绑定
  findProfileTarget(rt.cfg, profile);

  const expected = parseString(rt.cfg?.bridge?.identity?.code ?? '').trim();
  if (expected && parseString(code ?? '').trim() !== expected) {
    throw fail(ERROR_CODES.NOT_BOUND, '校验码不匹配，绑定未完成');
  }

  const binding = joyousIdentity.bind(profile, mc, chatId);
  rt.logger?.info?.(
    `[joyous] identity.bind：${parseString(mc?.name ?? mc?.uuid ?? '')} ↔ ${chatId}（profile ${profile}）`,
  );

  // 单向事件：告知对端绑定已建立。对端忽略未知事件也无妨（PROTOCOL-V2 §6）。
  notifyEvent(rt, EVENTS.IDENTITY_CHANGED, {
    profile,
    mc: { name: parseString(mc?.name ?? ''), uuid: parseString(mc?.uuid ?? '') },
    chatId: binding.chatId,
    bound: true,
  });

  const uuid = parseString(mc?.uuid ?? '').trim();
  return { bound: true, profile, mc: uuid ? { uuid } : { name: parseString(mc?.name ?? '') }, chatId: binding.chatId };
}

/**
 * @param {object} rt
 * @param {object} payload `{ profile, mc }`
 * @returns {Promise<object>}
 */
async function identityResolve(rt, payload) {
  const { profile, mc } = payload ?? {};
  if (typeof profile !== 'string' || !profile.trim() || !mc || typeof mc !== 'object') {
    throw fail(ERROR_CODES.INVALID_ARGUMENT, 'identity.resolve 缺少 profile / mc');
  }

  const binding = joyousIdentity.resolve(profile, mc);
  // 未绑定是**正常业务结果**，不是错误（PROTOCOL-V2 §5.5）
  if (!binding) return { bound: false };

  // 可读名从内核名录取；取不到就不虚构，也不把原始代号当名字（见 userDirectory 的设计说明）
  const entry = neonaicUserDirectory.get(binding.chatId);
  const user = entry ? { name: entry.name, subname: entry.note ?? '' } : null;

  return user
    ? { bound: true, chatId: binding.chatId, user }
    : { bound: true, chatId: binding.chatId };
}

/**
 * `identity.unbind`：解除某个 MC 身份的全部绑定（PROTOCOL-V2 §5.7.3）。
 *
 * @param {object} rt
 * @param {object} payload `{ mc, profile? }`；`profile` 缺省表示**全部 profile**
 * @returns {Promise<object>} `{ bound: false, removed: [chatId…] }`
 * @apiNote `removed` 为空数组**不是错误**——该 MC 身份本就未绑定。
 */
async function identityUnbind(rt, payload) {
  const { mc, profile } = payload ?? {};
  if (!mc || typeof mc !== 'object') {
    throw fail(ERROR_CODES.INVALID_ARGUMENT, 'identity.unbind 缺少 mc');
  }
  if (profile !== undefined && profile !== null && typeof profile !== 'string') {
    throw fail(ERROR_CODES.INVALID_ARGUMENT, 'identity.unbind 的 profile 必须是字符串');
  }

  const removed = joyousIdentity.unbindByMc(mc, typeof profile === 'string' ? profile : undefined);
  const mcEcho = {
    name: parseString(mc?.name ?? ''),
    uuid: parseString(mc?.uuid ?? ''),
  };

  if (removed.length) {
    rt.logger?.info?.(
      `[joyous] identity.unbind：${mcEcho.uuid || mcEcho.name} 解除了 ${removed.length} 条绑定`,
    );
    // 每个被解除的聊天标识各发一条事件——这样事件载荷与 §6 的形状保持一致
    for (const chatId of removed) {
      notifyEvent(rt, EVENTS.IDENTITY_CHANGED, { profile: profile ?? null, mc: mcEcho, chatId, bound: false });
    }
  }

  return { bound: false, removed };
}

/**
 * 组装一条 `chat.broadcast` 载荷（PROTOCOL-V2 §5.3.1）。
 *
 * ── 为什么 `user` 要在这里拼 ──
 * MC 侧希望「已绑定的来源显示 MC 玩家名而不是聊天昵称」，而「聊天标识 ↔ MC UUID」的关联
 * **只有本端持有**，所以必须在发出前解析好：
 *   - `uuid`  ：已绑定 → MC UUID；未绑定 → `null`（MC 侧据此判定是否已绑定）
 *   - `name`  ：已绑定 → MC 玩家名快照（对端若该玩家在线会再用实时名覆盖）；未绑定 → 聊天昵称
 *   - `nickname`：聊天侧**原始昵称**，供 MC 侧 `[nickname]` 占位符
 *   - `id`    ：聊天标识，供日志与回溯
 *
 * @param {object} rt
 * @param {object} input `{ profile, channel, chatId, text, ts? }`
 * @returns {object} 可直接交给 `broadcast()` 的载荷
 */
function buildChatBroadcast(rt, input) {
  const profile = parseString(input?.profile ?? '').trim();
  const channel = parseString(input?.channel ?? '').trim();
  const chatId = parseString(input?.chatId ?? '').trim();
  const message = parseString(input?.text ?? '').trim();

  const binding = joyousIdentity.resolveByChatId(profile, chatId);
  // 聊天昵称：取自内核名录（平台自动登记或人工 whois），取不到就留空——
  // 绝不把原始代号当名字展示。
  const chatName = readableNameOf(chatId);

  return {
    profile,
    channel,
    user: {
      uuid: binding?.uuid ?? null,
      name: binding ? (binding.name || chatName) : chatName,
      nickname: chatName,
      subname: '',
      id: chatId,
    },
    message,
    visibility: 'public',
    ts: Number.isFinite(Number(input?.ts)) ? Number(input.ts) : Date.now(),
  };
}

/**
 * 用绑定代码向对端换取 MC 身份（PROTOCOL-V2 §5.7.2）。
 * @param {object} rt
 * @param {{ code: string, chatId: string, user?: object, profile?: string }} input
 * @returns {Promise<{ bound: true, mc: { name: string, uuid: string }, chatId?: string, profile?: string }>}
 * @throws {NeonaicCommandError} `invalid_argument`（缺 code）/ `not_bound`（代码无效、已用或过期）
 * @apiNote 对端刻意**不区分**「无效 / 已用 / 过期」，一律回 `not_bound`（避免探测）；
 *          调用方也应统一按「代码无效或已过期」提示。
 */
function claimIdentity(rt, input) {
  const code = parseString(input?.code ?? '').trim();
  const chatId = parseString(input?.chatId ?? '').trim();
  if (!code) throw fail(ERROR_CODES.INVALID_ARGUMENT, 'identity.claim 缺少 code');
  if (!chatId) throw fail(ERROR_CODES.INVALID_ARGUMENT, 'identity.claim 缺少 chatId');

  const profile = parseString(input?.profile ?? '').trim();
  const payload = { code, chatId };
  if (input?.user && typeof input.user === 'object') payload.user = input.user;
  if (profile) payload.profile = profile;

  return rt.bridge.outbound(METHODS.IDENTITY_CLAIM, payload);
}

/**
 * 取一个内部代号的可读名（取不到则空串）。
 * @param {string} code
 * @returns {string}
 */
function readableNameOf(code) {
  try {
    return neonaicUserDirectory.get(code)?.name ?? '';
  } catch {
    return '';
  }
}

// =====================================================================
// 出站调用（Neonaic → Joyous）
// =====================================================================

/**
 * 构造出站调用函数：按 `bridge.transport` 选通道。
 * @param {object} rt
 * @returns {(method: string, payload: object, timeoutMs?: number) => Promise<object>}
 */
function createOutbound(rt) {
  return async function outbound(method, payload, timeoutMs) {
    const cfg = rt?.cfg ?? {};
    const mode = TRANSPORTS.includes(cfg?.bridge?.transport) ? cfg.bridge.transport : 'auto';

    if (mode !== 'http' && rt?.uds?.ready) {
      return rt.uds.request(method, payload, timeoutMs ?? cfg.uds?.requestTimeoutMs);
    }
    if (mode !== 'uds') {
      const url = cfg?.httpServer?.joyousInvokeUrl;
      if (typeof url === 'string' && url.trim()) {
        return rt.httpClient.invoke(method, payload, url, cfg.httpServer.token, timeoutMs);
      }
    }
    throw fail(
      ERROR_CODES.NOT_HANDSHAKEN,
      `没有可用的通道可以把 ${method} 发给 Joyous`
      + `（bridge.transport=${mode}，UDS ${rt?.uds?.ready ? '已就绪' : '未就绪'}`
      + `，joyousInvokeUrl ${cfg?.httpServer?.joyousInvokeUrl ? '已配置' : '未配置'}）`,
    );
  };
}

/**
 * 发送一条单向事件。**只在 UDS 上可用**：HTTP 侧的信封是请求/应答，没有事件通道。
 * @param {object} rt
 * @param {string} name
 * @param {object} payload
 * @returns {boolean} 是否已送出
 */
function notifyEvent(rt, name, payload) {
  try {
    if (typeof rt?.uds?.notify !== 'function' || !rt.uds.ready) return false;
    return rt.uds.notify(name, payload);
  } catch (e) {
    rt.logger?.debug?.(`[joyous] 发送事件 ${name} 失败：${e?.message ?? e}`);
    return false;
  }
}

export const joyousMethods = Object.freeze({
  BRIDGE_BUSINESS_GATE_PERMISSION,
  CHAT_SYNC_DISABLED_PERMISSION,
  businessPermissionKey,
  isChatSyncDisabled,
  readableNameOf,
  createBridgeLayer,
});
