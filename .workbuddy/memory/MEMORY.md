# Neonai-Connector 项目长期记忆

## 概览

- **Neonai-Connector** — Node.js (ESM) 服务端，与「澪奈 (Neonai)」沟通的桥梁；显示名取 `config/main.json` 的 `name`/`subname`。
- **License** AGPL-3.0 + 附加条款（禁止复用美术资源、禁止将 "Neonai"/"澪奈" 用作自身品牌）；远程仓库 `git@github.com:StreackMC/Neonai.git`。

## 架构

三层 + 组合根 (Composition Root) + 依赖注入。

| 层 | 目录 | 内容 |
|----|------|------|
| System | `src/system/` | entry（组合根）、confManager、cliProcessor、pidManager |
| Logger | `src/logger/` | Logger.js、log4js_inject.js |
| Command | `src/command/` | commandServer、permissionServer、commandInterface |
| Message | `src/message/` | ai.js、messageIn.js（命令→AI 双层回复） |
| Platform | `src/platform/` | platformInterface（基类）、platformManager |
| Extension | `src/extension/` | extLoader、extManager |
| Utils | `src/utils/` | NeonaicConfig、NeonaicNewableClass、NeonaicNewableError、NeonaicUriMeta、io.js、text.js、math.js、chore.js |
| Extensions | `extensions/` | `qqbot/`、`joyous/`、`wordle/` |

- `main.js` 瘦入口（仅 `neonaicEntry.bootstrap()` + 兜底错误）；`debug.cjs` 调试入口，非 TTY 下用全局 `$("cmd")` 模拟 CLI。
- `io.js` 导出 `neonaicNetwork`/`neonaicFileSystem`（原 `network.js` 已并入）；`NeonaicUriMeta.js` 只剩 `export class NeonaicUriMeta`（旧 `resolveUri` 已随 `platformUtils.js` 删除）。
- 错误统一抛 `NeonaicNewableError.js` 的 `Neonaic*Error`（IllegalState / IllegalArgument / IO ↔ Java 同名），不抛裸 `Error`。

## 模块导出约定（强制）

- 函数/常量**只导出单个命名空间对象**（`export const neonaicXxx = { ... }`）；**类一律 `export class`，不嵌套进对象**。
- 命名统一 **camelCase**（`neonaicConfManager`/`neonaicCommandServer`/`neonaicEntry`/`neonaicExtensionManager` …），迁移**已完成**（含 extensions 侧）。
- **顶层具名导出的例外**（高频调用点语法糖，且不重复放进对象）：`text.js` 的 `parseString`、`Logger.js` 的 `getLogger()`；`log4js_inject.js` 的 `configure` 是 log4js appender 的硬性要求。
- 对象字面量放文件**末尾**（`class` 不提升，提前引用会 TDZ）；JSDoc 类型引用写 `import('./x.js').类名`（路径相对当前文件，改目录后极易失配）。
- 只有类的模块因此没有对象导出（`platformInterface.js`、`NeonaicUriMeta.js`）。

## NeonaicConfig（SConfig.java 的 JS 移植）

- 已实现：`WRITE_MODES` 五种（**默认 AUTOSAVE**）、自动重载（`setAutoReload`/`setAutoReloadInterval`/`setAutoReloadBreak`/`onAutoReloaded`）、`onLoadFailure`、`reload`/`getRawData`/`getFile`、`isExist`/`isReachable`/`remove`、全套类型化 getter/putter（含 `Date` 版 LocalDate/LocalTime/LocalDateTime）、`getListOfString`/`getSection`（浅拷贝）/`putSection`、链式调用、原子写入、`_root_array` 根数组特例、`\.` 转义点号、静态工厂 `fromObject`/`fromJSON5`（内存态 + 惰性临时文件）。
- 有意不实现：多格式（只 JSON5）、注释、RootName（Java 专属）、BigDecimal（JS 无原生十进制）。
- 与 Java 的差异：无锁（JS 单线程）、`getBoolean` 是超集、保存后同步自身 mtime、`getFile(true)` 直接写入当前内容。

## CLI 命令系统

`neonaicCommandServer.registerCommand(namespace, name, handler, opts)`；各模块 import 时自注册，handler 的 `this` 是 `NeonaicCommandContext`（参数按 `handler.call(ctx, ...args)` 展开）。opts：`alias`/`permissions`（第一层 AND、第二层 OR，`!perm` 表示须缺失）/`description`/`usage`；命令引用支持 `name`/`alias`/`ns:name`/`ns:alias`。内置 `neonaic:{help,sudo,runuser,version,stop}` + `permission`(perm)/`whoami`/`reload`/`platform`(pm)/`ai`(askai)/`extension`(ext)；拓展注册 `joyous:mc`、`qqbot:qbsend`、`wordle:wordle`(wd)。（`argsCount` 校验、错误防抖已不存在。）设计原则：声明式、子模块互不引用（经组合根注入）、惰性单例、优雅关闭（5s 超时强制退出）。

## 扩展系统

- 加载器 `extLoader.js`（`NeonaicExtItem` + `neonaicExtensionLoader`）、管理器 `extManager.js`（`neonaicExtensionManager`）。**已接入 `entry.js`**：`loadAll([...(await neonaicExtensionManager.scan()).keys()])`，失败项由 `entry.js` 用 `forEach` 逐条 error 输出。
- API：`scan(root)`/`list`/`find`/`load`/`unload`/`loadAll`/`unloadAll`/`enable`/`disable`/`enableAll`/`disableAll`，getter `root`/`size`/`ids`；子命令 `list`(默认)/`scan [dir]`/`info <ext>`/`load`/`unload`/`enable`/`disable`，省略拓展名即对全部操作。
- **返回结构以文件里的 `@typedef` 为准**（用户写的，改实现前先读）：`NeonaicExtOperateStatusPayload` = `{ operation, status, error, id }`，`operation` ∈ `load|unload|enabled|disabled`（enable/disable 用**过去分词**），`status` ∈ `notfound|successfully|failed|disabled`（`disabled` 只在 `operation='load'`）；`NeonaicExtOperateStatus` = `{ operation, succeed, notfound, disabled, failed }`，**没有 `affected`**。
- **两套语义正交**：`load`/`unload` 只管运行期（`unload` 标 `@deprecated`）；`enable`/`disable` 只管 `ext.json` 开关、**默认不改运行状态**（disable 后仍在跑是预期）。运行状态不进 payload，需要时查 `list()`。
- **布局** `extensions/<name>/src/*.js` + 同级 `manifest.json`（`entry` 写 `./src/entry.js`）；`meta.version` 如 `[1,"0.1.0"]`、`meta.id` 须匹配 `^[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)*$`、`particulars.{name,author,description,url,license}`、`depends`/`softdepends`。
- `NeonaicExtItem.enable()` 要求入口同时导出 `onEnable` 与 `onDisable`（都必须是函数）；开关存 `ext.json` 的 `<id>.enabled`（缺省 true）。拓展内导入内核模块用 `../../../src/...`；入口必须叫 `entry.js` 且在 `src/` 下。

## 拓展：Wordle

- `extensions/wordle/src/`：`entry.js`（命令层）、`session.js`（对局与难度）、`word_provider.js`（词表 + 全角字母表）。命令 `wordle:wordle`（别名 `wd`/`wl`）；`session.js` 另导出 `clearSession`/`hasSession`/`newSession(user, timeout, difficulty)`/`WordleDifficulty`/`resolveDifficulty`/`WordleEnums`/`WordleSession`。
- 难度：`normal|hard|uhard`；别名接受 `normal|n`、`hard`、`uhard|uh|ultrahard`，**刻意不收单字母 `h`**（与「查看历史」冲突，否则无对局时 `/wordle h` 会开出困难局）。
- 规则：困难 = 绿位不可动 + 黄字母必须继续用；极限 = 困难 + 黄字母必须换位 + 白字母不得再现。约束由 `#constraints()` 从历史推导，`checkDifficulty()` 是公开只读版；猜中那行在 `#triesResult` 里存的是 `'right'` **字符串**（不是数组），推导与渲染时都要展开成全绿。
- `entry.js` 参数解析：`sub = args[0]` 判子命令、`param = args.join('')` 判猜测。**不要只看 join 后的整串**，否则 `/wd new hard` 被拼成 `newhard`、`new` 分支永不触发。无对局时：`hard`/`uhard` → 按该难度开局；5 字母 → 普通开局并当作第一次猜测；其余 → 普通开局。
- **字母判定按份数结算**（两趟：先认领绿格份额，再按剩余份额判黄，用尽才判白）。**因果必须记住**：修好后 `missing` 不再等于「答案里没有该字母」（答案 `posse` 猜 `bokos`，第 4 个 `o` 是白但确实在答案里，只是份额被绿格用光），因此 `#constraints().white` **必须剔掉已在绿/黄中出现过的字母**，否则极限模式的「白色字母不得再现」会误封正确字母、局面无解（当时实测 400 局中 56 局失败）。
- 已修（用户提交）：`usable` 守卫（`guess()` 里 `!this.#usable` 抛错）、`set usable` 补 `new`、`timeouts` 过期清理、`guess()` 长度判定、`onDisable` 清会话、`history` 注明不可修改。
- `set usable` 现写成 `if (!v) return;`（用户加的）：`usable = false` 成了**静默空操作** → 外部无法再关闭会话（`clearSession` 里那句 `usable = false` 失效、`guess()` 的守卫沦为死代码、throw 不可达）。玩法不受影响（赢/输/放弃/超时都仍会把会话从 `sessions` 删除），只是外部持有引用者仍能作答。**真正幂等应写「当前值已等于目标值才 return」**。
- 难度约束**不会**让局面无解（400 局极限模式 + 40000 对字母判定比对，0 次失败）。

## 配置文件

- `config/main.json` — 名称/次名、`prefix`、`maxLogFileSize`、`detailedLog`（JSONC）；`config/saves/{permissions,ext}.json` — 运行时写入；`config/prompts/<profile>.md` — 各 AI Profile 系统提示词（**已 gitignore**）。
- `config/secret.json` — 凭据模板（假 key，**入库**）；`secret.json`（根目录）— 真凭据（**gitignore**）。

## 编辑器 / 语言服务

- `jsconfig.json` 的 `include` 必须写 `src/**/*.js`。**`src/**.js` 与 `src/**` 匹配 0 个文件**（TS 的 `**` 必须自成路径段 `/**/`），会导致项目只剩 `main.js`，除静态可达文件外所有自动 import / 跨文件补全失效。
- `extensions/**/*.js` 必须显式加进 `include`：拓展靠运行时动态 `import()` 加载，静态追不到，不加就等于「没有任何引用的代码」。
- 需设 `module: NodeNext` + `moduleResolution: NodeNext`（否则推成 `module=ES2015` → `moduleResolution=Classic`，读不懂 `package.json` 的 `exports`/`types`）；`.vscode/settings.json` 设 `importModuleSpecifierEnding: "js"`（否则会写出无后缀导入，Node ESM 直接 `ERR_MODULE_NOT_FOUND`）。

## 注意事项

- **⚠️ NeonaicConfig 默认 AUTOSAVE**：任何 `put*`/`set`/`remove` **立即落盘**。测试脚本**绝不要指向真实配置文件**，用临时副本或先 `setWriteMode('inertia')`。（已踩过：测试键写进了 `config/saves/ext.json`。）
- NeonaicConfig 写出的是 **JSON5**（键无引号、字符串单引号），读回要用 `JSON5.parse`。
- 嵌套路径**不能下探数组**（`a.0.b` 退化成顶层字面键，Java 版相同）；`isReachable` 可提前发现退化。
- macOS 大小写不敏感，`import './AI.js'` 之类的大小写错误本地不报、**Linux 上必炸**；核对路径要逐段比对目录名。
- Git 提交按用户全局约定（`NeoNai <neonai+coding@kdxiaoyi.top>`，仅用 `git -c` 携带，不写入 git config；Conventional Commits 中英双语；只 add 必要文件）。

## 已知待办

- `extLoader.js` 的 `disable()` 无空守卫：`#instance` 为 null 时 `unload` 必抛（TypeError 被包成 `NeonaicExtensionError`）。加 `if (!this.#instance) return;` 即可。
- `extLoader.js` 的 `this.id.replaceAll('.', '\.')` 中 `'\.'` 就是 `'.'`，转义是空操作（点号 id 会按嵌套路径写进 ext.json）；且键名用 `.enabled`，而 `ext.json` 现存样例写的是 `enable`。
- `src/message/ai.js` 的 `neonaic:webfetch` 是半成品：`uri = new URL(address)` 赋给未声明变量（ESM 恒严格模式，必抛，被 catch 吞掉），「合法性校验」是个孤儿数组字面量。
- `src/system/entry.js:112` 的 `checkPermissionFromContext(this)` 只传 1 个参数（签名 `(ctx, permission)`），`systemLine` 永远为空。
- `src/utils/NeonaicUriMeta.js:184` 的 JSDoc `{@link resolveUri}` 是悬空引用（该函数已随 `platformUtils.js` 删除）。
