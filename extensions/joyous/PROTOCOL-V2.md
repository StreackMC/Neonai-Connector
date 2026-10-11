# Joyous ↔ Neonaic 桥接协议 · 第二版（V2）

> 适用协议主版本：`2`（协议名 `neonai-joyous-bridge` 不变）
> 基础版本：`extensions/joyous/PROTOCOL.md`（下文统称 **V1**）
> 本文档是 V2 的**唯一约定来源**；V1 中未被本文档改写的部分（分帧、寻址、HTTP 细节、
> UDS 细节、权限模型、错误处理韧性）**继续有效**，本文档只做增量描述。

---

## 0. 为什么是 V2（而不是继续待在 V1）

V1 §15 允许「新增可选字段 / 新增错误码 / 新增方法名」在不升版本的前提下演进。
但 V2 引入的不是一两个可选字段，而是**一整族面向业务的方法**：

* `chat.publish` / `chat.broadcast` —— 双向聊天同步
* `ai.request` —— AI 生成请求
* `identity.bind` / `identity.resolve` / `identity.claim` / `identity.unbind` —— 身份绑定（含 §5.7 绑定代码流程）

它们要求**双方都主动实现并对外声明能力**，并且握手帧需要新增 `subname` 字段。
按照 V1 §5.3「主版本必须完全一致、不做事后兼容降级」的既定哲学，我们把主版本提升为 `2`，
让「谁支持了哪些能力」在**握手阶段**就暴露清楚，而不是留到运行期靠 `unknown_method` 才发现。

> 备选方案（本次未采纳）：保持 `v = 1`，仅靠 `capabilities` 协商新方法。
> 该方案对既有部署零破坏，但会让「协议文档」与「线上实际能力」长期分叉，
> 与 V1 §15「不做事后协商降级」的取向相悖。若你更看重平滑升级，可回退到此方案——
> 只需把本文档所有 `v: 2` 视为 `v: 1`、并删除 §2 的版本校验变更即可。

---

## 1. 与 V1 的差异总览

| 方面 | V1 | V2 |
|---|---|---|
| 协议主版本 `v` | `1` | **`2`** |
| 握手帧新增字段 | — | **`subname`**（展示副名，可空） |
| 能力声明 `capabilities` | 仅 `command.execute` / `status.query` | 追加 7 项（见 §3.2） |
| 方法集 | `command.execute` / `status.query` | 追加 `chat.publish` / `chat.broadcast` / `ai.request` / `identity.bind` / `identity.resolve` / `identity.claim` / `identity.unbind` |
| 错误码 | 见 V1 §8 | 追加 `not_bound` / `rate_limited`（见 §7） |
| 分帧 / 寻址 / UDS 细节 | 见 V1 | **完全不变** |
| HTTP 端点 | `POST /neonai/command` | 追加通用端点 `POST /neonai/invoke`（见 §5.6） |

---

## 2. 版本与兼容性

1. 握手帧 `v` 必须为 `2`。对端为 `1` 时，被动端按 V1 §5.3 回复：

   ```json
   {"v":2,"type":"response","id":null,"ts":0,
    "error":{"code":"unsupported_version","message":"协议主版本不匹配（对端为 1，本端为 2）"}}
   ```

   并关闭连接。**不做**「按 v1 降级服务」的兼容路径。

2. `capabilities` 只是**能力提示**，不是权限授予。对端未声明某能力时，
   调用方**应当**避免调用该方法；若仍调用，应答方回 `unknown_method`（与 V1 一致）。

3. 双向均可发起请求：`chat.broadcast` 由 Neonaic 发起、`chat.publish` 等由 Joyous 发起。
   应答方必须原样回填 `id`（V1 §6 约定不变）。

---

## 3. 握手扩展

### 3.1 `subname` 字段

`hello` / `welcome` 在 V1 §5.2 字段基础上**新增一个可选字段**：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `subname` | string | | 展示副名（例如「机器人」）。空字符串或缺省视为无副名。 |

`name` / `subname` 的取值优先级（Joyous 侧展示时）：

```
配置文件显式设置 > 对端握手帧提供 > 缺省占位
```

### 3.2 能力常量（`capabilities` 取值）

| 常量 | 归属方 | 含义 |
|---|---|---|
| `command.execute` | 双向 | （V1）可由对端请求执行命令 |
| `status.query` | Joyous | （V1）可由对端请求查询服务器状态 |
| `chat.publish` | Neonaic | 可接收来自 Joyous 的「MC 聊天外发」请求 |
| `chat.broadcast` | Joyous | 可接收来自 Neonaic 的「外部消息内播」请求 |
| `ai.request` | Neonaic | 可接收来自 Joyous 的 AI 生成请求 |
| `identity.bind` | Neonaic | 可接收身份绑定请求（管理员直接设置） |
| `identity.resolve` | Neonaic | 可接收身份解析请求 |
| `identity.claim` | **Joyous** | 可接收「用绑定代码换取 MC 身份」请求（§5.7） |
| `identity.unbind` | Neonaic | 可接收「解除某 MC 身份全部绑定」请求（§5.7） |

> Joyous 作为被动端（UDS）时在 `hello` 中声明
> `status.query` + `chat.broadcast` + `identity.claim`；
> Neonaic 在 `welcome` 中声明其实现的能力。

---

## 4. 方法总表

| 方法 | 方向 | 请求 `payload` | 成功 `payload` |
|---|---|---|---|
| `command.execute` | 双向 | V1 §7.1 | V1 §7.1 |
| `status.query` | Joyous ← Neonaic | V1 §7.2 | V1 §7.2 |
| **`chat.publish`** | Neonaic ← Joyous | §5.1 | §5.1 |
| **`chat.broadcast`** | Joyous ← Neonaic | §5.2 | §5.2 |
| **`ai.request`** | Neonaic ← Joyous | §5.3 | §5.3 |
| **`identity.bind`** | Neonaic ← Joyous | §5.4 | §5.4 |
| **`identity.resolve`** | Neonaic ← Joyous | §5.5 | §5.5 |
| **`identity.claim`** | Joyous ← Neonaic | §5.7 | §5.7 |
| **`identity.unbind`** | Neonaic ← Joyous | §5.7 | §5.7 |

方向记号：`A ← B` 表示 **B 发起、A 应答**。

---

## 5. 方法详述

### 5.1 `chat.publish`（Joyous → Neonaic）

把一条 **MC 内产生的聊天**外发到 Neonaic 侧的聊天频道（对应配置
`group-chat-sync.from-mc`）。

**请求 `payload`：**

```json
{
  "profile": "profileName",
  "channel": "qGRP#12345678901234567890@aaabbbcccdddeeefff",
  "sender": { "name": "Steve", "uuid": "069a79f4-...", "subname": "" },
  "message": "大家好",
  "ts": 1730000000000
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `profile` | string | ✔ | Neonaic 的 profile 名（来自 Joyous 配置 `group-chat-sync.profile` 的键） |
| `channel` | string | ✔ | 目标频道/群标识（来自该 profile 下配置的标识串，原样透传） |
| `sender` | object | ✔ | 发送者信息（`name` / `uuid` / `subname`） |
| `message` | string | ✔ | 纯文本（已剥离 MC 颜色码；变量已被 Joyous 渲染） |
| `ts` | number | ✔ | 发送时刻（毫秒） |

**成功 `payload`：**

```json
{ "delivered": true, "channel": "qGRP#...", "ts": 1730000000001 }
```

**失败**：`invalid_argument`（缺字段） / `permission_denied`（该 profile 未授权本频道） /
`rate_limited`（触发限流）/ `internal_error`。

> 单向语义提示：若 Joyous 只想「发出去不管回执」，可用 `event` 帧承载同一 `payload`，
> 方法名仍为 `chat.publish`。应答方可忽略；本版按 `request` 定义，回执用于日志与限流反馈。

### 5.2 `chat.broadcast`（Neonaic → Joyous）

把一条**外部聊天**内播到 MC（对应配置 `group-chat-sync.to-mc`，也用于 Neonaic 侧
主动发言）。这是 **Joyous 对外提供**的方法。

**请求 `payload`：**

```json
{
  "profile": "profileName",
  "channel": "qGRP#...",
  "user": {
    "uuid": "069a79f4-44e9-4726-a5be-fca90e38aaf5",
    "name": "Steve",
    "nickname": "某用户",
    "subname": "群友",
    "id": "qUSR#..."
  },
  "message": "你们好呀",
  "visibility": "public",
  "target": null,
  "ts": 1730000000000
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `profile` | string | ✔ | 来源 profile 名 |
| `channel` | string | | 来源频道标识（供日志与回溯） |
| `user` | object | ✔ | 消息来源用户信息，见下 |
| `user.uuid` | string\|null | | 来源**已绑定身份**时为其 MC 玩家 UUID；未绑定则缺省/`null` |
| `user.name` | string | ✔ | **展示名**：已绑定 → 该 MC 玩家名；未绑定 → 聊天昵称 |
| `user.subname` | string | | 可选的副名/头衔（未绑定时会拼接进展示名；已绑定时忽略） |
| `user.nickname` | string | | 来源在聊天软件侧的**原始昵称**（信息用途，供 `[nickname]` 占位符） |
| `user.id` | string | | 聊天侧用户标识（如 `qUSR#…`），供日志与回溯 |
| `message` | string | ✔ | 纯文本正文 |
| `visibility` | string | | `"public"`（广播，缺省）或 `"private"`（仅 `target`） |
| `target` | object\|null | | `visibility="private"` 时必填：`{ "name": "Steve", "uuid": "..." }` |
| `ts` | number | ✔ | 外部消息产生时刻（毫秒） |

**渲染规则**（Joyous 侧）：

* `visibility="public"` → 用配置 `private` 以外的公屏格式（`public-msg` / `public-cover` / `public-click`）渲染后广播；
* `visibility="private"` → 用 `private-msg` / `private-cover` / `private-click` 渲染后仅发给 `target`；
* **展示名解析（本版新增）**：`[user]` 优先取
  * 已绑定（`user.uuid` 存在）：若该玩家在线则取其**实时 MC 名**，否则用 `user.name` 快照；不追加 `subname`；
  * 未绑定：取 `user.name`（聊天昵称）并按旧行为追加 `subname`；
  * 兜底：以上皆空时用 `user.nickname`。
* 已绑定来源的消息以该 MC 玩家作为 **PlaceholderAPI 上下文**（在线时），因此 `public-msg` 里可安全使用 `%player_…%`。
* 新增占位符 `[nickname]`（来源在聊天软件侧的原始昵称）；`[msg]` / `[name]` / `[subname]` / `[user]` 语义不变。
* `*-cover`（悬浮提示）现在同样支持上述全部占位符，因此「正文显示 MC 名、悬浮显示原昵称」可用
  `public-cover: "聊天昵称：[nickname]"` 实现。

**成功 `payload`：**

```json
{ "rendered": true, "visibility": "public", "recipients": 12, "bound": true, "user": "Steve" }
```

> `bound` 与 `user`（解析后的展示名）为本版新增的**可选**回执字段，供 Neonaic 记录/排障；旧实现可忽略。

**失败**：`invalid_argument`（`visibility="private"` 但缺 `target`） / `internal_error`。

### 5.3 `ai.request`（Joyous → Neonaic）

请求 Neonaic 基于给定上下文生成一段 AI 回复（对应配置 `ai.reply-chat-randomly`
与 `ai.reply-by-at`）。**触发判定在 Joyous 侧完成**（概率、间隔、上下文窗口均由 Joyous
按配置裁剪），Neonaic 只负责「拿上下文 → 出文本」。

**请求 `payload`：**

```json
{
  "profile": "profileName",
  "trigger": "random",
  "actor": { "name": "Steve", "uuid": "069a79f4-...", "subname": "" },
  "prompt": "Steve: 今天服务器好卡啊",
  "context": [
    { "speaker": "Alex", "message": "有谁在吗", "ts": 1730000000000 },
    { "speaker": "Steve", "message": "今天服务器好卡啊", "ts": 1730000001000 }
  ],
  "visibility": "public",
  "maxOutputChars": 512
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `profile` | string | | 指定使用的 AI profile；缺省由 Neonaic 决定 |
| `trigger` | string | ✔ | `"random"` / `"at-name"` / `"by-cmd"`，用于 Neonaic 侧区分语气与提示词 |
| `actor` | object | ✔ | 触发者信息 |
| `prompt` | string | ✔ | 主提示（通常是触发者最近一条消息） |
| `context` | object[] | | 上下文消息列表，按时间升序；每项 `{ speaker, message, ts }` |
| `visibility` | string | | `"public"` / `"private"`，供 Neonaic 决定是否附带额外说明 |
| `maxOutputChars` | number | | 输出长度上限建议值，越界时 Neonaic 自行截断 |

**成功 `payload`：**

```json
{ "output": "哈哈确实，我刚重启了实例，现在应该好多了。", "profile": "profileName", "truncated": false }
```

**失败**：`invalid_argument` / `permission_denied`（该 profile 未授权） /
`rate_limited` / `timeout`（AI 生成超时）/ `internal_error`。

### 5.4 `identity.bind`（Joyous → Neonaic）

把一个 **MC 身份**与一个 **Neonaic 侧身份**建立绑定。

> ⚠️ **仅供管理员使用**：这是一条「直接设置」路径，由 Joyous 侧管理员命令
> `/neonaic bind <profile> <chatId> [code]` 触发（权限 `joyous.commands.neonaic.bind`，默认 OP），
> 用于运维与历史数据迁移。**面向玩家的常规绑定请走 §5.7 的绑定代码流程。**

**请求 `payload`：**

```json
{
  "profile": "profileName",
  "mc": { "name": "Steve", "uuid": "069a79f4-..." },
  "chatId": "qUSR#12345678901234567890@aaabbbcccdddeeefff",
  "code": "123456"
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `profile` | string | ✔ | profile 名 |
| `mc` | object | ✔ | MC 身份（`name` / `uuid`） |
| `chatId` | string | ✔ | Neonaic 侧身份标识 |
| `code` | string | | 校验码；用于「在聊天软件里输入验证码」式的双向确认流程，缺省表示直接绑定（取决于 Neonaic 策略） |

**成功 `payload`：**

```json
{ "bound": true, "profile": "profileName", "mc": { "uuid": "..." }, "chatId": "..." }
```

**失败**：`invalid_argument` / `permission_denied` / `not_bound`（校验码错误或流程未完成）。

### 5.5 `identity.resolve`（Joyous → Neonaic）

按 MC 身份查询其对端绑定（用于在渲染消息时补全 `user` 显示名）。

**请求 `payload`：**

```json
{ "profile": "profileName", "mc": { "name": "Steve", "uuid": "069a79f4-..." } }
```

**成功 `payload`：**

```json
{ "bound": true, "chatId": "qUSR#...", "user": { "name": "某用户", "subname": "群友" } }
```

未绑定时 `bound=false` 且不视为错误（正常业务结果）：

```json
{ "bound": false }
```

**失败**：`invalid_argument` / `internal_error`。

### 5.6 HTTP 模式下的方法映射

UDS 模式天然对称（一帧即一次方法调用），V2 全部方法开箱即用。
HTTP 模式则需要在 V1 已定义的端点之外**新增一个通用调用端点**（两侧各一）：

**Neonaic 侧（`httpServer`）**

* 保留 `POST {httpServer.path}`（缺省 `/neonai/command`）—— 仍是 `command.execute`，V1 契约不变；
* 新增 `POST {httpServer.invokePath}`（缺省 `/neonai/invoke`）—— 通用调用，承载
  `chat.publish` / `ai.request` / `identity.bind` / `identity.resolve`：

  ```json
  { "id": "joyous-1", "method": "chat.publish", "payload": { "...": "..." } }
  ```

  成功 `200`：`{ "ok": true, "id": "joyous-1", "payload": { "...": "..." } }`
  失败：`{ "ok": false, "id": "joyous-1", "code": "<code>", "message": "..." }`
  （HTTP 状态码映射同 V1 §9.1；鉴权同 V1 §9.2，沿用 `X-Neonai-Token` / `Bearer`。）

**Joyous 侧（StreackLib HTTPServer，与 JStatusAPI 共用实例）**

* 新增 `POST {connect.http.invokePath}`（缺省 `/neonai/invoke`）—— 承载 `chat.broadcast`
  （以及将来其它 Neonaic→Joyous 的方法），body 同构：

  ```json
  { "id": "na-1", "method": "chat.broadcast", "payload": { "...": "..." } }
  ```

两侧的 `/neonai/invoke` 都接受上面这套 **`{ id, method, payload }` 通用信封**，
应答格式一致。这样「新增一个方法」在 HTTP 模式下只需在 dispatch 表里多注册一项，
不必再新增端点。

> 单帧/请求体上限：HTTP 侧沿用 V1 §9.1 的 256 KiB；UDS 侧沿用 V1 §4 的 1 MiB。

### 5.7 绑定代码流程（`identity.claim` / `identity.unbind`）

面向玩家**自助绑定**：玩家在 MC 内取码，在聊天软件内用码完成绑定。
关联的**权威持有方是 Neonaic**（它同时知道「用户标识」与「MC UUID」）；
Joyous 只持有「一次性代码 → UUID」的短时效映射（缺省 5 分钟）。

#### 5.7.1 流程

```
玩家(MC)                        Joyous                       玩家(聊天软件) → Neonaic
  │ /neonaicbindidentity          │                                   │
  │──────────────────────────────►│ 生成一次性代码(缺省5分钟)           │
  │◄─────── 返回代码（可点击复制） ──│ 仅保留该玩家最新一个代码            │
  │                               │                                   │
  │                               │      /joyous:bind <code>          │
  │                               │◄──── identity.claim {code,chatId} ─│
  │                               │ 校验有效且未过期 → 作废             │
  │                               │──── {bound:true, mc:{name,uuid}} ─►│
  │◄── 通知「绑定成功」（在线时） ──│            Neonaic 保存            │
  │                               │     用户标识(qUSR#…) ↔ MC UUID     │
  │                               │                                   │
  │ /neonaicunbindidentity        │                                   │
  │──────────────────────────────►│─── identity.unbind {mc} ─────────►│
  │                               │◄── {bound:false, removed:[…]} ─────│
```

#### 5.7.2 `identity.claim`（Neonaic → Joyous）

**请求 `payload`：**

```json
{ "code": "K7M2QP", "chatId": "qUSR#12345678901234567890@aaabbbcccdddeeefff",
  "user": { "name": "某用户", "subname": "群友" }, "profile": "main" }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `code` | string | ✔ | 玩家在 MC 内取得的绑定代码；**大小写不敏感**，`-` 与空格会被忽略 |
| `chatId` | string | ✔ | 发起 `/joyous:bind` 的聊天侧用户标识 |
| `user` | object | | 聊天侧用户展示信息（可选，供 Neonaic 存档） |
| `profile` | string | | 来源 profile（可选，原样回显） |

**成功 `payload`：**

```json
{ "bound": true, "mc": { "name": "Steve", "uuid": "069a79f4-..." },
  "chatId": "qUSR#...", "profile": "main" }
```

**失败**：`invalid_argument`（缺 `code`）/ `not_bound`（代码无效、已被使用或已过期）。

> 代码**一次性**：成功认领即作废；同一玩家再次请求只保留最新的一个代码。
> 代码无效/已用/过期**统一回 `not_bound`**，不区分原因（避免探测）。

#### 5.7.3 `identity.unbind`（Joyous → Neonaic）

**请求 `payload`：**

```json
{ "mc": { "name": "Steve", "uuid": "069a79f4-..." }, "profile": "main" }
```

**成功 `payload`：**

```json
{ "bound": false, "removed": ["qUSR#1234...", "qGRP#5678..."] }
```

`removed` 为被解除的聊天侧标识列表；**空数组表示该 MC 身份本就没有绑定**（不是错误）。
`profile` 缺省表示解除该 MC 身份在**全部 profile** 下的绑定。

**失败**：`invalid_argument` / `internal_error`。

#### 5.7.4 绑定后的「玩家名」自动保鲜（Neonaic 侧行为，无需新方法）

Neonaic 保存的关联含一份 **MC 玩家名快照**。§5.1 `chat.publish` 的 `sender` 已携带
`{ name, uuid }`，因此 Neonaic 在收到任一 `chat.publish` 时应：

1. 以 `sender.uuid` 查出该 MC 身份的全部绑定；
2. 若名称快照与 `sender.name` 不同（玩家改名），就地刷新为最新名字；
3. 未绑定的 UUID 直接忽略。

这样无需额外的「改名通知」方法，名称随聊天流自然保鲜。

---

## 6. 事件（`event`）扩展

V2 允许把下列**单向通知**用 `event` 帧承载（`method` 即事件名，不需应答）：

| 事件名 | 方向 | 用途 |
|---|---|---|
| `chat.publish` | Joyous → Neonaic | 与 §5.1 同 payload 的「发出即忘」写法 |
| `identity.changed` | Neonaic → Joyous | 绑定关系发生变更，`payload = { profile, mc, chatId, bound }` |

接收方对**未知事件名**必须忽略（V1 §7.3 韧性要求不变）。

---

## 7. 错误码补充

在 V1 §8 基础上追加：

| `code` | 含义 | 建议处理 |
|---|---|---|
| `not_bound` | 身份尚未绑定 / 校验码不匹配 | 引导用户先完成绑定 |
| `rate_limited` | 触发频率限制 | 退避后重试或放弃本次 |

---

## 8. 两侧能力清单

### Joyous（Java 插件）对外提供
* `status.query` —— 返回 StatusAPI 响应体
* `chat.broadcast` —— 渲染并内播外部消息
* `identity.claim` —— 用绑定代码换取 MC 身份（§5.7）

### Neonaic（Node 应用）对外提供
* `command.execute`
* `chat.publish`
* `ai.request`
* `identity.bind`
* `identity.resolve`
* `identity.unbind`

Neonaic（`$joyous` 身份）对 Joyous 的授权模型沿用 V1 §11，未变化。

---

## 9. 配置对应关系（`Neonaic.yml` → 协议）

| 配置路径 | 使用的协议方法 |
|---|---|
| `name` / `subname` | 握手帧 `name` / `subname`（覆写） |
| `public-msg` / `public-cover` / `public-click` | `chat.broadcast`（`visibility="public"`）渲染 |
| `private-msg` / `private-cover` / `private-click` | `chat.broadcast`（`visibility="private"`）渲染 |
| `connect.method` | 选中 §V1 的 HTTP / UDS 通道 |
| `ai.reply-chat-randomly.*` | 触发端在 Joyous，调用 `ai.request`（`trigger="random"`） |
| `ai.reply-by-at.trigger.at-name` | 调用 `ai.request`（`trigger="at-name"`） |
| `ai.reply-by-at.trigger.by-cmd` | 调用 `ai.request`（`trigger="by-cmd"`） |
| `group-chat-sync.from-mc.*` | `chat.publish` |
| `group-chat-sync.to-mc.*` | `chat.broadcast`（被调用） |
| `group-chat-sync.bind-identity.bind`（命令名/别名、TTL、长度、冷却） | 生成绑定代码；Neonaic 侧以 `identity.claim` 认领（§5.7） |
| `group-chat-sync.bind-identity.unbind`（命令名/别名） | `identity.unbind`（§5.7） |
| `group-chat-sync.bind-identity.*`（管理员直接设置） | `identity.bind` / `identity.resolve` |

---

## 10. 完整交互示例（V2，UDS）

```
JoyousPlugin                                        Neonaic
     │                                                  │
     │ ① accept                                         │ connect(/tmp/neonai-joyous.sock)
     │ ② {"v":2,"protocol":"neonai-joyous-bridge","type":"hello","id":null,"ts":1,
     │     "role":"joyous","name":"Joyous","subname":"","version":"0.3.0",
     │     "capabilities":["status.query","chat.broadcast","identity.claim"],"session":"js-1"}\n
     │ ────────────────────────────────────────────────►│
     │ ③ {"v":2,...,"type":"welcome","role":"neonai","name":"澪奈","subname":"机器人",
     │     "version":"0.2.0",
     │     "capabilities":["command.execute","chat.publish","ai.request",
     │                     "identity.bind","identity.resolve","identity.unbind"],"session":"na-3f2"}\n
     │ ◄────────────────────────────────────────────────│  ══ READY ══
     │                                                  │
     │ ④ 玩家 Steve 发言 → Joyous 请求外发               │
     │ {"v":2,"type":"request","id":"js-1#1","ts":2,"method":"chat.publish",
     │  "payload":{"profile":"main","channel":"qGRP#...",
     │             "sender":{"name":"Steve","uuid":"...","subname":""},
     │             "message":"大家好","ts":2}}\n
     │ ────────────────────────────────────────────────►│
     │ ◄─ {"ok":true,"payload":{"delivered":true,"channel":"qGRP#...","ts":3}}\n
     │                                                  │
     │ ⑤ Neonaic 侧有群消息，请求内播                     │
     │ ◄─ {"v":2,"type":"request","id":"na-3f2#9","ts":4,"method":"chat.broadcast",
     │     "payload":{"profile":"main","channel":"qGRP#...",
     │                "user":{"name":"某用户","subname":"群友"},
     │                "message":"你们好呀","visibility":"public","ts":4}}\n
     │ {"v":2,"type":"response","id":"na-3f2#9","ts":5,"method":"chat.broadcast",
     │  "ok":true,"payload":{"rendered":true,"visibility":"public","recipients":12}}\n
     │ ────────────────────────────────────────────────►│
     │                                                  │
     │ ⑥ Neonaic 请求 AI 回复（玩家 @ 触发）              │
     │ {"v":2,"type":"request","id":"js-1#2","ts":6,"method":"ai.request",
     │  "payload":{"trigger":"at-name","actor":{"name":"Steve","uuid":"..."},
     │             "prompt":"Steve: @澪奈 现在几点","context":[],"visibility":"public"}}\n
     │ ────────────────────────────────────────────────►│
     │ ◄─ {"ok":true,"payload":{"output":"服务器现在是白天哦～","truncated":false}}\n
     │                                                  │
     │ ⑦ {"v":2,"type":"ping","id":"na-3f2#12","ts":7}\n
     │ ◄────────────────────────────────────────────────│  心跳
     │ {"v":2,"type":"pong","id":"na-3f2#12","ts":8}\n
     │ ────────────────────────────────────────────────►│
```

---

## 11. 迁移清单（双方）

* **Neonaic 侧**：见同目录 `NEONAIC-REQUIRED-CHANGES.md`。
* **Joyous 侧**：本仓库 `src/main/java/com/github/streackmc/Joyous/Neonaic/` 已按本文档实现。
  新增配置项见 `src/main/resources/models/Neonaic.yml` 的 `connect` 段。

---

## 12. 连接生命周期与重连（Joyous 侧实现约定）

> 本节描述 Joyous 侧**如何管理连接的开始/结束**，以及**断开后如何恢复**。
> 它不改变线上帧格式，只是把「谁在什么时候建立/拆掉连接」讲清楚。

### 12.1 连接不由插件生命周期驱动

模块 `onEnable` **只做装配**（读配置、构建桥接对象、注册监听器/占位符/命令），
**不建立连接**。连接的开始与结束由**公开 API** 与**命令**掌控：

| 入口 | 签名 / 用法 | 说明 |
|---|---|---|
| 公开 API | `NeonaicSubsystem.get()` 取实例；`startConnection()` / `stopConnection()` / `restartConnection()` / `isConnectionRunning()` / `isPeerReady()` / `connectionMode()` | 供其它模块/插件调用；均幂等、线程安全 |
| 命令 | `/neonaic bridge status \| start \| stop \| restart`（权限 `joyous.commands.neonaic.status`） | 运维手动控制 |
| 配置 | `connect.auto-connect`（缺省 `false`） | 设为 `true` 时模块启用即连接；仍可用命令断开/重连 |

`onDisable` 只在卸载时**清理资源**（关闭监听套接字、注销端点），不代表「生命周期负责连接」。

**start / stop 语义**

* `start()`：UDS 模式创建并开始监听套接字（此刻本端"已连接"，等待对端拨入）；
  HTTP 模式准备出站客户端（无监听、无长连接）。幂等。
* `stop()`：关闭监听、正常关闭处于 READY 的会话（未完成的请求以 `timeout` / 关闭错误结清）、
  删除本端创建的套接字文件、释放调度器。幂等；`stop()` 之后可再次 `start()`。
* `restart()`：`stop()` + `start()`。

### 12.2 断开后如何重连

**UDS 模式下 Joyous 是「监听端」，它不主动重连——重连是连接发起方（Neonaic）的职责。**

```
Neonaic(发起方)                     Joyous(监听端)
    │  connect(path)                    │  ServerSocketChannel.accept() 循环常驻
    │──────────────────────────────────►│
    │◄─────────── hello ────────────────│  accept 后本端先发 hello（§13.2）
    │───────────► welcome ──────────────│
    │◄──────────► 业务帧（JSON+LF）──────►│  ══ READY ══
    │                                   │
    │  ✗ 进程被杀 / 网络抖动 → 连接断开     │  read 返回 EOF → 会话 transportClosed
    │                                   │  未完成请求立即以 timeout 结清
    │                                   │  accept() 循环**继续运行**（不退出、不重建）
    │  ……指数退避重拨（V1 §10）……         │  ◄── 静待下一次 accept
    │  connect(path) ──────────────────►│  接受新连接 → 全新会话 → 重新握手
    │◄─────────── hello ────────────────│  ══ READY ══（无需重启插件/命令）
```

要点：

1. **本端保持监听**：一条连接断开后，`accept()` 循环继续运行，随时接受下一条连接。
   因此「对端重拨」在 Joyous 侧无需任何动作，也不需要 `stop()`/`start()`。
2. **退避在对端**：重连的指数退避（`initialDelayMs=1000`、`factor=2`、`maxDelayMs=30000`、
   抖动 0.2）由 Neonaic 实现（V1 §10）。**只有对端握手成功后才清零重试计数**，
   所以「连上就被踢」不会演变成高频重连风暴——本端作为被动接受方天然不受此影响。
3. **半开连接的发现**：UDS 半开连接不会自己报错（对端进程被杀后本端 socket 仍显示已连接、
   读写永不返回）。因此本端也按 `connect.timeout.heartbeat`（缺省 30000ms，0 关闭）**主动发
   `ping`**，超过 `requestTimeoutMs` 未收到同 `id` 的 `pong` 即判定链路已死，关闭该会话并
   回到等待 accept。
4. **协议不匹配的重连**：若对端带着错误的主版本/协议名连上来，本端按 §2 回
   `unsupported_version` 错误帧并关闭**那一条连接**——监听循环不受影响，对端修正后可再连。
5. **HTTP 模式没有"重连"**：HTTP 是无状态的请求/响应，每次调用独立建立连接。
   此时 `restart()` 只是重建出站客户端对象，不涉及长连接状态。

### 12.3 可观测性

* `/neonaic bridge status` 输出：传输模式、`auto-connect`、连接是否已建立、
  会话是否就绪（`isPeerReady`）、UDS 路径、对端 `name/subname/version/capabilities`、
  HTTP 出站地址。
* 日志：对端就绪打 `对端已就绪`；断开打 `对端连接已断开，本端继续保持监听，等待对端重连`。
