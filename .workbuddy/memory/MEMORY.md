# Neonai-Connector 项目长期记忆

## 概览

- **Neonai-Connector** — Node.js (ESM) 服务端，与「澪奈 (Neonai)」沟通的桥梁；显示名取 `config/main.json` 的 `name`/`subname`。
- **License** AGPL-3.0 + 附加条款（禁止复用美术资源、禁止把 "Neonai"/"澪奈" 当自身品牌）；仓库 `git@github.com:StreackMC/Neonai.git`。

## 架构

三层 + 组合根 + 依赖注入。层与目录：`src/system/`（entry 组合根、confManager、cliProcessor、pidManager）、`src/logger/`、`src/command/`（commandServer、permissionServer、commandInterface）、`src/message/`（ai.js、messageIn.js）、`src/platform/`（platformInterface 基类、platformManager）、`src/extension/`（extLoader、extManager）、`src/utils/`（NeonaicConfig、NeonaicNewableClass、NeonaicNewableError、NeonaicUriMeta、io.js、chore.js、math.js）；拓展在 `extensions/`。

- `main.js` 瘦入口（仅 `neonaicEntry.bootstrap()` + 兜底错误）；`debug.cjs` 调试入口，非 TTY 下用 `$("cmd")` 模拟 CLI。
- 错误统一抛 `NeonaicNewableError.js` 的 `Neonaic*Error`（IllegalState/IllegalArgument/IO ↔ Java 同名），不抛裸 `Error`。

## 模块导出约定（强制）

- 函数/常量**只导出单个命名空间对象**（`export const neonaicXxx = { ... }`）；**类一律 `export class`，不嵌套**；命名统一 **camelCase**（迁移已完成，含 extensions 侧）。
- **顶层具名导出的例外**（高频调用点语法糖，不重复放进对象）：`chore.js` 的 `parseString`（**`text.js` 已并入 `chore.js`**，另导出 `neonaicChore`）、`Logger.js` 的 `getLogger()`；`log4js_inject.js` 的 `configure` 是 appender 硬性要求。
- 对象字面量放文件**末尾**（`class` 不提升，提前引用 TDZ）；JSDoc 类型引用写 `import('./x.js').类名`（路径相对当前文件）。
- 只有类的模块没有对象导出（`platformInterface.js`、`NeonaicUriMeta.js`）。

## NeonaicConfig（SConfig.java 的 JS 移植）

- 已实现：`WRITE_MODES` 五种（**默认 AUTOSAVE**）、自动重载 + `onAutoReloaded`/`onLoadFailure`、`reload`/`getRawData`/`getFile`、`isExist`/`isReachable`/`remove`、全套类型化 getter/putter（含 `Date` 版 LocalDate/LocalTime/LocalDateTime）、`getListOfString`/`getSection`（浅拷贝）/`putSection`、链式、原子写入、`_root_array` 根数组、`\.` 转义点号、静态工厂 `fromObject`/`fromJSON5`。
- 有意不做：多格式（只 JSON5）、注释、RootName、BigDecimal。与 Java 差异：无锁、`getBoolean` 是超集、保存后同步自身 mtime、`getFile(true)` 写入当前内容。

## CLI 命令系统

`neonaicCommandServer.registerCommand(namespace, name, handler, opts)`；各模块 import 时自注册，handler 的 `this` 是 `NeonaicCommandContext`（`handler.call(ctx, ...args)` 展开）。opts：`alias`/`permissions`（第一层 AND、第二层 OR，`!perm` 须缺失）/`description`/`usage`；引用支持 `name`/`alias`/`ns:name`/`ns:alias`。内置命令见 `neonaic:help`；拓展注册 `joyous:mc`、`qqbot:qbsend`、`wordle:wordle`(wd)、`twentyfourpoints:24`(tf/tfp/twentyfour)。原则：声明式、子模块互不引用、惰性单例、优雅关闭（5s 超时）。

## 扩展系统

- 加载器 `extLoader.js`（`NeonaicExtItem`+`neonaicExtensionLoader`）、管理器 `extManager.js`（`neonaicExtensionManager`）；**已接入 `entry.js`**：`loadAll([...(await scan()).keys()])`，失败项由 `entry.js` 逐条 error 输出。
- API：`scan(root)`/`list`/`find`/`load`/`unload`/`loadAll`/`unloadAll`/`enable`/`disable`/`enableAll`/`disableAll` + getter `root`/`size`/`ids`；子命令同名，另外多一个 `info <ext>`，省略拓展名即对全部操作。
- **返回结构以文件里的 `@typedef` 为准**（用户写的，改实现前先读）：payload = `{ operation, status, error, id }`，`operation` ∈ `load|unload|enabled|disabled`（enable/disable 用**过去分词**），`status` ∈ `notfound|successfully|failed|disabled`（`disabled` 只在 `operation='load'`）；批量 = `{ operation, succeed, notfound, disabled, failed }`，**没有 `affected`**。
- **两套语义正交**：`load`/`unload` 只管运行期（`unload` 标 `@deprecated`）；`enable`/`disable` 只管 `ext.json` 开关、**默认不改运行状态**（disable 后仍在跑是预期）。
- **布局**：`extensions/<name>/src/*.js` + 同级 `manifest.json`（`entry` 写 `./src/entry.js`）；`meta.id` 须匹配 `^[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)*$`（**不能带连字符**，目录名可以）、`meta.version` 如 `[1,"0.1.0"]`、`particulars.{name,author,description,url,license}`、`depends`/`softdepends`。
- `NeonaicExtItem.enable()` 要求入口同时导出 `onEnable` 与 `onDisable`（都必须是函数）；开关存 `ext.json` 的 `<id>.enabled`（缺省 true）。拓展内导入内核用 `../../../src/...`；入口必须叫 `entry.js` 且在 `src/` 下。

## 拓展：Wordle

- `entry.js`（命令层）、`session.js`（对局与难度）、`word_provider.js`（词表 + 全角字母表）；命令 `wordle:wordle`（`wd`/`wl`）。难度 `normal|hard|uhard`，别名 `n`/`hard`/`uh|ultrahard`，**刻意不收单字母 `h`**（与「查看历史」冲突）。
- 规则：困难 = 绿位不可动 + 黄字母必须继续用；极限 = 困难 + 黄字母必须换位 + 白字母不得再现。约束由 `#constraints()` 从历史推导，`checkDifficulty()` 是公开只读版；猜中那行在 `#triesResult` 里存的是 `'right'` **字符串**而非数组，推导与渲染都要展开成全绿。
- 参数解析：`sub = args[0]` 判子命令、`param = args.join('')` 判猜测。**不要只看 join 后的整串**，否则 `/wd new hard` 拼成 `newhard`、`new` 分支永不触发。无对局时 `hard`/`uhard` 按该难度开局、5 字母则普通开局并当第一次猜测。
- **字母判定按份数结算**（两趟：先认领绿格份额，再按剩余份额判黄，用尽才判白）。**因果必须记住**：修好后 `missing` 不再等于「答案里没有该字母」（`posse` 猜 `bokos`，第 4 个 `o` 是白但确实在答案里，份额被绿格用光），因此 `#constraints().white` **必须剔掉已在绿/黄中出现过的字母**，否则极限模式的「白字母不得再现」会误封正确字母、局面无解（实测 400 局中 56 局失败）。
- 用户已修：`usable` 守卫与**幂等** setter、`timeouts` 清理、`guess()` 长度判定、`onDisable` 清会话、`history` 注明不可改。会话那套（私有 Map + 超时清理器 + 魔术 token 构造器）**新拓展照抄即可**。

## neonaicMath（`src/utils/math.js`）

- `calc(expr, options)` — 递归下降算式求值，**参数不能叫 `eval`**（ESM 恒严格模式 → `SyntaxError`）。优先级：加减 → 乘除模 → 一元正负 → 幂（右结合，`-2^2`=-4、`2^-3` 合法）→ 根号 → 括号/数字；除号 `/` 与 `÷` 等价，乘号还收 `×`/`·`，全角符号与数字自动折算，`**` ≡ `^`。
- `options` 三项**默认全 false**（只解析四则），需显式开：`power`(`^`/`**`)、`root`(`√`/`∛`/`3√8`/`³√8`/`^3√8`)、`mod`(`%`)。**紧跟根号的整数（含上标）一律当次数**，故 `2√9` = 3 而非 `2*√9`；`2^3√8` 里 `^` 前有值，仍按幂解析。语法错误抛 `NeonaicIllegalArgumentError`（带位置），除数为零 / 负数开偶次方抛 `NeonaicArithmeticError`。
- `solve24(numbers, target=24)` — DFS 二叉树穷举（挑两个数合并后递归），Set 按算式文本去重：`+`/`*` 先把两个子算式按字典序排好再拼接（消交换律重复），`-`/`/` 两种顺序都留；返回已剥掉最外层多余括号。**正确性用文献值校准过**：1–13 的 1820 种牌型里 1362 有解 / 458 无解（25.16%），与公开结果完全一致。内部 `clamp(toNumber(n), 1, MAX_SAFE_INTEGER)`，**0 与负数被静默改成 1**，调用方要先自己校验。
- `random` 已由 `Math.round` 改为 `min + Math.floor(Math.random() * (max - min + 1))`：原写法让 **min/max 各只有一半概率**（wordle 选词首尾、24 点 A 与 K）。

## 拓展：24 点（`extensions/twenty-four-points/`）

- id `twentyfourpoints`（目录名带连字符但 id 不行），命令 `24`，别名 `tf`/`tfp`/`twentyfour`；**命令名含数字没问题**（`parseArgs` 按空格切、`inferNext` 用 `startsWith`）。文件：`src/entry.js` + `src/session.js` + `manifest.json`。
- 规则：4 个数取自 1–13（扑克 A–K），**允许重复、不保证有解**（约 25% 无解）；**每局只有一次机会**。子命令 `help` / `new|restart|deal` / `<算式>` / `?|无解|insoluble`（声明无解）/ `stop|放弃` / `solve 1 2 3 4`（求全部解，不开局）。
- **只有 `invalid` 不消耗机会**（数字没用对、语法错误、除数为零、用到幂/根号/模）；结算路径 `clearSession` + `#usable = false`。`joined = args.join('')` 使算式被空格拆开也能解析，但裸命令要单独判，否则走成「没有收到算式」。
- `MAX_LISTED_IN_GAME`（默认 `Infinity`）控制对局结束时列出的条数，`renderSolutions(solutions, limit)` 支持截断；`/24 solve` 永远列全。

## 拓展：Joyous（`extensions/joyous/`）——HTTP / UDS 双通道桥接

- 与 Java 插件 [StreackMC/Joyous](https://github.com/StreackMC/Joyous) 协作。**协议以 `extensions/joyous/PROTOCOL.md` 为准**，常量以 `src/protocol/constants.js` 为准，两者必须同步。
- **分层**：`src/entry.js` 组合根（读配置→装配→声明式注册命令/AI 工具→优雅关闭，幂等）｜`src/config.js` 配置读取与归一化｜`src/status.js` 状态业务（只依赖注入的 `query(address)`）｜`src/protocol/` 通信层平铺（`constants` / `codec` / `session` / `http` / `uds` / `dispatch`）｜`config.json` 拓展自带配置。
- **`protocol/` 下导入内核是 4 层** `../../../../src/...`（比 `src/*.js` 多一层）。
- **两种模式**：HTTP = Neonaic 同时当客户端（GET StatusAPI）与服务端（POST 命令端点）；UDS = **被动端**，主动 `connect` 对端建立的路径，握手后以 JSON + `\n` 收发。`status.transport` = `auto`(UDS 就绪优先，失败回退 HTTP) / `http` / `uds`。**默认两个通道都关**，行为与重构前一致。
- **`session.js` 是传输无关的**：只管握手状态机、id 关联、心跳；与传输的接口只有 `write(text)` / `teardown(why)` 两个回调。跨平台一致性靠「同一份代码 + 一个纯函数 `resolveUdsEndpoint(path, pipe, platform)`」保证（Windows 从 `path` 的 basename 去 `.sock` 推导 `\\.\pipe\<name>`）。
- **`dispatch.js` 是唯一接缝**：认识命令系统但不认识传输。http/uds 都只调 `joyousDispatcher.execute()`。
- **UDS 必须自己做心跳 + 退避重连**：半开连接不会自己报错；退避**只在握手成功时清零**（防「连上就被踢」变成重连风暴）。作为连接方**绝不删对端的套接字文件**，只在 `ECONNREFUSED` 时提示陈留套接字。
- **`$joyous` 三层白名单**（复用既有权限系统，无新机制）：① 总闸 `joyous.bridge.execute`（默认不授予）② 命令自身 `permissions` ③ 空权限命令要额外持有 `joyous.command.<ns>:<name>`。授权：`/neonaic:permission set $joyous <perm> true`；查看：`/joyous:bridge`。
  - 身份常量 **`BRIDGE_EXECUTOR = '$joyous'` 定义在 `src/protocol/dispatch.js`（拓展内），不在内核枚举里**；它是**权限键的一部分**，改名会让既有授权失效，必须同步迁移。
- 命令 `joyous:mc`（别名无、任何人可用）、`joyous:bridge`（管理员）；AI 工具 `joyous:worldMeta`、`joyous:serverStatus`（名字保持与重构前一致，提示词里引用的是 `joyous_serverStatus`）。

## 配置文件

- `config/main.json` — 名称/次名、`prefix`、`maxLogFileSize`、`detailedLog`（JSONC）；`config/saves/{permissions,ext}.json` 运行时写入；`config/prompts/<profile>.md` 各 AI Profile 提示词（**gitignore**）。
- `config/secret.json` — 模板（假 key，**入库**）；`secret.json`（根目录）— 真凭据（**gitignore**）。
- 拓展自带配置放 `extensions/<name>/config.json`（如 joyous），由 `neonaicConfManager.getConfig()` 读取（路径相对项目根）；该实例**不会**自动重载，改完要 `/neonaic:reload`。

## 沙箱自检配方（改动内核或拓展后必用）

真实仓库零污染地跑自检/回归：`rsync -a --exclude node_modules --exclude .git --exclude logs --exclude secret.json --exclude .workbuddy ./ $SB/` → `ln -s <real>/node_modules $SB/node_modules` → 覆写 `$SB/config/saves/permissions.json` → 在沙箱内运行脚本。
**`src/` 必须复制、绝不能软链**：Node 默认解析真实路径，软链会让 `ROOT_PATH` 自算指回真实根，从而读写真实配置。
**改完源码必须重新 rsync**；用 JSON5 配置打补丁**不能按「相邻两行」匹配**（中间有注释行），要用锚定小节的正则；`import(x + '?bust=1')` 会造出**新模块实例**，命令处理器仍绑在旧实例闭包上，测不通。

## 编辑器 / 语言服务

- `jsconfig.json` 的 `include` 必须写 `src/**/*.js`。**`src/**.js` 与 `src/**` 匹配 0 个文件**（TS 的 `**` 必须自成路径段 `/**/`），会让项目只剩 `main.js`，除静态可达文件外所有自动 import / 跨文件补全失效；`extensions/**/*.js` 也必须显式加进去（拓展靠运行时动态 `import()`，静态追不到）。
- 需设 `module: NodeNext` + `moduleResolution: NodeNext`，并在 `.vscode/settings.json` 设 `importModuleSpecifierEnding: "js"`（否则自动 import 会写出无后缀导入，Node ESM 直接 `ERR_MODULE_NOT_FOUND`）。

## 注意事项

- **⚠️ NeonaicConfig 默认 AUTOSAVE**：任何 `put*`/`set`/`remove` **立即落盘**。测试脚本**绝不要指向真实配置文件**，用临时副本或先 `setWriteMode('inertia')`（已踩过：测试键写进了 `config/saves/ext.json`）。
- **内核不得出现任何拓展名**（解耦的硬判据）：判断一处改动是否破坏「拓展 ↔ 本体解耦」，看它**会不会留下「本体只在某拓展存在时才有意义」的东西**。据此：拓展专属的**合成执行者身份**（如 `$joyous`）必须定义在拓展内，**不得写进内核 `COMMAND_ENUMS`**；`$` 前缀是内核保留的合成身份命名空间（内核自身只占 `$console` / `$unknown`），权限按执行者字符串存授权，**不需要枚举登记**。反例对照：`NeonaicProtocolError` 这类**通用错误词汇**进内核不算耦合（不点名任何拓展）。守卫：自检里断言 `src/` 全目录 grep 不到拓展名，且 `COMMAND_ENUMS.FROM_JOYOUS === undefined`。
- NeonaicConfig 写出的是 **JSON5**（键无引号、单引号字符串），读回要 `JSON5.parse`；嵌套路径**不能下探数组**（`a.0.b` 退化成顶层字面键），`isReachable` 可提前发现退化。
- macOS 大小写不敏感，`import './AI.js'` 这类大小写错误本地不报、**Linux 上必炸**。
- Git 按用户全局的**权责边界**执行（见 `~/.workbuddy/MEMORY.md`）：身份 `Neonai <neonai+coding@kdxiaoyi.top>`，仅 `git -c` 携带、不写 config；Conventional Commits 中英双语；**必须主动提交自己所做的修改**，只 add 本次任务产出的文件（含 `.workbuddy/memory/`），**不得提交与任务无关的代码，不得 push/pull/fetch/rebase/merge**。

## 已知待办

- **`commandServer.js` 的 `executeCommandSilent` / `executeCommand` 只拦同步异常**：命令处理器若是 `async`，抛出的异常以 Promise 拒绝逸出，不会被包成 `NeonaicCommandError`，`executeCommand` 的 auto-catch 也拦不到（会产生未处理拒绝）。当前 joyous 的 `dispatch.classify` 兜住了这一类，但**内核侧应单独修**（把返回值 `Promise.resolve().then` 包一层）。全项目 async 命令处理器很多，影响面广。
- `extLoader.js` 两处：`disable()` 无空守卫（`#instance` 为 null 时 `unload` 必抛，加 `if (!this.#instance) return;`）；`replaceAll('.', '\.')` 里 `'\.'` 就是 `'.'`，转义是空操作，且键名用 `.enabled` 而 `ext.json` 样例写的是 `enable`。
- `ai.js` 的 `neonaic:webfetch` 是半成品：`uri = new URL(address)` 赋给未声明变量（ESM 恒严格模式必抛，被 catch 吞掉）。
- `entry.js:112` 的 `checkPermissionFromContext(this)` 只传 1 个参数（签名 `(ctx, permission)`），`systemLine` 永远为空。
- `NeonaicUriMeta.js:184` 的 `{@link resolveUri}` 悬空（函数已随 `platformUtils.js` 删除）。
- Joyous **Java 侧尚未实现 UDS**：全仓库无 `ServerSocket` / `DomainSocket` / `SocketChannel` 代码。`PROTOCOL.md` §13 有 Java 侧实现清单，UDS 通道要等对端补齐后才可用。
