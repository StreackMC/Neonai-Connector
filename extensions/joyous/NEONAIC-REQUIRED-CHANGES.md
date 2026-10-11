# Neonaic 侧改动概要（支持 Joyous↔Neonaic 协议 V2）

> 目标仓库：`Neonai-Connector`（相对路径 `extensions/joyous/`）
> 依据：`../PROTOCOL-V2.md`
> 本文档供 Neonaic 维护者实施；**Joyous 侧不修改 Neonaic 代码**。
> 既有 V1 功能（`command.execute` / `status.query`）保持兼容，本改动为**增量**。

改动分为 6 处，按文件列出。带 ✅ 的是**必须**（否则协议不互通），带 ⚪ 的是**建议**。

---

## 1. `src/protocol/constants.js` ✅

### 1.1 版本

```diff
- export const PROTOCOL_VERSION = 1;
+ export const PROTOCOL_VERSION = 2;
```

> `session.js` 的 `checkPeerIdentity()` 与 `selfFrame()` 都引用该常量，
> 改这一处即可让双方在握手阶段强制 v2（V1 §5.3 的既有逻辑不变）。

### 1.2 能力常量追加

```js
export const CAPABILITIES = Object.freeze({
  COMMAND_EXECUTE: 'command.execute',   // 已有
  STATUS_QUERY: 'status.query',         // 已有
  // 新增：
  CHAT_PUBLISH: 'chat.publish',
  CHAT_BROADCAST: 'chat.broadcast',
  AI_REQUEST: 'ai.request',
  IDENTITY_BIND: 'identity.bind',
  IDENTITY_RESOLVE: 'identity.resolve',
});
```

### 1.3 方法名追加

```js
export const METHODS = Object.freeze({
  COMMAND_EXECUTE: 'command.execute',   // 已有
  STATUS_QUERY: 'status.query',         // 已有
  PING: 'ping',                         // 已有
  // 新增：
  CHAT_PUBLISH: 'chat.publish',
  CHAT_BROADCAST: 'chat.broadcast',
  AI_REQUEST: 'ai.request',
  IDENTITY_BIND: 'identity.bind',
  IDENTITY_RESOLVE: 'identity.resolve',
});
```

### 1.4 错误码追加

```js
export const ERROR_CODES = Object.freeze({
  /* …已有… */
  NOT_BOUND: 'not_bound',
  RATE_LIMITED: 'rate_limited',
});
```

---

## 2. `src/protocol/session.js` ✅

### 2.1 握手帧新增 `subname`

`selfFrame()` 增加 `subname`（取自 `self.subname`，缺省空串）：

```diff
 function selfFrame(type, self, sessionId) {
   return {
     v: PROTOCOL_VERSION,
     protocol: PROTOCOL_NAME,
     type, id: null, ts: Date.now(),
     role: CHANNEL_ROLES.NEONAI,
     name: self.name,
+    subname: self.subname ?? '',
     version: self.version,
     capabilities: [...self.capabilities],
     session: sessionId,
   };
 }
```

`self` 的归一化处（构造函数内）也补一行：

```diff
 this.#self = {
   name: String(self.name ?? 'neonai'),
+  subname: String(self.subname ?? ''),
   version: String(self.version ?? '0.0.0'),
   capabilities: Array.isArray(self.capabilities) ? [...self.capabilities] : [],
 };
```

### 2.2 解析对端 `subname`

`#onHandshakeFrame()` 里构造 `#peer` 时补字段：

```diff
 this.#peer = {
   role: String(frame.role ?? CHANNEL_ROLES.JOYOUS),
   name: String(frame.name ?? 'unknown'),
+  subname: String(frame.subname ?? ''),
   version: String(frame.version ?? 'unknown'),
   /* …其余不变… */
 };
```

> 其余（分帧、心跳、请求/响应按 id 关联、`unknown_method` 应答）**无需改动**——
> 新方法通过 `registerMethod()` 注册进 `#methods` 即自动可被调用。

---

## 3. `src/config.js` / `extensions/joyous/config.json`

### 3.1 新增通用调用端点配置 ✅

`httpServer` 段追加两个键：

```json5
"httpServer": {
  /* …已有… */
  // 通用调用端点（承载 command.execute 以外的 V2 方法）
  "invokePath": "/neonai/invoke",
  // Joyous 侧 HTTP 服务端上的通用端点（用于 Neonaic 主动调用 Joyous，如 chat.broadcast）
  "joyousInvokeUrl": "http://127.0.0.1:8080/neonai/invoke",
}
```

`config.js` 的 `DEFAULTS.httpServer` 同步补缺省值，并在 `load()` 里读取：

```js
invokePath: pickPath(conf.getString('httpServer.invokePath', '/neonai/invoke'), 'httpServer.invokePath', issues),
joyousInvokeUrl: pickText(conf.getString('httpServer.joyousInvokeUrl', ''), 'httpServer.joyousInvokeUrl', issues),
```

### 3.2 业务数据配置 ⚪

新增 `bridge` 段，描述「profile → 频道集合」与授权策略：

```json5
"bridge": {
  // profileName → 该 profile 下的频道标识列表（Joyous 侧 group-chat-sync.profile 用同名键对应）
  "profiles": {
    "main": {
      "channels": ["qGRP#12345678901234567890@aaabbbcccdddeeefff"],
    },
  },
  // 允许 $joyous 调用哪些方法（与权限系统叠加，见 §6）
  "allowedMethods": ["chat.publish", "ai.request", "identity.bind", "identity.resolve"],
}
```

> 该段不是协议要求，而是 Neonaic 侧业务所需；`profiles` 的键必须与 Joyous
> `Neonaic.yml` 的 `group-chat-sync.profile` 键一致。

---

## 4. 新增业务处理器 `src/protocol/methods.js`（新文件）✅

集中实现 V2 中 **Neonaic 应答**的四个方法，导出一张 `{ methodName: handler }` 表。

```js
// 伪代码骨架
import { neonaicAI } from '../../../src/message/ai.js';       // 已有 AI 能力
import { neonaicChat } from '...';                            // 平台侧发消息能力（按实际模块调整）
import { ERROR_CODES } from './constants.js';
import { fail } from './dispatch.js';                         // 复用 dispatch 的错误工厂

export const bridgeMethods = {
  async 'chat.publish'(payload) {
    const { profile, channel, sender, message, ts } = payload ?? {};
    if (!profile || !channel || !sender || typeof message !== 'string') {
      throw fail(ERROR_CODES.INVALID_ARGUMENT, 'chat.publish 缺少 profile/channel/sender/message');
    }
    // 1) 校验 profile/channel 是否在 bridge.profiles 中
    // 2) 以 sender 身份把 message 发到该频道
    // 3) 返回回执
    return { delivered: true, channel, ts: Date.now() };
  },

  async 'ai.request'(payload) {
    const { profile, trigger, actor, prompt, context, maxOutputChars } = payload ?? {};
    if (!trigger || !actor || typeof prompt !== 'string') {
      throw fail(ERROR_CODES.INVALID_ARGUMENT, 'ai.request 缺少 trigger/actor/prompt');
    }
    const output = await neonaicAI.generate({ profile, trigger, actor, prompt, context: context ?? [] });
    const text = String(output ?? '');
    const limit = Number(maxOutputChars) > 0 ? Number(maxOutputChars) : text.length;
    return { output: text.slice(0, limit), profile: profile ?? null, truncated: text.length > limit };
  },

  async 'identity.bind'(payload) {
    const { profile, mc, chatId, code } = payload ?? {};
    if (!profile || !mc || !chatId) {
      throw fail(ERROR_CODES.INVALID_ARGUMENT, 'identity.bind 缺少 profile/mc/chatId');
    }
    // 校验 code（若需要）→ 失败抛 NOT_BOUND
    // 写入绑定存储
    return { bound: true, profile, mc: { uuid: mc.uuid }, chatId };
  },

  async 'identity.resolve'(payload) {
    const { profile, mc } = payload ?? {};
    if (!profile || !mc) {
      throw fail(ERROR_CODES.INVALID_ARGUMENT, 'identity.resolve 缺少 profile/mc');
    }
    const hit = /* 查绑定存储 */;
    return hit ? { bound: true, chatId: hit.chatId, user: hit.user } : { bound: false };
  },
};
```

> `fail()` 目前是 `dispatch.js` 的私有函数；请将其导出，或在 `methods.js` 内复制一个等价工厂
> （`invalid_argument` 之外的 `rate_limited` / `not_bound` 按 §1.4 使用）。

---

## 5. `src/entry.js` ✅

### 5.1 自述信息补 `subname` 与能力

```diff
 const self = {
   name: neonaicConfManager.getBotName(),
+  subname: cfg.bridge?.subname ?? '',
   version: readExtensionVersion(ctx),
-  capabilities: [CAPABILITIES.COMMAND_EXECUTE, CAPABILITIES.STATUS_QUERY],
+  capabilities: [
+    CAPABILITIES.COMMAND_EXECUTE,
+    CAPABILITIES.STATUS_QUERY,
+    CAPABILITIES.CHAT_PUBLISH,
+    CAPABILITIES.AI_REQUEST,
+    CAPABILITIES.IDENTITY_BIND,
+    CAPABILITIES.IDENTITY_RESOLVE,
+  ],
 };
```

### 5.2 注册业务方法

* **UDS**：把 `bridgeMethods` 并入 `uds.methods`：

  ```diff
  methods: {
    [METHODS.COMMAND_EXECUTE]: commandHandler,
    [METHODS.STATUS_QUERY]: (payload) => queryStatusOverUds(rt, payload),
+   ...bridgeMethods,
  },
  ```

* **HTTP**：`JoyousHttpServer` 新增 `invokeHandler`，把 `/neonai/invoke` 的
  `{ id, method, payload }` 分发到 `bridgeMethods[method]`：

  ```diff
  rt.httpServer = new JoyousHttpServer({
    handler: commandHandler,
+   invokeHandler: (method, payload) => dispatchInvoke(bridgeMethods, method, payload),
    /* … */
  });
  ```

### 5.3 Neonaic → Joyous 主动调用（`chat.broadcast`）

在「收到外部群消息」的事件回调里，向 Joyous 发 `chat.broadcast`：

```js
// UDS：若链路就绪
if (rt.uds?.ready) {
  await rt.uds.request(METHODS.CHAT_BROADCAST, {
    profile, channel, user, message, visibility: 'public', ts: Date.now(),
  });
}
// HTTP：POST 到 Joyous 的通用端点
else if (cfg.httpServer.joyousInvokeUrl) {
  await httpInvoke(cfg.httpServer.joyousInvokeUrl, cfg.httpServer.token,
    METHODS.CHAT_BROADCAST, { profile, channel, user, message, visibility: 'public', ts: Date.now() });
}
```

---

## 6. `src/protocol/http.js` ✅

### 6.1 `JoyousHttpServer` 增加通用端点

* 构造函数新增 `invokePath`（缺省 `/neonai/invoke`）与 `invokeHandler`；
* `#route()` 里在 `commandPath` 分支之后、`404` 之前插入：

  ```js
  if (path === this.#config.invokePath) {
    if (req.method !== 'POST') { res.setHeader('Allow','POST'); return sendJson(res,405,{ok:false,code:ERROR_CODES.INVALID_ARGUMENT}); }
    if (!this.#authorized(req)) return sendJson(res,401,{ok:false,code:'unauthorized'});
    const raw = await readBody(req, this.#config.maxBodyBytes);
    const env = JSON.parse(raw);
    if (!env || typeof env.method !== 'string') return sendJson(res,400,{ok:false,code:ERROR_CODES.BAD_FRAME,message:'缺少 method'});
    try {
      const out = await this.#config.invokeHandler(env.method, env.payload ?? {});
      return sendJson(res,200,{ ok:true, id: env.id ?? null, payload: out ?? {} });
    } catch (e) {
      const code = typeof e?.code === 'string' ? e.code : ERROR_CODES.INTERNAL_ERROR;
      return sendJson(res, httpStatusFor(code), { ok:false, id: env.id ?? null, code, message: e?.message ?? String(e) });
    }
  }
  ```

### 6.2 `JoyousHttpClient` 增加通用调用

```js
async invoke(method, payload = {}, url, token = '') {
  const res = await this.#fetchImpl2(url, this.#timeoutMs, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Neonai-Token': token } : {}),
    },
    body: JSON.stringify({ id: `na-${Date.now()}`, method, payload }),
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok || body.ok === false) {
    const err = new NeonaicProtocolError(body.message ?? `invoke ${method} 失败`);
    err.code = body.code ?? 'internal_error';
    throw err;
  }
  return body.payload ?? {};
}
```

> `#fetchImpl` 当前签名为 `(target, timeout)`，需扩展为可传 `init`（或新增一个
> `#fetchImplRaw`）。内核 `neonaicNetwork.fetch` 若已支持 options，直接用即可。

---

## 7. 权限模型扩展 ✅

V1 §11 的三层模型只覆盖 `command.execute`。V2 新方法同属「不受信任的外部身份 `$joyous`」
发起，应施加**同等的显式授权**。建议在 `dispatch.js`（或新 `methods.js`）增加一道总闸：

| 层 | 权限名 | 语义 |
|---|---|---|
| 总闸 | `joyous.bridge.execute` | 已有，`command.execute` 用 |
| 新总闸 | `joyous.bridge.business` | `chat.publish` / `ai.request` / `identity.*` 必须显式授予 |
| 分项 | `joyous.bridge.<method>` | 可选，逐方法细分（如 `joyous.bridge.ai`） |

授权示例（管理员）：

```
/neonaic:permission set $joyous joyous.bridge.business true
/neonaic:permission set $joyous joyous.bridge.ai true
```

> 亦可沿用 `joyous.bridge.execute` 一个总闸，实现最简；本概要建议单列 `business` 闸，
> 以便「允许执行命令」与「允许聊天/AI/绑定」分别授权。

---

## 8. `extensions/joyous/manifest.json` ⚪

```diff
- "version": [1, "0.2.0"],
+ "version": [1, "0.3.0"],
```

`readExtensionVersion()` 会读取该值作为 `welcome` 中的 `version` 字段。

---

## 9. 改动自检清单

* [ ] `PROTOCOL_VERSION === 2`，握手 `hello`/`welcome` 均含 `subname`
* [ ] 对 v1 对端回 `unsupported_version` 并断开
* [ ] `hello` 中 `capabilities` 含 5 项新能力
* [ ] UDS 与 HTTP 两路都能应答 `chat.publish` / `ai.request` / `identity.bind` / `identity.resolve`
* [ ] 收到外部群消息时能主动发 `chat.broadcast` 到 Joyous
* [ ] 新方法受 `$joyous` 授权闸保护，未授权回 `permission_denied`
* [ ] `unknown_method` 仍对未实现方法生效（V1 韧性要求）

---

## 10. 不改动的部分（明确边界）

* `command.execute` / `status.query` 的**实现与语义不变**；
* 分帧（`codec.js`）、握手状态机骨架、心跳与重连（`uds.js`）、限流与超时
  （`session.js`）**不改**；
* V1 §11 的 `command.execute` 授权语义**不改**。
