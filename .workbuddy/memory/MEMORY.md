# Neonai-Connector 项目长期记忆

## 概览

- **Neonai-Connector** — Node.js (ESM) 服务端，与「澪奈 (Neonai)」沟通的桥梁；显示名取 `config/main.json` 的 `name`/`subname`。仓库 `git@github.com:StreackMC/Neonai.git`。
- License **AGPL-3.0 + 附加条款**（禁止复用美术资源、禁止把 "Neonai"/「澪奈」当自身品牌）。

## 架构

- 三层 + 组合根 + 依赖注入。`src/system/`（entry 组合根、confManager、cliProcessor、pidManager）｜`src/logger/`｜`src/command/`（commandServer、permissionServer、commandInterface）｜`src/message/`（ai、messageIn）｜`src/platform/`（platformInterface 基类、platformManager）｜`src/extension/`（extLoader、extManager）｜`src/utils/`（NeonaicConfig、NeonaicNewableClass、NeonaicNewableError、NeonaicUriMeta、io、chore、math）；拓展在 `extensions/`。
- `main.js` 瘦入口（仅 `neonaicEntry.bootstrap()` + 兜底错误）；`debug.cjs` 调试入口，非 TTY 下用 `$("cmd")` 模拟 CLI。
- 错误统一抛 `NeonaicNewableError.js` 的 `Neonaic*Error`（IllegalState/IllegalArgument/IO ↔ Java 同名），不抛裸 `Error`。

## 模块导出约定（强制）

- 函数/常量**只导出单个命名空间对象**（`export const neonaicXxx = {...}`）；**类一律 `export class`，不嵌套**；命名统一 camelCase（含 extensions 侧）。
- **顶层具名导出的例外**（高频调用点语法糖）：`chore.js` 的 `parseString`（`text.js` 已并入 `chore.js`，另导出 `neonaicChore`）、`Logger.js` 的 `getLogger()`；`log4js_inject.js` 的 `configure` 是 appender 硬性要求。
- 对象字面量放文件**末尾**（`class` 不提升，提前引用 TDZ）；JSDoc 类型引用写 `import('./x.js').类名`（相对当前文件）。只有类的模块没有对象导出（`platformInterface.js`、`NeonaicUriMeta.js`）。

## NeonaicConfig（SConfig.java 的 JS 移植）

- 已实现：`WRITE_MODES` 五种（**默认 AUTOSAVE**）、自动重载 + `onAutoReloaded`/`onLoadFailure`、`reload`/`getRawData`/`getFile`、`isExist`/`isReachable`/`remove`、全套类型化 getter/putter（含 `Date` 版 LocalDate/LocalTime/LocalDateTime）、`getListOfString`/`getSection`（浅拷贝）/`putSection`、链式、原子写入、`_root_array` 根数组、`\.` 转义点号、静态工厂 `fromObject`/`fromJSON5`。
- 有意不做：多格式（只 JSON5）、注释、RootName、BigDecimal。与 Java 差异：无锁、`getBoolean` 是超集、保存后同步自身 mtime、`getFile(true)` 写入当前内容。

## CLI 命令系统

- `neonaicCommandServer.registerCommand(namespace, name, handler, opts)`；各模块 import 时自注册，handler 的 `this` 是 `NeonaicCommandContext`（`handler.call(ctx, ...args)` 展开）。opts：`alias`/`permissions`（第一层 AND、第二层 OR，`!perm` 须缺失）/`description`/`usage`；引用支持 `name`/`alias`/`ns:name`/`ns:alias`。`registerCommand` 把 `permissions` 归一为数组（缺省 `[]`）。
- 内置命令见 `neonaic:help`；拓展注册 `joyous:mc`、`qqbot:qbsend`、`wordle:wordle`(wd)、`twentyfourpoints:24`(tf/tfp/twentyfour)。原则：声明式、子模块互不引用、惰性单例、优雅关闭（5s 超时）。

## 权限系统（`src/command/permissionServer.js`）

- 4 层存储：临时 > 永久（按用户）> 全局临时 > 全局永久；执行者链 `["USR#x","GRP#y"]` 从左到右继承，末尾隐式 `*`。持久化 `config/saves/permissions.json`，用 `JSON.stringify` 写、`JSON5.parse` 读。
- **权限表达式（2026-10-10 重构后）**：叶子=字符串（可带 `!` 前缀＝须缺失）；数组=分组，语义**按嵌套深度交替**：第 0 层 AND → 第 1 层 OR → 第 2 层 AND → …（`_evaluate` 递归，`depth % 2 === 0` 即 AND）。故 `[[[a,b],c]]` = (a AND b) OR c、`[[a,b],c]` = (a OR b) AND c、`[a,['b','c']]` = a AND (b OR c)。空数组取单位元（AND 层 true / OR 层 false），最外层 `[]` = 无要求恒 true；`[[]]` = false。
- **不再有 null 三态**：`checkPermission(user, permission, fallback = false)`、`checkSinglePermission(user, permission, fallback = false)`、`checkPermissionFromContext(ctx, permission, fallback = false)` **恒返回布尔**。叶子未显式设置（整条链 + `*` 兜底都没记录）时取 `fallback`，**之后**才施加 `!` 取反 ⇒ `'!a'` 在 a 未设置且 fallback=false 时通过。内部用 `UNSET` Symbol 哨兵（`_lookup` / `_lookupSingle`，不导出）。`undefined` / `''` / `'*'` 恒 false。
  - 过期临时项表现为**回落到下层**（就地 `delete` 后继续，且该分支不 `_save()`，磁盘旧条目留到下次写入才清），最终可能落到 fallback。
- 命令注册：`registerCommand(ns, name, handler, { permissions, permissionDefault })`；`permissionDefault` 默认 false（＝未设置即不具备）。`meta.permissions` 恒为数组（falsy → `[]`、字符串 → `['s']`）。`commandServer` 三处检查与 `messageIn.js` 均透传 `meta.permissionDefault`。
- `src/message/ai.js` 的 `isAIBanned` 用 `checkPermission(caller, 'neonaic.toolcall.ai', true) === false`（未设置=允许、显式 false=封禁）；该权限语义是「**允许** AI 工具调用」。
- 命令执行侧极性（HEAD 已修）：`commandServer.executeCommandSilent` 用 `if (!passed) throw 权限不足`；`messageIn.js` 用 `checkPermissionFromContext(...) === false` 判拒。
- ⚠️ **遗留**：`extensions/joyous/src/protocol/dispatch.js:225` 调 `neonaicCommandServer.checkCommandPerms(meta.name, meta.permissions, BRIDGE_EXECUTOR)` —— **该函数不存在**（重构前的旧名，未导出）；凡 joyous 派发到「声明了权限的命令」必抛 TypeError（空权限命令走另一支，故未暴露）。应换成 `checkPermissionFromContext` 语义。
- ⚠️ `commandServer.js:117` 写 `permissions: perms` **不复制数组**（对比 116 行 `[...aliases]`），内层 OR 数组同样被别名，外部改原数组即可改已注册命令的权限；`Object.freeze(cmd)` 是**浅冻结**，`meta.permissions.push(...)` 仍成功、`Object.isFrozen(meta.permissions)` 为 false。修法：做一层 `[...p]` 拷贝。

## 扩展系统

- 加载器 `extLoader.js`（`NeonaicExtItem`+`neonaicExtensionLoader`）、管理器 `extManager.js`（`neonaicExtensionManager`）；已接入 `entry.js`：`loadAll([...(await scan()).keys()])`，失败项逐条 error 输出。
- API：`scan(root)`/`list`/`find`/`load`/`unload`/`loadAll`/`unloadAll`/`enable`/`disable`/`enableAll`/`disableAll` + getter `root`/`size`/`ids`；子命令同名，另有 `info <ext>`，省略拓展名即对全部操作。
- **返回结构以文件里的 `@typedef` 为准**（用户写的，改实现前先读）：payload = `{ operation, status, error, id }`，`operation` ∈ `load|unload|enabled|disabled`（enable/disable 用**过去分词**），`status` ∈ `notfound|successfully|failed|disabled`（`disabled` 只在 `operation='load'`）；批量 = `{ operation, succeed, notfound, disabled, failed }`，**没有 `affected`**。
- **两套语义正交**：`load`/`unload` 只管运行期（`unload` 标 `@deprecated`）；`enable`/`disable` 只管 `ext.json` 开关、**默认不改运行状态**。
- **布局**：`extensions/<name>/src/*.js` + 同级 `manifest.json`（`entry` 写 `./src/entry.js`）；`meta.id` 须匹配 `^[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)*$`（**不能带连字符**，目录名可以）、`meta.version` 如 `[1,"0.1.0"]`、`particulars.{name,author,description,url,license}`、`depends`/`softdepends`。
- `NeonaicExtItem.enable()` 要求入口同时导出 `onEnable` 与 `onDisable`（都必须是函数）；开关存 `ext.json` 的 `<id>.enabled`（缺省 true）。拓展内导入内核用 `../../../src/...`；入口必须叫 `entry.js` 且在 `src/` 下。
- **会话式拓展的模板**：私有 `Map` + 超时清理器 + 魔术 token 构造器（见 wordle/24 点），新拓展照抄。

## 拓展要点

- **Wordle**（`extensions/wordle/`，命令 `wordle:wordle` / `wd`）：难度 `normal|hard|uhard`（别名 `n`/`hard`/`uh|ultrahard`，**刻意不收单字母 `h`**，与「查看历史」冲突）。困难 = 绿位不可动 + 黄字母必须继续用；极限再要求黄字母换位 + 白字母不得再现。
  - **字母判定按份数结算**（两趟：先认领绿格份额，再按剩余份额判黄，用尽才判白）。因此 `missing` **不等于**「答案里没有该字母」，`#constraints().white` **必须剔掉已在绿/黄出现过的字母**，否则极限模式会误封正确字母致无解。
  - 猜中那行在 `#triesResult` 里存 `'right'` **字符串**而非数组，推导与渲染都要展开成全绿。
  - 参数解析：`sub = args[0]` 判子命令、`param = args.join('')` 判猜测；**不要只看 join 后的整串**，否则 `/wd new hard` 拼成 `newhard`、`new` 分支永不触发。
- **24 点**（`extensions/twenty-four-points/`，命令 `24`，别名 `tf`/`tfp`/`twentyfour`）：id `twentyfourpoints`（目录名可带连字符，id 不行）。4 个数取自 1–13，**允许重复、不保证有解**（约 25% 无解），**每局只有一次机会**；子命令 `help`/`new|restart|deal`/`<算式>`/`?|无解|insoluble`/`stop|放弃`/`solve 1 2 3 4`。**只有 `invalid` 不消耗机会**（数字没用对、语法错误、除数为零、用了幂/根号/模）。`MAX_LISTED_IN_GAME`（默认 `Infinity`）控制结算时列出的条数；`/24 solve` 永远列全。
- **Joyous**（`extensions/joyous/`）— 与 Java 插件 [StreackMC/Joyous](https://github.com/StreackMC/Joyous) 协作的 HTTP / UDS 双通道桥接。**协议以 `extensions/joyous/PROTOCOL.md` 为准**，常量以 `src/protocol/constants.js` 为准，两者必须同步。
  - 分层：`src/entry.js` 组合根｜`src/config.js`｜`src/status.js`（只依赖注入的 `query(address)`）｜`src/protocol/`（`constants`/`codec`/`session`/`http`/`uds`/`dispatch`）｜`config.json`。**`protocol/` 下导入内核是 4 层** `../../../../src/...`。
  - 两种模式：HTTP = 同时当客户端（GET StatusAPI）与服务端（POST 命令端点）；UDS = **被动端**，主动 `connect` 对端建立的路径，握手后 JSON + `\n` 收发。`status.transport` = `auto`(UDS 就绪优先，失败回退 HTTP)/`http`/`uds`；**默认两个通道都关**。
  - `session.js` 传输无关（只管握手状态机、id 关联、心跳），与传输的接口只有 `write(text)` / `teardown(why)`；跨平台靠纯函数 `resolveUdsEndpoint(path, pipe, platform)`（Windows 从 basename 去 `.sock` 推导 `\\.\pipe\<name>`）。**`dispatch.js` 是唯一接缝**：认识命令系统但不认识传输。
  - UDS 必须自己做心跳 + 退避重连（半开连接不会自己报错）；退避**只在握手成功时清零**（防「连上就被踢」变重连风暴）；作为连接方**绝不删对端套接字文件**，只在 `ECONNREFUSED` 时提示陈留套接字。
  - **`$joyous` 三层白名单**（复用既有权限系统）：① 总闸 `joyous.bridge.execute`（默认不授予）② 命令自身 `permissions` ③ 空权限命令要额外持有 `joyous.command.<ns>:<name>`。授权 `/neonaic:permission set $joyous <perm> true`；查看 `/joyous:bridge`。`BRIDGE_EXECUTOR = '$joyous'` 定义在拓展内 `src/protocol/dispatch.js`，不在内核枚举里；它是**权限键的一部分**，改名会让既有授权失效。
  - 命令 `joyous:mc`（任何人可用）、`joyous:bridge`（管理员）；AI 工具 `joyous:worldMeta`、`joyous:serverStatus`。

## neonaicMath（`src/utils/math.js`）

- `calc(expr, options)` — 递归下降求值，**参数不能叫 `eval`**（ESM 恒严格模式 → SyntaxError）。优先级：加减 → 乘除模 → 一元正负 → 幂（右结合，`-2^2`=-4、`2^-3` 合法）→ 根号 → 括号/数字；`/` 与 `÷` 等价，乘号还收 `×`/`·`，全角符号与数字自动折算，`**` ≡ `^`。
- `options` 三项**默认全 false**（只解析四则），需显式开：`power`、`root`、`mod`。**紧跟根号的整数（含上标）一律当次数**，故 `2√9` = 3 而非 `2*√9`。语法错误抛 `NeonaicIllegalArgumentError`（带位置），除数为零 / 负数开偶次方抛 `NeonaicArithmeticError`。
- `solve24(numbers, target=24)` — DFS 二叉树穷举，Set 按算式文本去重（`+`/`*` 先按字典序排序子算式以消交换律重复）。**已用文献值校准**：1–13 的 1820 种牌型 1362 有解 / 458 无解（25.16%）。内部 `clamp(toNumber(n), 1, MAX_SAFE_INTEGER)`，**0 与负数被静默改成 1**，调用方要先自校验。
- `random` 用 `min + Math.floor(Math.random() * (max - min + 1))`：原 `Math.round` 写法让 **min/max 各只有一半概率**。

## AI 调用链与 Profile 选择

- 链路：`平台事件 → 平台拓展（如 qqbot 的 msgHandler）→ neonaicMessageIn.resolveReply(msg, {AI, AIlist, resolveCommandWith}) → neonaicAI.askAI(msg, {AIlist, caller, overridePrompt, overrideAITool, speaker}) → callProvider`。
- **AI Profile = `secret.json` 的 `oai[]` 条目**：`{ name, available, address, token, model, responseAPI, stream, tools, maxToolcall, prompt }`；`prompt` 指向 `config/prompts/<file>.md`（决定人格）。`tools` 支持 `"*"` / `"!tool"` / 白名单；`maxToolcall` 是工具调用最大轮次（下限钳 1）。
- **`AIlist` 只过滤、不决定顺序**：`askAI` 里是 `getList('oai').filter(...)`，filter 保持源顺序 ⇒ **实际尝试顺序恒等于 `oai` 声明顺序**。故 `use:["A","B"]` **不能**表达「A 优先、失败退到 B」；要改优先级只能动 `oai` 顺序（全局生效）或改 `askAI` 让 AIlist 定序。
- **模式列表语法（`tools` 与 `AIlist` 共用 `resolvePatternList`）**：`"*"` 全选 / `"!name"` 排除（**排除优先于纳入**）/ `"!*"` 全排除；`"!name"` 亦支持 tools 的模糊匹配。**两处严格度不同**：`AIlist` **严格**（只写排除项 → 抛错「没有任何纳入项」，并点出未匹配的模式），`tools` **宽松**（`["!x"]` = 一个都不给，历史行为）。
- `available: false` 是**独立闸门**，不受 `!` 排除语义影响。内核已内置两层可用性（`available === false` 跳过 + 列表内逐个 try、失败自动换下一个）⇒ **「换 Profile 兜底」不需要业务层再写探测**。`resolveReply` 的 `AI` 开关决定「用不用 AI」，`AIlist` 只决定「用谁」，两者正交。
- **`PlatformManager` 构造 profile 是 `{ ...raw, _debug }`（`platformManager.js:63`）** ⇒ 平台 Profile 可携带任意自定义键并原样透传，平台级配置**不需要改内核就能加**（qqbot 的 `aiRouting` 走这条）。⚠️ 但 `_writeProfileEnabled` 用 `JSON5.stringify` 整体重写 `secret.json`，会**丢掉手写注释**。
- **qqbot 的 AI 路由**：`extensions/qqbot/src/aiRoute.js` 的 `pickAIList(routing, fallback, ctx)`，规则来自 `platforms[].aiRouting`（默认 `[]` ⇒ 行为不变）。维度 `scene`/`group`/`user`/`permission`/`match`，when 字段间 AND、字段内 OR，首条命中即用；`use:"*"` = 沿用 `allowedAI`（路由只能收窄）。`when.permission` 用 `checkPermission(ctx.executor, perm)` 逐条判定（**字符串形式，`!` 前缀无效**）。
- **用户名录 + 身份投递**（让模型知道「谁在说话」，而非收到 `USR#<openid>`）：
  - `src/message/userDirectory.js` 的 `neonaicUserDirectory`：`code → { name, pronoun?, note? }`，存 `config/saves/identities.json`。`pronoun` 是**自由文本**，不是枚举。
  - **落点判据**：名录是通用概念（内核只认识「字符串 → 可读描述」）⇒ 放内核；「某平台怎么拿到名字」是平台特定 ⇒ 放拓展。
  - 投递方式：`askAI` 注册**临时 AI 工具** `neonaic:speaker`（走 `overrideAITool`），模型按需调用，**不注入提示词**。`speaker`：不传=按 `caller` 查名录 / 字符串=直接采用 / 对象=`{name,pronoun,note}` / `null`=明确不投递。
  - 维护入口 `/neonaic:ai whois <list|get|set|unset|show>`；`set`/`unset` 要求私密上下文。qqbot 每条群消息用**免费的 `group_name`** 自动登记（`persist:false, overwrite:false`）。**QQ 群/C2C 消息拿不到发送者昵称**，只能人工登记。**未登记的 code 一律丢弃**，绝不把原始代号透给模型。
- **`askAI` 的 tools 合并坑（已修）**：原写法在 `provider.tools` 解析为空时整个 `tools` 键被省略、**overrideAITool 被静默丢弃**；必须**先合并再判空**。

## 配置文件

- `config/main.json` — 名称/次名、`prefix`、`maxLogFileSize`、`detailedLog`（JSONC）；`config/saves/{permissions,ext}.json` 运行时写入；`config/prompts/<profile>.md` 各 AI Profile 提示词（**gitignore**）。
- **⚠️ `config/saves` 整个目录是 gitignore 的（`.gitignore:159`）**，但 `ext.json` / `permissions.json` 因**在该规则加入前就已被跟踪**，仍留在版本控制里；**新增文件（如 `identities.json`）不会入库**。
- `config/secret.json` — 模板（假 key，**入库**）；根目录 `secret.json` — 真凭据（**gitignore**）。
- 拓展自带配置放 `extensions/<name>/config.json`，由 `neonaicConfManager.getConfig()` 读取（路径相对项目根）；该实例**不会**自动重载，改完要 `/neonaic:reload`。

## 沙箱自检配方（改动内核或拓展后必用）

- `rsync -a --exclude node_modules --exclude .git --exclude logs --exclude secret.json --exclude .workbuddy ./ $SB/` → `ln -s <real>/node_modules $SB/node_modules` → 覆写 `$SB/config/saves/permissions.json` → 在沙箱内运行脚本。
- **`src/` 必须复制、绝不能软链**：Node 默认解析真实路径，软链会让 `ROOT_PATH` 自算指回真实根，从而读写真实配置。
- **改完源码必须重新 rsync**（否则跑的是旧副本，会得出错误结论）；用 JSON5 配置打补丁**不能按「相邻两行」匹配**（中间有注释行），要锚定小节的正则；`import(x + '?bust=1')` 会造出**新模块实例**，命令处理器仍绑在旧实例闭包上，测不通。

## 编辑器 / 语言服务

- `jsconfig.json` 的 `include` 必须写 `src/**/*.js`。**`src/**.js` 与 `src/**` 匹配 0 个文件**（TS 的 `**` 必须自成路径段 `/**/`），会让项目只剩 `main.js`，所有自动 import / 跨文件补全失效；`extensions/**/*.js` 也要显式加进去。
- 需设 `module: NodeNext` + `moduleResolution: NodeNext`，并在 `.vscode/settings.json` 设 `importModuleSpecifierEnding: "js"`（否则自动 import 写出无后缀导入，Node ESM 直接 `ERR_MODULE_NOT_FOUND`）。

## 注意事项

- **⚠️ NeonaicConfig 默认 AUTOSAVE**：任何 `put*`/`set`/`remove` **立即落盘**。测试脚本**绝不要指向真实配置文件**，用临时副本或先 `setWriteMode('inertia')`。
- **内核不得出现任何拓展名**（解耦硬判据）：判断一处改动是否破坏「拓展 ↔ 本体解耦」，看它**会不会留下「本体只在某拓展存在时才有意义」的东西**。据此，拓展专属的**合成执行者身份**（如 `$joyous`）必须定义在拓展内，**不得写进内核 `COMMAND_ENUMS`**；`$` 前缀是内核保留的合成身份命名空间（内核自身只占 `$console`/`$unknown`），权限按执行者字符串存授权，**不需要枚举登记**。反例对照：`NeonaicProtocolError` 这类**通用错误词汇**进内核不算耦合。守卫：自检里断言 `src/` 全目录 grep 不到拓展名，且 `COMMAND_ENUMS.FROM_JOYOUS === undefined`。
- NeonaicConfig 写出的是 **JSON5**（键无引号、单引号字符串），读回要 `JSON5.parse`；嵌套路径**不能下探数组**（`a.0.b` 退化成顶层字面键），`isReachable` 可提前发现退化。
- macOS 大小写不敏感，`import './AI.js'` 这类大小写错误本地不报、**Linux 上必炸**。
- Git 按用户全局的**权责边界**执行（见 `~/.workbuddy/MEMORY.md`）：身份 `Neonai <neonai+coding@kdxiaoyi.top>`，仅 `git -c` 携带、不写 config；Conventional Commits 中英双语；**必须主动提交自己所做的修改**，只 add 本次任务产出的文件（含 `.workbuddy/memory/`），**不得提交与任务无关的代码，不得 push/pull/fetch/rebase/merge**。

## 已知待办

- **`commandServer.js` 的 `executeCommand`/`executeCommandSilent` 只拦同步异常**：命令处理器若是 `async`，抛出的异常以 Promise 拒绝逸出，不会被包成 `NeonaicCommandError`（会产生未处理拒绝）。当前 joyous 的 `dispatch.classify` 兜住了这一类，但**内核侧应单独修**（把返回值 `Promise.resolve().then` 包一层）。全项目 async 处理器很多，影响面广。
- `extLoader.js` 两处：`disable()` 无空守卫（`#instance` 为 null 时 `unload` 必抛）；`replaceAll('.', '\.')` 里 `'\.'` 就是 `'.'`，转义是空操作，且键名用 `.enabled` 而 `ext.json` 样例写的是 `enable`。
- ~~`permissionServer.checkPermission` 字符串分支不吃 `!` 前缀~~ **已于 2026-10-10 重构解决**（统一走 `_evaluateLeaf`，且 `fallback` 取代 null 三态）。
- **`extensions/joyous/src/protocol/dispatch.js:225` 调用不存在的 `neonaicCommandServer.checkCommandPerms`**（见「权限系统」遗留）—— joyous 派发「声明了权限的命令」必抛 TypeError，需换成 `checkPermissionFromContext` 语义。
- `ai.js` 的 `neonaic:webfetch` 是半成品：`uri = new URL(address)` 赋给未声明变量（ESM 恒严格模式必抛，被 catch 吞掉）。
- `entry.js:112` 的 `checkPermissionFromContext(this)` 只传 1 个参数（签名 `(ctx, permission, fallback)`），`systemLine` 永远为空；`extensions/wordle`、`twenty-four-points`、`qqbot/aiRoute` 的检查点也都没传 fallback（当前默认 false 与旧行为一致，故无回归）。
- `NeonaicUriMeta.js:184` 的 `{@link resolveUri}` 悬空（函数已随 `platformUtils.js` 删除）。
- Joyous **Java 侧尚未实现 UDS**：全仓库无 `ServerSocket`/`DomainSocket`/`SocketChannel` 代码。`PROTOCOL.md` §13 有 Java 侧实现清单。
