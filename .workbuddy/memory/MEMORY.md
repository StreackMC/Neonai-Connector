# Neonai-Connector 项目长期记忆

## 概览
- **Neonai-Connector** — Node.js (ESM) 服务端，与「澪奈 (Neonai)」沟通的桥梁；显示名取 `config/main.json` 的 `name`/`subname`。
- License **AGPL-3.0 + 附加条款**（禁止复用美术资源、禁止把 "Neonai"/「澪奈」当自身品牌）。

## 架构
- 组合根 + 依赖注入。`src/system/`（entry、confManager、cliProcessor、pidManager）｜`src/logger/`｜`src/command/`（commandServer、permissionServer、commandInterface）｜`src/message/`（ai、messageIn、userDirectory）｜`src/event/`（eventBus、eventInterface）｜`src/platform/`（platformInterface 基类、platformManager）｜`src/extension/`（extLoader、extManager）｜`src/utils/`（NeonaicConfig、NeonaicNewableClass、NeonaicNewableError、NeonaicUriMeta、io、chore、math）；拓展在 `extensions/`。
- `main.js` 瘦入口（仅 `neonaicEntry.bootstrap()` + 兜底错误）；`debug.cjs` 调试入口，非 TTY 下用 `$("cmd")` 模拟 CLI。
- 错误统一抛 `NeonaicNewableError.js` 的 `Neonaic*Error`（IllegalState/IllegalArgument/IO/Protocol/Network ↔ Java 同名），不抛裸 `Error`。

## 模块导出约定（强制）
- 函数/常量**只导出单个命名空间对象**（`export const neonaicXxx = {...}`）；**类一律 `export class`，不嵌套**；命名统一 camelCase（含 extensions 侧）。
- **顶层具名导出的例外**：`chore.js` 的 `parseString`、`Logger.js` 的 `getLogger()`、`log4js_inject.js` 的 `configure`（appender 硬性要求）。
- 对象字面量放文件**末尾**（`class` 不提升，提前引用 TDZ）；JSDoc 类型引用写 `import('./x.js').类名`（相对当前文件），**不要写悬空 `{@link}`**。只有类的模块没有对象导出。

## NeonaicConfig（SConfig.java 的 JS 移植）
- 已实现：`WRITE_MODES` 五种（**默认 AUTOSAVE**）、自动重载 + `onAutoReloaded`/`onLoadFailure`、`reload`/`getRawData`/`getFile`、`isExist`/`isReachable`/`remove`、全套类型化 getter/putter（含 `Date` 版）、`getListOfString`/`getSection`（浅拷贝，非对象时回退 `def`）/`putSection`、链式、原子写入、`_root_array`、`\.` 转义点号、静态工厂 `fromObject`/`fromJSON5`。
- 有意不做：多格式（只 JSON5）、注释、RootName、BigDecimal。与 Java 差异：无锁、`getBoolean` 是超集、保存后同步自身 mtime、`getFile(true)` 写入当前内容。
- ⚠️ **`confManager.getConfig(path)` 按原始字符串缓存**：`'./x.json'` 与 `'x.json'` 会拿到**两个不同实例**。测试/工具里改配置必须用与生产代码**逐字相同**的路径（如 `joyousConfig.CONFIG_PATH`），否则改了文件也不生效。
- ⚠️ 缓存的实例**不会**因文件被外部改写而自动重读：要显式 `inst.reload()`（`reload()` 会重新读盘）。

## CLI 命令系统
- `neonaicCommandServer.registerCommand(namespace, name, handler, opts)`；各模块 import 时自注册，handler 的 `this` 是 `NeonaicCommandContext`（`handler.call(ctx, ...args)` 展开）。opts：`alias`/`permissions`/`description`/`usage`/`permissionDefault`。引用支持 `name`/`alias`/`ns:name`/`ns:alias`。
- **命令输入解析全仓库只有一份：`resolveCommandArgs(input, prefixes?, trim = false)`**，一并负责 trim、识别并剥离前缀、POSIX 分词。省略 `prefixes` 时与旧 `parseArgs` 逐字一致（CLI / `entry.js` 的 `$()` / joyous 走这条）；`messageIn` 传 `(msg, prefixes, true)`。传了 `prefixes` 而**无一匹配**返回 `null`（＝「不是命令」，交给 AI 兜底）；其余情况恒为 `[命令名, 参数]`，空输入 `['', []]`；前缀取**列表首个匹配**者。
- 既有行为（非 bug）：**长度为 0 的 token 会被丢弃**（`cmd "" x` → `['cmd', ['x']]`）。
- 内置命令见 `neonaic:help`；拓展注册 `joyous:mc`/`joyous:bridge`、`qqbot:qbsend`、`wordle:wordle`(wd)、`twentyfourpoints:24`(tf/tfp/twentyfour)。

## 权限系统（`src/command/permissionServer.js`）
- 4 层存储：临时 > 永久（按用户）> 全局临时 > 全局永久；执行者链 `["USR#x","GRP#y"]` 从左到右继承，末尾隐式 `*`。持久化 `config/saves/permissions.json`（`JSON.stringify` 写、`JSON5.parse` 读）。
- **权限表达式**：叶子=字符串（可带 `!` ＝须缺失）；数组=分组，语义**按嵌套深度交替**：第 0 层 AND → 第 1 层 OR → 第 2 层 AND…（`[[[a,b],c]]` = (a AND b) OR c；`[a,['b','c']]` = a AND (b OR c)）。空数组取单位元；最外层 `[]` 恒 true、`[[]]` = false。
- **无 null 三态**：`checkPermission` / `checkSinglePermission` / `checkPermissionFromContext` 均 `(…, fallback = false)` **恒返回布尔**。叶子未显式设置时取 `fallback`，**之后**才施加 `!`。`undefined`/`''`/`'*'` 恒 false。过期临时项表现为**回落到下层**（就地 delete，且不 `_save()`）。
- 命令注册是 `{ permissions, permissionDefault }`；`permissionDefault` 默认 false。`meta.permissions` 恒为数组。`commandServer` 与 `messageIn.js` 均透传 `meta.permissionDefault`；`checkPermissionFromContext` 在 `ctx.internalCall` 时**直接放行**。
- `isAIBanned` 用 `getSinglePermissionStatus(user, 'neonaic.toolcall.ai')`，只有**显式 false** 才算封禁（语义是「允许 AI 工具调用」）。
- ⚠️ `commandServer.js` 写 `permissions: perms` **不复制数组**（对比 `[...aliases]`），外部改原数组即可改已注册命令的权限；`Object.freeze(cmd)` 是浅冻结。

## 扩展系统
- 加载器 `extLoader.js`（`NeonaicExtItem`）、管理器 `extManager.js`（`neonaicExtensionManager`）；已接入 `entry.js`。API：`scan`/`list`/`get`/`load`/`unload`/`loadAll`/`unloadAll`/`enable`/`disable`/`enableAll`/`disableAll` + getter `root`/`size`/`ids`。
- `scan()` 返回 `Map<id, NeonaicExtItem>`；item 的公开访问器只有 `export`/`manifest`/`name`/`id`/`fullname`/`enabled`（字段全私有，`JSON.stringify` 得 `{}`）。
- **返回结构以文件里的 `@typedef` 为准**：payload = `{ operation, status, error, id }`，`operation` ∈ `load|unload|enabled|disabled`（enable/disable 用过去分词），`status` ∈ `notfound|successfully|failed|disabled`；批量 = `{ operation, succeed, notfound, disabled, failed }`，**没有 `affected`**。
- **两套语义正交**：`load`/`unload` 只管运行期（`unload` 标 `@deprecated`）；`enable`/`disable` 只管 `ext.json` 开关、默认不改运行状态。
- **布局**：`extensions/<name>/src/*.js` + 同级 `manifest.json`（`entry` 写 `./src/entry.js`）；`meta.id` 须匹配 `^[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)*$`（**不能带连字符**，目录名可以）、`meta.version` 如 `[1,"0.1.0"]`。拓展内导入内核用 `../../../src/...`。
- `NeonaicExtItem.enable()` 要求入口同时导出 `onEnable` 与 `onDisable`；开关存 `ext.json` 的 `<id>.enabled`（缺省 true）。
- **会话式拓展的模板**：私有 `Map` + 超时清理器 + 魔术 token 构造器（见 wordle/24 点）。

## 拓展要点
- **Wordle**（`extensions/wordle/`，命令 `wordle:wordle` / `wd`）：难度 `normal|hard|uhard`（别名 `n`/`hard`/`uh|ultrahard`，**刻意不收单字母 `h`**）。困难 = 绿位不可动 + 黄字母必须继续用；极限再要求黄字母换位 + 白字母不得再现。
  - **字母判定按份数结算**（两趟：先认领绿格份额，再按剩余份额判黄，用尽才判白）⇒ `missing` **不等于**「答案里没有该字母」，`#constraints().white` **必须剔掉已在绿/黄出现过的字母**。
  - 猜中那行在 `#triesResult` 里存 `'right'` **字符串**而非数组，推导与渲染都要展开成全绿。
  - 参数解析：`sub = args[0]` 判子命令、`param = args.join('')` 判猜测；**不要只看 join 后的整串**（否则 `/wd new hard` 拼成 `newhard`）。
- **24 点**（`extensions/twenty-four-points/`，命令 `24`，别名 `tf`/`tfp`/`twentyfour`）：id `twentyfourpoints`。4 个数取自 1–13，**允许重复、不保证有解**（约 25% 无解），**每局只有一次机会**；**只有 `invalid` 不消耗机会**。`MAX_LISTED_IN_GAME`（默认 `Infinity`）控制结算时列出的条数；`/24 solve` 永远列全。
- **Joyous**（`extensions/joyous/`）— 与 Java 插件 [StreackMC/Joyous](https://github.com/StreackMC/Joyous) 协作的双通道桥接。**协议 V1 见 `PROTOCOL.md`（§16 是 V2 落地说明），V2 增量以 `PROTOCOL-V2.md` 为唯一约定来源**；常量以 `src/protocol/constants.js` 为准，对端以 `Neonaic/bridge/BridgeProtocol.java` 为准，两者必须一致（自检会解析该 Java 文件逐项比对）。
  - 分层：`src/entry.js` 组合根｜`config.js`｜`identity.js`（MC↔聊天绑定表，`config/saves/joyous-identities.json`）｜`status.js`（只依赖注入的 `query(address)`）｜`src/protocol/`（`constants`/`codec`/`session`/`http`/`uds`/`dispatch`/`methods`）。**`protocol/` 下导入内核是 4 层** `../../../../src/...`。
  - 两个接缝：`dispatch.js` 认识命令系统、`methods.js` 认识平台/AI/身份，**都不认识具体传输**；http.js/uds.js 只认「handler + {method,payload}」。
  - 两种模式：HTTP = 同时当客户端（GET StatusAPI、POST 对端通用端点）与服务端（`/neonai/command` + `/neonai/invoke`）；UDS = **被动端**，主动 `connect` 对端建立的路径（**Joyous 是监听方且 accept 后先发 hello** ⇒ 本端 `handshake` 必须是 `responder`）。`status.transport` / `bridge.transport` = `auto`(UDS 就绪优先，失败回退 HTTP)/`http`/`uds`；**两个通道默认都关**。
  - V2 方法：`chat.publish`（MC→聊天，投递到 `bridge.profiles[profile].channels` 白名单内的频道）、`ai.request`（Joyous 已做触发判定，本端只管「拿上下文→出文本」，`maxOutputChars` 截断）、`identity.bind`/`identity.resolve`（`code` 空＝不校验，不匹配回 `not_bound`）、出站 `chat.broadcast`（订阅内核 `neonaic:message`，按**执行者链 × 配置频道白名单**匹配后内播；`user.id` 带原始代号、`user.name` 只放名录里的可读名，取不到就留空）。
  - **业务授权与命令授权相互独立**：命令走 `joyous.bridge.execute` + 命令 `permissions` + 空权限命令的 `joyous.command.<ns>:<name>`；业务方法走 `bridge.allowedMethods`（配置白名单）+ `joyous.bridge.business`（总闸，默认不授予）+ `joyous.bridge.<method>`（可选，**显式 false 才拒绝**）。`BRIDGE_EXECUTOR = '$joyous'` 定义在拓展内，改名会让既有授权失效。
  - 命令 `joyous:mc`、`joyous:bridge`（管理员，展示端点/本端自述/两道闸/mapping/绑定数）；AI 工具 `worldMeta`、`serverStatus`。
  - ⚠️ 两侧 profile 命名可以不同：Joyous 的 `group-chat-sync.profile` 键（用户实际是 `streack-qq-bot`）与 Neonaic 平台 Profile 名（实际是 `streack-neonai-qqbot`）**不是一套命名**，由 `bridge.profiles.<键>.platform` 显式对应。
  - ⚠️ 对端 `Neonaic.yml` 的 `connect.timeout.request`（缺省 10 秒）是**对端等我方应答的上限**；AI 生成常超 10 秒，`ai.request` 要把它调到 60 秒以上。
  - ⚠️ 改 `extensions/joyous/config.json` 后要 `/neonaic:reload` **并重启拓展**，通道不热切换。

## neonaicMath（`src/utils/math.js`）
- `calc(expr, options)` — 递归下降求值，**参数不能叫 `eval`**（ESM 严格模式 → SyntaxError）。`options` 三项（`power`/`root`/`mod`）**默认全 false**；**紧跟根号的整数一律当次数**（`2√9` = 3）。除零 / 负数开偶次方抛 `NeonaicArithmeticError`。
- `solve24(numbers, target=24)` — DFS 穷举 + 文本去重（交换律已消重）。**文献值校准**：1–13 的 1820 种牌型 1362 有解 / 458 无解（25.16%）。内部 `clamp(…, 1, MAX_SAFE_INTEGER)`，**0 与负数被静默改成 1**。
- `random` 必须 `min + Math.floor(Math.random() * (max - min + 1))`（`Math.round` 写法会让 min/max 各只有一半概率）。

## AI 调用链与 Profile 选择
- 链路：`平台事件 → 平台拓展（qqbot/msgHandler）→ neonaicMessageIn.resolveReply(msg, {AI, AIlist, resolveCommandWith}) → neonaicAI.askAI(msg, {AIlist, caller, speaker, overridePrompt, overrideAITool}) → callProvider`。
- **AI Profile = `secret.json` 的 `oai[]`**：`{ name, available, address, token, model, responseAPI, stream, tools, maxToolcall, prompt }`；`prompt` 指向 `config/prompts/<file>.md`。
- **`AIlist` 只过滤、不决定顺序**：`askAI` 里是 `getList('oai').filter(...)`，filter 保持源顺序 ⇒ **尝试顺序恒等于 `oai` 声明顺序**。
- **模式列表语法（`tools` 与 `AIlist` 共用 `resolvePatternList`）**：`"*"` 全选 / `"!name"` 排除（排除优先）/ `"!*"` 全排除。**严格度不同**：`AIlist` **严格**（只写排除项 → 抛错），`tools` **宽松**（`["!x"]` = 一个都不给）。
- `available: false` 是**独立闸门**；内核已内置「跳过不可用 + 逐个 try 失败换下一个」⇒ 业务层不必再写探测。`resolveReply` 的 `AI` 开关与 `AIlist` 正交。
- **`PlatformManager` 构造 profile 是 `{ ...raw, _debug }`** ⇒ 平台 Profile 可携带任意自定义键并原样透传（qqbot 的 `aiRouting` 走这条）。⚠️ `_writeProfileEnabled` 用 `JSON5.stringify` 整体重写 `secret.json`，**会丢掉手写注释**。
- **qqbot 的 AI 路由**：`extensions/qqbot/src/aiRoute.js` 的 `pickAIList(routing, fallback, ctx)`，规则来自 `platforms[].aiRouting`（默认 `[]` ⇒ 行为不变）。维度 `scene`/`group`/`user`/`permission`/`match`，when 字段间 AND、字段内 OR，首条命中即用；`use:"*"` = 沿用 `allowedAI`（只能收窄）。
- **用户名录 + 身份投递**：`src/message/userDirectory.js` 的 `neonaicUserDirectory`，`code → { name, pronoun?, note? }`，存 `config/saves/identities.json`（`pronoun` 是自由文本）。**判据**：名录是通用概念 ⇒ 内核；「某平台怎么拿到名字」是平台特定 ⇒ 拓展。投递方式是 `askAI` 注册**临时 AI 工具** `neonaic:speaker`（走 `overrideAITool`），**不注入提示词**；`speaker` 不传=按 `caller` 查名录 / 字符串=直接采用 / 对象=`{name,pronoun,note}` / `null`=不投递。维护入口 `/neonaic:ai whois <list|get|set|unset|show>`（set/unset 要私密上下文）。qqbot 用免费的 `group_name` 自动登记（`persist:false, overwrite:false`）；**QQ 群/C2C 拿不到发送者昵称**，只能人工登记。**未登记的 code 一律丢弃**。
- **`askAI` 的 tools 合并坑（已修）**：`provider.tools` 解析为空时整个 `tools` 键曾被省略、**overrideAITool 被静默丢弃**；必须**先合并再判空**。

## 配置文件
- `config/main.json` — 名称/次名、`prefix`、`maxLogFileSize`、`detailedLog`、`ai.*`；`config/saves/*.json` 运行时写入；`config/prompts/<profile>.md` 提示词（**gitignore**）。
- **`config/saves` 整个目录 gitignore**（`.gitignore:159`），但 `ext.json` / `permissions.json` 因**该规则加入前已被跟踪**而仍在版本控制里；**新增文件（`identities.json`、`joyous-identities.json`）不会入库**。
- 根目录 `secret.json` — 真凭据（**gitignore**）；`config/secret.json` — 模板（假 key，入库）。
- 拓展自带配置放 `extensions/<name>/config.json`，由 `getConfig()` 读取（路径相对项目根）。

## 沙箱自检配方（改动内核或拓展后必用）
- `rsync -a --exclude node_modules --exclude .git --exclude logs --exclude secret.json --exclude .workbuddy ./ $SB/` → `ln -s <real>/node_modules $SB/node_modules` → 备好 `config/main.json`、`config/prompts/*.md`、`config/saves/permissions.json` → 在沙箱内跑脚本。驱动脚本 `runall.sh` + `selfcheck.mjs`（joyous V1+V2）+ `loadercheck.mjs` 在 `/tmp/joyous-sandbox/`。
- **`src/` 必须复制、绝不能软链**：Node 解析真实路径，软链会让 `ROOT_PATH` 自算指回真实根，从而读写真实配置。
- **改完源码必须重新 rsync**（否则跑的是旧副本，会得出错误结论）；JSON5 打补丁**不能按「相邻两行」匹配**（中间有注释行），要锚定小节的正则；`import(x + '?bust=1')` 会造出**新模块实例**（命令处理器仍绑旧实例闭包，测不通）。
- 沙箱内改权限：写文件对已加载的内存态**无效**，要用 `setPermission` / `clearPermission('$joyous','*')` API。
- 假对端测「出站」时：要在**收到的帧**里找（`socket.on('data')`），不是从假对端的写出口找。

## 编辑器 / 语言服务
- `jsconfig.json` 的 `include` 必须写 `src/**/*.js`（`src/**.js` 匹配 0 个文件，会让自动 import / 跨文件补全全失效）；`extensions/**/*.js` 也要显式加。
- 需 `module: NodeNext` + `moduleResolution: NodeNext`，并在 `.vscode/settings.json` 设 `importModuleSpecifierEnding: "js"`。

## 注意事项
- **⚠️ NeonaicConfig 默认 AUTOSAVE**：任何 `put*`/`set`/`remove` **立即落盘**。测试脚本**绝不要指向真实配置文件**。
- **内核不得出现任何拓展名**（解耦硬判据）：看一处改动**会不会留下「本体只在某拓展存在时才有意义」的东西**。拓展专属的合成执行者身份（`$joyous`）必须定义在拓展内，**不得写进内核 `COMMAND_ENUMS`**；`$` 前缀是内核保留的合成身份命名空间（内核只占 `$console`/`$unknown`），权限按执行者字符串存授权。反例：`NeonaicProtocolError` 这类**通用错误词汇**进内核不算耦合。守卫：自检断言 `src/` 全目录 grep 不到拓展名。
- **`extends` 了 `JoyousNewable`/`NeonaicNewable` 的类，构造函数必须 `super()` 且必须早于任何 `this` 访问**（漏掉会在构造时抛 ReferenceError）。已因这条踩过一次：`codec.js` 的 `JoyousLineFrameCodec` 漏 `super()` ⇒ UDS 链路整体不可用。
- NeonaicConfig 写出的是 **JSON5**（键无引号、单引号字符串），读回要 `JSON5.parse`；嵌套路径**不能下探数组**。
- macOS 大小写不敏感，`import './AI.js'` 这类大小写错误本地不报、**Linux 上必炸**。
- Git 按全局**权责边界**执行（见 `~/.workbuddy/MEMORY.md`）：身份 `Neonai <neonai+coding@kdxiaoyi.top>`，仅 `git -c` 携带；Conventional Commits 中英双语；**必须主动提交自己所做的修改**，只 add 本次任务产出的文件（含 `.workbuddy/memory/`）；**不得提交无关代码，不得 push/pull/fetch/rebase/merge**。

## 已知待办
- **`commandServer.js` 的 `executeCommand`/`executeCommandSilent` 只拦同步异常**：`async` 处理器抛出的异常以 Promise 拒绝逸出、不会被包成 `NeonaicCommandError`（产生未处理拒绝）。joyous 的 `dispatch.classify` 兜住了这一类，**内核侧应单独修**（`Promise.resolve().then` 包一层）。影响面涵盖全项目所有 async 命令。
- `extLoader.js` 两处：`disable()` 无空守卫（`#instance` 为 null 时 `unload` 必抛）；`replaceAll('.', '\.')` 里 `'\.'` 就是 `'.'`，转义是空操作，且键名用 `.enabled` 而 `ext.json` 样例写的是 `enable`。
- `ai.js` 的 `neonaic:webfetch` 是半成品：`uri = new URL(address)` 赋给未声明变量（严格模式必抛，被 catch 吞掉）。
- `entry.js:112` 的 `checkPermissionFromContext(this)` 只传 1 个参数，`systemLine` 永远为空；wordle / 24 点 / qqbot aiRoute 的检查点也没传 fallback（默认 false 与旧行为一致，故无回归）。
- `NeonaicUriMeta.js:184` 的 `{@link resolveUri}` 悬空（函数已随 `platformUtils.js` 删除）。
- ✅ 已于 2026-10-11 修掉：joyous `dispatch.js` 调用不存在的 `checkCommandPerms`（改为 `checkPermissionFromContext` 语义）；`codec.js` 漏 `super()`；`JoyousUdsLink` 缺 `notify()`。
