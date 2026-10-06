# Joyous ↔ Neonaic 桥接协议

> 适用版本：协议主版本 `1`（`neonai-joyous-bridge`）
> 实现方：Neonaic 侧见 `src/protocol/`；JoyousPlugin 侧需按下文 §13 实现。

本文档是协议的**唯一约定来源**。Neonaic 侧所有常量都定义在 `src/protocol/constants.js`，
与本文档一一对应；两者不一致时以代码为准，并应立刻回改本文档。

---

## 1. 两种通信模式与数据流

两种模式提供**等价的能力**，只是传输不同。Neonaic 在两种模式下的角色不同：

| | HTTP 模式 | UDS 模式 |
|---|---|---|
| Neonaic 角色 | **客户端 + 服务端** | **被动端**（协议应答方，主动发起连接） |
| 谁监听 | Neonaic 监听命令端点 | JoyousPlugin 建立通信路径 |
| 谁发起连接 | 双向（各自发起各自的请求） | Neonaic 主动去连接 |
| 状态查询（出） | Neonaic → `GET /japi/status` | Neonaic → `status.query` 请求帧 |
| 命令执行（入） | JoyousPlugin → `POST /neonai/command` | JoyousPlugin → `command.execute` 请求帧 |
| 分帧 | HTTP 自身的请求/响应边界 | **JSON + `\n`** |
| 握手 | 无（无状态） | 有（`hello` / `welcome`） |

### HTTP 模式

```
        Neonaic                                    JoyousPlugin
   ┌───────────────┐                            ┌───────────────┐
   │  HTTP Client  │──── GET /japi/status ─────►│  JStatusAPI   │  ← 出：Neonaic 调 StatusAPI
   │  HTTP Server  │◄─── POST /neonai/command ──│  HTTP Client  │  ← 入：对端请求执行命令
   └───────────────┘                            └───────────────┘
```

### UDS 模式

```
        Neonaic                                    JoyousPlugin
   ┌───────────────┐                            ┌───────────────┐
   │  被动端(Bridge)│── connect(path) ──────────►│ 监听套接字/管道 │
   │   Session     │◄─── hello ─────────────────│               │  握手
   │               │──── welcome ──────────────►│               │
   │               │◄──► JSON + \n 双向收发 ────►│               │
   └───────────────┘                            └───────────────┘
```

> Neonaic 是「连接发起方、协议被动方」：由它发起 TCP 层连接，但**握手由对端先开口**
> （`handshake: "responder"`，默认值）。若对端实现期望由 Neonaic 先发 `hello`，
> 把 `uds.handshake` 改成 `"initiator"` 即可，上层逻辑完全不变。

---

## 2. 术语与角色标识

| 术语 | 含义 |
|---|---|
| 本端 / `neonai` | Neonaic（Neonai-Connector 进程） |
| 对端 / `joyous` | JoyousPlugin（Minecraft 服务端上的 Java 插件） |
| 帧 | 一条完整的消息，分帧见 §4 |
| 会话 | 一次 UDS 连接上的完整协议生命周期，从握手到断开 |

握手帧中的 `role` 字段：本端恒为 `neonai`，对端必须是 `joyous`，否则握手失败。

---

## 3. 寻址

### 3.1 HTTP

| 项 | 缺省 | 配置键 |
|---|---|---|
| 命令端点 | `POST http://127.0.0.1:8081/neonai/command` | `httpServer.host` / `.port` / `.path` |
| 健康检查 | `GET http://127.0.0.1:8081/neonai/health` | `httpServer.healthPath` |
| StatusAPI（对端提供） | `GET http://localhost:8080/japi/status` | `status.address` |

安全约束：**监听非回环地址且未配置 `httpServer.token` 时，Neonaic 拒绝启动服务端**，
以避免无意间把命令执行权开放给整个网段。仅监听回环时允许无令牌，但会打一条 WARN。

### 3.2 UDS（跨平台映射）

配置里写的是**逻辑端点**，实际连接串由平台决定（实现：`resolveUdsEndpoint`）：

| 平台 | 配置 | 实际传给 `connect()` 的字符串 |
|---|---|---|
| POSIX | `uds.path = "/tmp/neonai-joyous.sock"` | `/tmp/neonai-joyous.sock` |
| Windows | `uds.path = "/tmp/neonai-joyous.sock"`，`uds.pipe` 缺省 | `\\.\pipe\neonai-joyous` |
| Windows | `uds.pipe = "custom-name"` | `\\.\pipe\custom-name` |
| Windows | `uds.pipe = "\\\\.\\pipe\\already-full"` | 原样使用 |

推导规则：Windows 下若未显式给 `pipe`，取 `path` 的**最后一段文件名并去掉 `.sock` 后缀**
作为管道名（`/var/run/neonai-joyous.sock` → `neonai-joyous`）。

> 平台差异被刻意压缩到「端点字符串解析」这一个纯函数里，其余上层逻辑（握手、分帧、
> 请求响应、心跳、重连）**完全共用同一份实现**——跨平台行为一致性由此保证，
> 而不是靠两套代码各自对齐。

**陈旧套接字**：POSIX 上插件异常退出会留下无人监听的套接字文件。Neonaic 是**连接方、
不是该文件的所有者**，因此绝不会自行删除它；只在日志里给出明确提示
（`ECONNREFUSED` → 「文件存在但无人监听，请重启 JoyousPlugin 或由插件侧清理」）。

---

## 4. 分帧

一帧 = **一行 JSON + 一个 LF（`\n`）**。

```
{"v":1,"type":"request","id":"na-3f2#7","ts":1730000000000,"method":"command.execute","payload":{...}}\n
```

为什么 LF 是安全的分隔符：`JSON.stringify` 永远不会在输出里产生**裸换行**——字符串中的
换行会被写成两个字符 `\` `n`。因此 LF 只可能出现在帧尾，无需任何转义。

接收方必须满足以下韧性要求（Neonaic 侧已实现，Java 侧应对齐）：

| 情形 | 要求 |
|---|---|
| 半包 | 一次 read 只拿到半行 → 缓存并等待后续数据 |
| 粘包 | 一次 read 拿到多行 → 逐行切分，全部处理 |
| CRLF | 行尾为 `\r\n` 时必须同样能工作（容忍 `println` 的写法） |
| 空行 | 忽略（不视为协议错误） |
| 坏帧 | 单行不是合法 JSON 对象 → 记录并**丢弃该行**，不要断开连接 |
| 超限 | 累计缓冲超过 **1 MiB** 仍未出现 LF → 视为协议错误并断开 |

---

## 5. 握手

### 5.1 次序

`uds.handshake = "responder"`（默认，Neonaic 为被动端）：

```
JoyousPlugin                          Neonaic
     │  (accept)                          │  (connect)
     │                                    │
     │ ◄──────────── hello ───────────────│  ① 对端先发 hello
     │──────────── welcome ──────────────►│  ② 本端回 welcome
     │                                    │
     │ ◄────────► 业务帧（request/response/event/ping/pong） ◄────────►│
```

`uds.handshake = "initiator"` 时①②角色互换（本端先发 `hello`，对端回 `welcome`）。

宽容规则：主动端若收到的是 `hello`（说明对端也是主动），本端回 `welcome` 并完成握手，
避免双方互等而僵死。

### 5.2 握手帧字段

`hello` 与 `welcome` 结构相同：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `v` | number | ✔ | 协议**主版本**，当前为 `1` |
| `protocol` | string | ✔ | 固定 `"neonai-joyous-bridge"` |
| `type` | string | ✔ | `"hello"` 或 `"welcome"` |
| `id` | null | ✔ | 握手帧无 id |
| `ts` | number | ✔ | 发送时刻（毫秒时间戳） |
| `role` | string | ✔ | `"neonai"` 或 `"joyous"` |
| `name` | string | ✔ | 展示名 |
| `version` | string | ✔ | 实现版本，如 `"0.3.0"` |
| `capabilities` | string[] | | 本端可**对外提供**的能力，见 §7 |
| `session` | string | | 会话标识，仅用于日志关联 |

### 5.3 校验与失败

对端帧必须同时满足：

1. `protocol === "neonai-joyous-bridge"`
2. `v === 1`（主版本必须**完全一致**，不做事后兼容）
3. `role === "joyous"`

任一条不满足 → 本端回一个错误帧并关闭连接：

```json
{"v":1,"type":"response","id":null,"ts":0,"error":{"code":"unsupported_version","message":"..."}}
```

握手超时（缺省 5000 ms，配置 `uds.handshakeTimeoutMs`）→ 关闭并进入重连。

**握手完成前收到业务帧**：回 `not_handshaken` 错误帧但不立即断开（可能只是时序竞争）。

---

## 6. 帧类型与通用字段

| `type` | 方向 | 需应答 | 说明 |
|---|---|---|---|
| `hello` | 主动端 → 被动端 | ✔（`welcome`） | 握手首帧 |
| `welcome` | 被动端 → 主动端 | ✘ | 握手应答 |
| `request` | 双向 | ✔（`response`） | 业务请求 |
| `response` | 双向 | ✘ | 业务应答 / 错误 |
| `event` | 双向 | ✘ | 单向通知 |
| `ping` | 双向 | ✔（`pong`，同 `id`） | 心跳探活 |
| `pong` | 双向 | ✘ | 心跳应答 |

### `request`

```json
{ "v": 1, "type": "request", "id": "na-3f2#7", "ts": 1730000000000,
  "method": "command.execute", "payload": { "input": "neonaic:help" } }
```

### `response`（成功）

```json
{ "v": 1, "type": "response", "id": "na-3f2#7", "ts": 1730000000000,
  "method": "command.execute", "ok": true, "payload": { "output": "…", "ref": "neonaic:help" } }
```

### `response`（失败）

```json
{ "v": 1, "type": "response", "id": "na-3f2#7", "ts": 1730000000000,
  "ok": false, "error": { "code": "permission_denied", "message": "…" } }
```

约定：

* `id` 由**发起方**生成，应答方必须原样回填；实现建议用「会话标识 + 递增序号」
  （Neonaic 用 `na-<instance>#<n>`）。
* `id` 不一致的应答：记录 WARN 并丢弃。
* 同一连接上请求可并发，靠 `id` 关联。
* 超时（缺省 `uds.requestTimeoutMs = 10000`）后发起方即可判失败，迟到应答按未知 `id` 丢弃。

---

## 7. 方法

`capabilities` 里申报的就是本端**能被对端调用**的方法名：

| 方法 | Neonaic 提供 | JoyousPlugin 提供 | 说明 |
|---|---|---|---|
| `command.execute` | ✔ | — | 对端请 Neonaic 执行一条命令 |
| `status.query` | ✔（代理） | ✔ | 取状态数据（等价于 HTTP `GET /japi/status`） |
| `ping` | ✔ | ✔（作为帧类型） | 见 §6 |

### 7.1 `command.execute`

**请求 `payload`**（两种等价写法，任选其一）：

```json
{ "input": "neonaic:help moon" }          // 整行文本，按 POSIX 规则切分
{ "command": "neonaic:help", "args": ["moon"] }
```

**成功 `payload`**：

```json
{ "ref": "neonaic:help", "namespace": "neonaic", "name": "help",
  "output": "…返回文本…", "truncated": false }
```

* `ref` 是**实际解析到的**命令（别名会被归一化）。
* `output` 为命令返回值的文本化结果；非字符串返回值会被 JSON 序列化。
* 超过 16384 字符会被截断，`truncated` 置 `true`。
* 输入超过 8192 字符直接拒绝（`invalid_argument`）。

**失败**：错误码见 §8。特别注意 `permission_denied` —— 对端身份是 `$joyous`，
默认**没有任何权限**（见 §11）。

### 7.2 `status.query`

**请求 `payload`**：`{ "address": "http://localhost:8080/japi/status" }`（`address` 可省略，
省略时用本端配置的 `status.address`）。

**应答 `payload`**（无论成功失败都是 `ok: true` 的信封，成败在 payload 里区分，
因为「服务器离线」是正常业务结果而不是协议错误）：

```json
{ "ok": true, "data": { "online": true, "players": { … }, "tps": { … } } }
{ "ok": false, "reason": "offline" }
```

`data` 的结构即 Joyous StatusAPI 的响应体。`reason` 取值：`"offline"`（非 2xx / 空响应）、
`"invalid"`（非 JSON 或结构不符）、或具体错误消息。

### 7.3 `event`

单向通知，无需应答。Neonaic 目前不主动发送任何 `event`；对端发来的 `event` 会被记录，
未知事件名不应导致断开。

---

## 8. 错误码

| `code` | 含义 | 建议处理 |
|---|---|---|
| `bad_frame` | 帧无法解析或结构不合法 | 记录后丢弃；连续出现应断开 |
| `frame_too_large` | 单帧超过 1 MiB | 断开并检查对端实现 |
| `unsupported_version` | 协议名或主版本不匹配 | 断开；升级其中一侧 |
| `handshake_timeout` | 握手超时 | 断开并重连 |
| `not_handshaken` | 未握手就发业务帧 | 等待握手完成 |
| `unknown_method` | 方法未实现 | 检查 `capabilities` 后再调用 |
| `invalid_argument` | 请求参数不合法 | 修正请求 |
| `unknown_command` | 命令不存在 | 用 `neonaic:help` 查可用命令 |
| `permission_denied` | `$joyous` 未被授权 | 见 §11，由管理员授权 |
| `command_failed` | 命令存在但执行失败 | 看 `message` |
| `timeout` | 命令执行超过 `dispatch.commandTimeoutMs` | 调大超时或拆小任务 |
| `internal_error` | 本端内部错误 | 查 Neonaic 日志 |

---

## 9. HTTP 模式细节

### 9.1 命令端点

`POST {httpServer.path}`，`Content-Type: application/json`，请求体与 §7.1 的 `payload` 同构，
可额外带一个 `id`（仅用于日志关联与回显）：

```json
{ "id": "joyous-42", "input": "neonaic:help" }
```

成功响应 `200`：

```json
{ "ok": true, "id": "joyous-42", "ref": "neonaic:help", "namespace": "neonaic",
  "name": "help", "output": "…", "truncated": false }
```

失败响应：HTTP 状态码按下表，**响应体固定含 `ok:false` 与 `code`**。
客户端应以响应体里的 `code` 为准，不要依赖状态码做业务判断。

| HTTP | `code` |
|---|---|
| 400 | `bad_frame` / `invalid_argument` |
| 401 | `unauthorized` |
| 403 | `permission_denied` |
| 404 | `unknown_command`（端点不存在时也返回 404，但 `code` 为 `not_found`） |
| 405 | 方法不对（`Allow: POST`） |
| 413 | `frame_too_large`（请求体 > 256 KiB） |
| 500 | `command_failed` / `internal_error` |
| 501 | `unknown_method` |
| 504 | `timeout` |

### 9.2 鉴权

按顺序检查以下任一位置，命中即通过：

* `X-Neonai-Token: <token>`
* `X-Joyous-Token: <token>`
* `Authorization: Bearer <token>`

比较为常量时间实现，避免计时侧信道。未配置 `token` 时不校验（仅限回环监听）。

### 9.3 健康检查

`GET {httpServer.healthPath}` → `200`：

```json
{ "ok": true, "protocol": "neonai-joyous-bridge", "v": 1,
  "role": "neonai", "name": "澪奈", "version": "0.1.0", "ts": 1730000000000 }
```

侧信道：所有响应都带 `X-Neonai-Protocol: neonai-joyous-bridge/1` 标头。

---

## 10. UDS 模式细节

* **连接**：单向发起，由 Neonaic 主动 `connect()`；连接失败按指数退避重连
  （`initialDelayMs=1000`、`factor=2`、`maxDelayMs=30000`、`jitterRatio=0.2` 抖动）。
* **退避复位**：**只有握手成功才清零重试计数**。若「连上就被踢」，计数会持续增长，
  从而避免高频重连风暴。
* **心跳**：每 `heartbeatMs`（缺省 30000，0 表示关闭）发一个 `ping` 帧，
  超过 `requestTimeoutMs` 未收到同 `id` 的 `pong` 即判定链路已死并断开重连。
  UDS 的**半开连接**不会自己报错（对端进程被杀后本端 socket 仍显示已连接、读写永不返回），
  所以心跳不是可选项而是必需品。
* **关闭语义**：任一方断开后，未完成的请求立即以 `timeout`/关闭错误结清，不悬挂。

---

## 11. 权限模型（`$joyous` 白名单）

JoyousPlugin 被视为**不受信任的外部身份** `$joyous`（与 `$console` 同级的虚拟执行者，
枚举定义在 `src/command/commandInterface.js` 的 `COMMAND_ENUMS.FROM_JOYOUS`）。

它**不具备** `internalCall` 语义，因此一切权限都必须由权限系统显式授予。
白名单由三层叠加而成——全部复用内核既有权限机制，没有新增任何权限框架：

| 层 | 权限名 | 语义 |
|---|---|---|
| 1. 总闸 | `joyous.bridge.execute` | 必须显式授予，否则一律拒绝。**默认不授予 ⇒ 开箱即全关** |
| 2. 命令自身 | 命令注册时声明的 `permissions` | 由命令系统原生语义校验（AND / OR / `!` 否定），与 CLI、平台侧同源 |
| 3. 空权限补漏 | `joyous.command.<ns>:<name>` | 命令未声明权限时（命令系统里等价于「任何人可执行」），外部身份需额外持有该专有授权 |

授权示例：

```
/neonaic:permission set $joyous joyous.bridge.execute true
/neonaic:permission set $joyous joyous.command.neonaic:help true
```

查看当前授权与通道状态：`/joyous:bridge`（需管理员）。

---

## 12. 配置项速查

完整注释见 `../config.json`。关键项：

| 配置键 | 缺省 | 说明 |
|---|---|---|
| `status.transport` | `"auto"` | `auto` / `http` / `uds` |
| `status.address` | `http://localhost:8080/japi/status` | StatusAPI 地址 |
| `httpServer.enabled` | `false` | 是否接收命令请求 |
| `httpServer.port` | `8081` | 监听端口 |
| `httpServer.token` | `""` | 共享令牌 |
| `uds.enabled` | `false` | 是否连接对端 UDS 路径 |
| `uds.path` | `/tmp/neonai-joyous.sock` | POSIX 路径 / Windows 管道名来源 |
| `uds.pipe` | `neonai-joyous` | Windows 管道名 |
| `uds.handshake` | `"responder"` | `responder` / `initiator` |
| `uds.heartbeatMs` | `30000` | 心跳间隔，0 关闭 |
| `dispatch.commandTimeoutMs` | `30000` | 单条命令兜底超时 |

**默认配置下不发任何新连接、不监听任何新端口**：`status` 查询行为与重构前完全一致，
`httpServer` 与 `uds` 都需显式开启。

---

## 13. JoyousPlugin（Java）侧实现清单

UDS 模式需要在插件侧补齐：

1. **创建通信路径**
   * POSIX：`ServerSocketChannel.open(StandardProtocolFamily.UNIX).bind(UnixDomainSocketAddress.of(path))`
   * Windows：`new ServerSocket(...)` 绑定 `\\.\pipe\neonai-joyous`
     （Java 侧可用 `ServerSocketChannel` + `AF_UNIX`，或走命名管道实现；两侧端点字符串必须一致）
   * 路径与 Neonaic 的 `uds.path` / `uds.pipe` 对齐。
2. **握手**：accept 后先发 `hello`（字段见 §5.2，`role` 必须为 `"joyous"`），
   等 `welcome` 后再进入业务；超时 5s 内未完成则关闭。
3. **分帧**：按 §4 实现「按 `\n` 切行 + 缓存半包」；**不要**用 `BufferedReader.readLine()`
   直接读——它会把「半包」当成整帧，需要用换行符显式切分并自行拼接。
4. **应答**：收到 `request` 必须回 `response`（成功带 `payload`，失败带 `error.code`）。
5. **心跳**：收到 `ping` 必须回同 `id` 的 `pong`；建议同时对 Neonaic 发 `ping` 探活。
6. **命令执行**：以 `POST /neonai/command`（HTTP）或 `command.execute`（UDS）请求体调用
   Neonaic；注意默认未授权，需先按 §11 授权。
7. **状态查询**：若要支持 Neonaic 经 UDS 取状态，需实现 `status.query` 方法，
   返回 `{ ok: true, data: <StatusAPI 响应体> }`。
8. **清理**：正常关闭时删除 POSIX 套接字文件；异常退出留下的陈旧文件由**插件侧**清理，
   Neonaic 不会代劳（见 §3.2）。
9. **HTTP 模式**：若走 HTTP，插件侧只需保留现有 `JStatusAPI`（Neonaic 的客户端），
   并新增一个 HTTP 客户端向 `/neonai/command` 发 POST。

---

## 14. 完整交互示例（UDS）

```
JoyousPlugin                                    Neonaic
     │                                              │
     │  ① 对端 accept                                │  connect(/tmp/neonai-joyous.sock)
     │                                              │
     │  ② {"v":1,"protocol":"neonai-joyous-bridge", "type":"hello","id":null,"ts":1,
     │      "role":"joyous","name":"Joyous","version":"0.3.0",
     │      "capabilities":["status.query"],"session":"js-1"}\n
     │ ────────────────────────────────────────────►│
     │                                              │  校验 protocol/v/role
     │  ③ {"v":1,...,"type":"welcome","role":"neonai","name":"澪奈","version":"0.1.0",
     │      "capabilities":["command.execute","status.query"],"session":"na-3f2"}\n
     │ ◄────────────────────────────────────────────│
     │                                              │  ══ READY ══
     │  ④ {"v":1,"type":"request","id":"js-1#1","ts":2,
     │      "method":"command.execute","payload":{"input":"joyous:mc"}}\n
     │ ────────────────────────────────────────────►│
     │                                              │  校验 $joyous 三层授权
     │                                              │  → 执行 neonaicCommandServer
     │  ⑤ {"v":1,"type":"response","id":"js-1#1","ts":3,"method":"command.execute",
     │      "ok":true,"payload":{"ref":"joyous:mc","namespace":"joyous","name":"mc",
     │      "output":"“栈流Streack”正在运行；…","truncated":false}}\n
     │ ◄────────────────────────────────────────────│
     │                                              │
     │  ⑥ {"v":1,"type":"ping","id":"na-3f2#9","ts":4}\n
     │ ◄────────────────────────────────────────────│  心跳（每 30s）
     │  ⑦ {"v":1,"type":"pong","id":"na-3f2#9","ts":5}\n
     │ ────────────────────────────────────────────►│
```

未授权时的 ⑤ 会变成：

```json
{ "v":1, "type":"response", "id":"js-1#1", "ts":3, "ok":false,
  "error":{ "code":"permission_denied",
            "message":"身份 $joyous 未获授权：缺少 joyous.bridge.execute" } }
```

HTTP 模式下的等价交互：

```
Neonaic  ──GET  /japi/status──────────────────►  JoyousPlugin      （状态查询）
Neonaic  ◄─POST /neonai/command {"input":"…"} ─  JoyousPlugin      （命令执行）
           X-Neonai-Token: <token>
```

---

## 15. 兼容性与演进

* **主版本 `v` 必须完全一致**。任何破坏性变更（字段改名、语义改变、帧结构变化）都要
  递增 `PROTOCOL_VERSION`，并**同步修改本文件与 `constants.js`**。
* 新增**可选字段**、新增**错误码**、新增**方法名**属于向后兼容演进，
  不需要改 `v`：接收方必须忽略不认识的字段与 `event` 方法。
* 永不实现的兼容路径：不做事后协商降级。版本不一致就直接断开并报
  `unsupported_version`，把问题暴露在握手阶段而不是运行期。
