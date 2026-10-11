# Neonai-Connector 项目长期记忆

## 概览与架构
- **Neonai-Connector** — Node.js (ESM) 服务端，与「澪奈 (Neonai)」沟通的桥梁；显示名取 `config/main.json` 的 `name`/`subname`。License **AGPL-3.0 + 附加条款**（禁止复用美术资源、禁止把 "Neonai"/「澪奈」当自身品牌）。
- 组合根 + 依赖注入：`src/system/`（entry、confManager、cliProcessor、pidManager）｜`logger/`｜`command/`（commandServer、permissionServer、commandInterface）｜`message/`（ai、messageIn、userDirectory）｜`event/`｜`platform/`｜`extension/`（extLoader、extManager）｜`utils/`（NeonaicConfig、NeonaicNewableClass、NeonaicNewableError、NeonaicUriMeta、io、chore、math）；拓展在 `extensions/`。`main.js` 瘦入口，`debug.cjs` 调试入口（非 TTY 下 `$("cmd")` 模拟 CLI）。错误统一抛 `Neonaic*Error`（IllegalState/IllegalArgument/IO/Protocol/Network ↔ Java 同名），不抛裸 `Error`。
- 函数/常量**只导出单个命名空间对象**（`export const neonaicXxx = {...}`）；**类一律 `export class`，不嵌套**；camelCase（含 extensions 侧）。例外只有 `chore.js` 的 `parseString`、`Logger.js` 的 `getLogger()`、`log4js_inject.js` 的 `configure`。对象字面量放文件**末尾**（`class` 不提升 → TDZ）；JSDoc 类型引用写 `import('./x.js').类名`，**不写悬空 `{@link}`**。

## 内核要点
**NeonaicConfig**：五种 `WRITE_MODES`（**默认 AUTOSAVE**）、自动重载 + `onAutoReloaded`/`onLoadFailure`、`reload`/`getFile`、`isExist`/`remove`、全套类型化 getter/putter、`getSection`（浅拷贝，非对象回退 `def`）、链式、原子写入、`\.` 转义点号、静态 `fromObject`/`fromJSON5`。有意不做：多格式（只 JSON5）、注释、RootName、BigDecimal。
- ⚠️ **`getConfig(path)` 按原始字符串缓存**：`'./x.json'` 与 `'x.json'` 是**两个实例**；测试里改配置必须用与生产**逐字相同**的路径（如 `joyousConfig.CONFIG_PATH`）。缓存实例**不会**因外部改写自动重读，要显式 `reload()`。
- ⚠️ **`getList(key, def = [])`/`getString(key)` 要显式传默认值**：不传时「字段缺省」得到 `[]`/`undefined`，会被归一化层误判成「用户写了空值」并记 issue（已在 joyous `bridge.ai.AIlist` 踩过）。
- ⚠️ 写出的是 **JSON5**（键无引号、单引号），读回要 `JSON5.parse`；嵌套路径**不能下探数组**。

**命令系统**：`registerCommand(ns, name, handler, opts)`；import 时自注册，handler 的 `this` 是 `NeonaicCommandContext`（`handler.call(ctx, ...args)`）。opts：`alias`/`permissions`/`description`/`usage`/`permissionDefault`。**输入解析全仓库只有一份 `resolveCommandArgs(input, prefixes?, trim)`**：省略 `prefixes` 时与旧 `parseArgs` 逐字一致；传了 `prefixes` 而**无一匹配返回 `null`**（＝「不是命令」，交给 AI 兜底）；其余恒为 `[命令名, 参数]`。既有行为（非 bug）：**长度为 0 的 token 被丢弃**。

**权限系统**（`command/permissionServer.js`）：4 层存储：临时 > 永久（按用户）> 全局临时 > 全局永久；执行者链 `["USR#x","GRP#y"]` 从左到右继承，末尾隐式 `*`。
- **表达式**：叶子=字符串（可带 `!` ＝须缺失）；数组=分组，语义**按嵌套深度交替**（第 0 层 AND → 第 1 层 OR → 第 2 层 AND…；`[[[a,b],c]]` = (a AND b) OR c）。`[]` 恒 true、`[[]]` = false。
- **无 null 三态**：`checkPermission`/`checkSinglePermission`/`checkPermissionFromContext` 均 `(…, fallback = false)` **恒返回布尔**；未显式设置时取 `fallback`，**之后**才施加 `!`。`undefined`/`''`/`'*'` 恒 false。`checkSinglePermission` 只收**单个**用户字符串；`getSinglePermissionStatus` 返回 `{status:'true'|'false'|'unset', scope, permanent}`（**不是布尔**），perm 不可带 `!`。
- `checkPermissionFromContext` 在 `ctx.internalCall` 时**直接放行**。⚠️ `commandServer.js` 写 `permissions: perms` **不复制数组**（外部改原数组即可改已注册命令的权限）。

**扩展系统**：`extLoader.js`（`NeonaicExtItem`）｜`extManager.js`。`scan()` 返回 `Map<id, NeonaicExtItem>`（item 公开访问器只有 `export`/`manifest`/`name`/`id`/`fullname`/`enabled`）。返回结构以文件 `@typedef` 为准：payload = `{operation, status, error, id}`（`operation` ∈ `load|unload|enabled|disabled`，enable/disable 用过去分词；`status` ∈ `notfound|successfully|failed|disabled`）；批量 = `{operation, succeed, notfound, disabled, failed}`。
- **两套语义正交**：`load`/`unload` 只管运行期；`enable`/`disable` 只管 `ext.json` 开关。⚠️ **`load` 会吞掉 onEnable 异常并返回 `status:'failed'`**（不 throw）⇒ 验证 onEnable 必须**检查返回值**或直接调 `entry.onEnable()`。
- 布局：`extensions/<name>/src/*.js` + 同级 `manifest.json`（`entry` 写 `./src/entry.js`）；`meta.id` 须匹配 `^[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)*$`（**不能带连字符**，目录名可以）；拓展内导入内核用 `../../../src/...`。`enable()` 要求入口同时导出 `onEnable`/`onDisable`。会话式拓展模板：私有 `Map` + 超时清理器 + 魔术 token。

## Joyous 桥接拓展（`extensions/joyous/`）
与 Java 插件 [StreackMC/Joyous](https://github.com/StreackMC/Joyous) 协作的双通道桥接。**V1 见 `PROTOCOL.md`（§16 是 V2 落地说明）；V2 增量以 `PROTOCOL-V2.md` 为唯一约定来源，必需改动清单见 `NEONAIC-REQUIRED-CHANGES.md`**（后两份是对端 `docs/neonaic/` 的副本）。常量以 `src/protocol/constants.js` 为准，对端以 `Neonaic/bridge/BridgeProtocol.java` 为准，**自检解析该 Java 文件逐项比对**。
- 分层：`src/entry.js` 组合根｜`config.js`｜`identity.js`｜`status.js`｜`protocol/`（`constants`/`codec`/`session`/`http`/`uds`/`dispatch`/`methods`）。**`protocol/` 下导入内核是 4 层** `../../../../src/...`。两个接缝：`dispatch.js` 认识命令系统、`methods.js` 认识平台/AI/身份，**都不认识具体传输**；http.js/uds.js 只认「handler + {method,payload}」。
- 传输：HTTP = 同时当客户端与服务端（`/neonai/command` + `/neonai/invoke`）；UDS = **被动端**，主动 `connect` 对端建立的路径（**Joyous 是监听方且 accept 后先发 hello ⇒ 本端 `handshake` 必须 `responder`**）。`status.transport`/`bridge.transport` = `auto`(UDS 就绪优先，失败回退 HTTP)/`http`/`uds`。
- ⚠️ **连接生命周期（对端文档 §11）**：Joyous **是监听端且不主动重连**，恢复**完全依赖本端重拨**。必须保留指数退避（`initialDelayMs=1000`/`factor=2`/`maxDelayMs=30000`/抖动 0.2），且**退避计数只在握手成功后清零**（否则「连上就被踢」→ 重连风暴）。对端未 `bridge start` 时套接字不存在 → 持续 `ENOENT/ECONNREFUSED` 是**预期行为**，按退避重拨即可，不报致命错误。
- 方法：本端**应答** `chat.publish`（MC→聊天，投递到 `bridge.profiles[profile].channels` 白名单频道；并按 `sender.uuid` **刷新绑定表里的玩家名快照**）、`ai.request`、`identity.bind`/`identity.resolve`（`code` 空＝不校验）、`identity.unbind`（回 `{bound:false, removed:[chatId…]}`，`removed` 空**不是错误**）。本端**发起** `identity.claim`（一次性绑定代码换 MC 身份；失败一律按「无效或已过期」提示，对端刻意不区分原因）、`chat.broadcast`。
- **内播触发**：订阅内核 `neonaic:message`，按**执行者链 × 配置频道白名单**匹配（不硬编码平台前缀）。`user` 载荷 = `{uuid: 绑定的 MC UUID 或 null, name: MC 玩家名或聊天昵称, nickname: 聊天昵称, subname:'', id: 原始代号}`；**未登记的代号绝不当作名字展示**。**入站 `chat.broadcast` 的 `user.name` 正是取自 `chat.publish` 刷新的那份快照** —— 两侧构成闭环。
- **授权两套独立**：命令走 `joyous.bridge.execute` + 命令 `permissions` + 空权限命令的 `joyous.command.<ns>:<name>`；业务方法走 `bridge.allowedMethods`（配置白名单，缺省 5 项）+ `joyous.bridge.business`（总闸，**默认不授予**）+ `joyous.bridge.<method>`（**显式 false 才拒绝**）。`BRIDGE_EXECUTOR = '$joyous'` 定义在拓展内，改名会让既有授权失效。
- **自助命令** `/joyous:bind <code>`、`/joyous:bind clear`、`/joyous:chatsync [on|off]`：三者**只作用于调用者自己**，拒绝 `ctx.internalCall` 与 `$` 开头的合成执行者。`chatsync` 切换**逐用户**权限 `joyous.chatsync.disabled`（持有＝不把自己的聊天内播到服务器侧），与三层业务闸无关。
- 管理命令 `joyous:bridge`；AI 工具 `worldMeta`、`serverStatus`。绑定表 `config/saves/joyous-identities.json`（**以 `chatId` 为键**：`profile → chatId → {uuid, name, boundAt}`；有 uuid 只认 uuid，拿不到才退回按名字匹配）。
- ⚠️ 两侧 profile 命名可以不同：Joyous 的 `group-chat-sync.profile` 键与 Neonaic 平台 Profile 名**不是一套命名**，由 `bridge.profiles.<键>.platform` 显式对应（用户当前两处同名，频道形如 `qGRP#<群哈希>@<机器人号>`）。
- ⚠️ 对端 `Neonaic.yml` 的 `connect.timeout.request`（缺省 10 秒）是**对端等我方应答的上限**；`ai.request` 要调到 60 秒以上。
- ⚠️ 改 `extensions/joyous/config.json` 后要 `/neonaic:reload` **并重启拓展**，通道不热切换。

## AI 调用链
- 链路：平台事件 → 平台拓展（qqbot/msgHandler）→ `neonaicMessageIn.resolveReply(msg, {AI, AIlist, resolveCommandWith})` → `neonaicAI.askAI(msg, {AIlist, caller, speaker, overridePrompt, overrideAITool})` → `callProvider`。**AI Profile = `secret.json` 的 `oai[]`**：`{name, available, address, token, model, tools, maxToolcall, prompt}`（`prompt` 指向 `config/prompts/<file>.md`）。
- **`AIlist` 只过滤、不决定顺序**（`getList('oai').filter(...)` 保持源顺序）⇒ **尝试顺序恒等于 `oai` 声明顺序**。`available:false` 是**独立闸门**；内核已内置「跳过不可用 + 逐个 try 失败换下一个」。
- **模式列表（`tools` 与 `AIlist` 共用 `resolvePatternList`）**：`"*"` 全选 / `"!name"` 排除（排除优先）/ `"!*"` 全排除。**严格度不同**：`AIlist` **严格**（只写排除项 → 抛错），`tools` **宽松**（`["!x"]` = 一个都不给）。
- **`PlatformManager` 构造 profile 是 `{...raw, _debug}`** ⇒ 平台 Profile 可携带任意自定义键并原样透传（qqbot 的 `platforms[].aiRouting` 由 `extensions/qqbot/src/aiRoute.js` 的 `pickAIList` 消费：维度 `scene`/`group`/`user`/`permission`/`match`，when 字段间 AND、字段内 OR，首条命中即用，`use:"*"`=沿用 `allowedAI` 只能收窄）。⚠️ `_writeProfileEnabled` 用 `JSON5.stringify` 整体重写 `secret.json`，**会丢手写注释**。
- **用户名录**：`src/message/userDirectory.js` 的 `neonaicUserDirectory`，`code → {name, pronoun?, note?}`，存 `config/saves/identities.json`。**判据**：名录是通用概念 ⇒ 内核；「某平台怎么拿到名字」是平台特定 ⇒ 拓展。投递走 `askAI` 注册的**临时 AI 工具** `neonaic:speaker`，**不注入提示词**；入口 `/neonaic:ai whois <list|get|set|unset|show>`。qqbot 用免费的 `group_name` 自动登记；**QQ 群/C2C 拿不到发送者昵称**，只能人工登记。**未登记的 code 一律丢弃**。
- `askAI` 的 tools 合并坑（已修）：`provider.tools` 解析为空时整个 `tools` 键曾被省略、**overrideAITool 被静默丢弃**；必须**先合并再判空**。

## 配置 / gitignore / 硬约束
- `config/main.json` — 名称/次名、`prefix`、`maxLogFileSize`、`detailedLog`、`ai.*`；`config/prompts/<profile>.md` 提示词（**gitignore**）。**`config/saves` 整目录 gitignore**，但 `ext.json`/`permissions.json` 因**规则加入前已被跟踪**而仍在版本控制；**新增文件（`identities.json`、`joyous-identities.json`）不会入库**。根目录 `secret.json` 是真凭据（gitignore），`config/secret.json` 是模板（入库）。拓展自带 `extensions/<name>/config.json` ⚠️ **已入库**且用户会填自己的部署参数（开启通道、真实频道、端口）——自检**不要依赖它的内容**，要自带配置。
- **内核不得出现任何拓展名**（解耦硬判据）：看一处改动**会不会留下「本体只在某拓展存在时才有意义」的东西**。拓展专属的合成执行者身份（`$joyous`）必须定义在拓展内，**不得写进内核 `COMMAND_ENUMS`**；`$` 前缀是内核保留的合成身份命名空间（内核只占 `$console`/`$unknown`），权限按执行者字符串存授权。反例：`NeonaicProtocolError` 这类**通用错误词汇**进内核不算耦合。
- **`extends` 了 `JoyousNewable`/`NeonaicNewable` 的类，构造函数必须 `super()` 且早于任何 `this` 访问**（漏掉构造即抛 ReferenceError）。已踩过：`codec.js` 的 `JoyousLineFrameCodec` ⇒ UDS 链路整体不可用。
- **Node 的 `net.connect({path})` 失败是异步 `emit('error')`、不抛**：只在同步 catch 里上报会让「对端没启动」这类最常见失败完全静默。事件文档承诺的 `error` 必须在 socket `error` 回调里 `emit`。已踩过（uds.js）。
- **⚠️ NeonaicConfig 默认 AUTOSAVE**：任何 `put*`/`set`/`remove` **立即落盘**。测试脚本**绝不要指向真实配置文件**。macOS 大小写不敏感，`import './AI.js'` 这类错误本地不报、**Linux 上必炸**。
- Git 按全局**权责边界**执行（见 `~/.workbuddy/MEMORY.md`）：身份 `Neonai <neonai+coding@kdxiaoyi.top>`（仅 `git -c` 携带）；Conventional Commits 中英双语；**必须主动提交自己所做的修改**，只 add 本次任务产出的文件（含 `.workbuddy/memory/`）；**不得提交无关代码，不得 push/pull/fetch/rebase/merge**。

## 沙箱自检 / 编辑器 / 拓展陷阱
- 零污染配方详见技能 `side-effect-test-isolation`、`js-selfcheck-script-mechanics`、`cross-process-bridge-design`。要点：`rsync` 真实仓库到沙箱（**`src/` 必须复制、不能软链**，否则 `ROOT_PATH` 自算指回真实根）+ 软链 `node_modules`；**改完源码必须重新 rsync**；**每份套件自管配置**；沙箱内改权限用 `setPermission`/`clearPermission` API（写文件对已加载内存态无效）；JSON5 打补丁要锚定小节正则（**不能按「相邻两行」匹配**）；`import(x + '?bust=1')` 会造出**新模块实例**。驱动 `runall.sh` + `selfcheck.mjs` + `loadercheck.mjs` 在 `/tmp/joyous-sandbox/`。
- `jsconfig.json` 的 `include` 必须写 `src/**/*.js`（`src/**.js` 匹配 0 个文件，会让自动 import / 跨文件补全全失效）；`extensions/**/*.js` 也要显式加；需 `module/moduleResolution: NodeNext` + `importModuleSpecifierEnding: "js"`。
- **Wordle**（`wd`）：难度别名 `n`/`hard`/`uh`（**刻意不收单字母 `h`**）。**字母判定按份数结算** ⇒ `missing` **不等于**「答案里没有该字母」。猜中那行内部存 `'right'` **字符串**。参数解析要 `sub = args[0]` 与 `param = args.join('')` 分开判（否则 `/wd new hard` → `newhard`）。
- **24 点**（`24`/`tf`/`tfp`，id `twentyfourpoints`）：4 数取自 1–13，**允许重复、不保证有解**（约 25% 无解），**每局一次机会**（**只有 `invalid` 不消耗**）；`/24 solve` 永远列全。

## 已知待办
- **`commandServer.js` 的 `executeCommand`/`executeCommandSilent` 只拦同步异常**：`async` 处理器抛出的异常以 Promise 拒绝逸出、不会被包成 `NeonaicCommandError`（产生未处理拒绝）。joyous 的 `dispatch.classify` 兜住了这一类，**内核侧应单独修**。影响全项目所有 async 命令。
- `extLoader.js`：`disable()` 无空守卫；`replaceAll('.', '\.')` 是空操作，且键名用 `.enabled` 而 `ext.json` 样例写的是 `enable`。
- `ai.js` 的 `neonaic:webfetch` 是半成品（`uri = new URL(address)` 赋给未声明变量，严格模式必抛，被 catch 吞掉）。`entry.js` 的 `checkPermissionFromContext(this)` 只传 1 个参数，`systemLine` 永远为空。`NeonaicUriMeta.js:184` 的 `{@link resolveUri}` 悬空。
- ✅ 已修：joyous `dispatch.js` 调不存在的 `checkCommandPerms`；`codec.js` 漏 `super()`；`JoyousUdsLink` 缺 `notify()`；`uds.js` 异步连接失败不发 `error`；`config.js` 的 `bridge.ai.AIlist` 缺省误报 issue。
