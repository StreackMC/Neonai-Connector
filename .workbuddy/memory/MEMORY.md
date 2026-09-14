# Neonai-Connector 项目长期记忆

## 概览

- **Neonai-Connector** — Node.js (ESM) 服务端项目，与「澪奈 (Neonai)」沟通的桥梁；显示名取 `config/main.json` 的 `name` / `subname`
- **License**：AGPL-3.0 + 附加条款（禁止复用美术资源、禁止将 "Neonai"/"澪奈" 用作自身品牌）；远程仓库 `git@github.com:StreackMC/Neonai.git`

## 架构

三层 + 组合根 (Composition Root) + 依赖注入。

| 层 | 目录 | 内容 |
|----|------|------|
| System | `src/system/` | entry（组合根）、confManager、cliProcessor、pidManager |
| Logger | `src/logger/` | Logger.js、log4js_inject.js |
| Command | `src/command/` | commandServer、permissionServer、commandInterface |
| Message | `src/message/` | ai.js（AI 交互）、messageIn.js（命令→AI 双层回复） |
| Platform | `src/platform/` | platformInterface（基类）、platformManager |
| Extension | `src/extension/` | extLoader、extManager |
| Utils | `src/utils/` | NeonaicConfig、NeonaicNewableClass、NeonaicNewableError、NeonaicUriMeta、io.js、text.js、math.js、chore.js |
| Extensions | `extensions/` | 具体拓展：`qqbot/`、`joyous/`、`wordle/` |

- `main.js` 瘦入口（仅 `neonaicEntry.bootstrap()` + 兜底错误）；`debug.cjs` 调试入口，非 TTY 下用全局 `$("cmd")` 模拟 CLI 输入
- `src/utils/io.js` 导出 `neonaicNetwork` / `neonaicFileSystem`（原 `network.js` 已并入）；`src/utils/NeonaicUriMeta.js` 只剩 `export class NeonaicUriMeta`（旧 `resolveUri` 已随 `platformUtils.js` 删除）
- 已删除：`src/system/NeonaicConfig.js`（移到 utils）、`src/platform/platformUtils.js`
- 错误统一抛 `NeonaicNewableError.js` 的 `Neonaic*Error`（IllegalState / IllegalArgument / IO ↔ Java 同名异常），不再抛裸 `Error`

## 模块导出约定（强制）

- 函数 / 常量**只导出单个命名空间对象**（`export const neonaicXxx = { ... }`）；**类一律直接 `export class`，不嵌套进对象**。
- 命名统一 **camelCase**（`neonaicConfManager` / `neonaicCommandServer` / `neonaicAI` / `neonaicEntry` / `neonaicExtensionManager` …），迁移**已完成**（含 extensions 侧）。
- **顶层具名导出的例外（高频调用点语法糖，且不重复放进对象）**：`text.js` 的 `parseString`、`Logger.js` 的 `getLogger()`；另 `log4js_inject.js` 的 `configure` 是 log4js appender 的硬性要求。
- 对象字面量统一放文件**末尾**（`class` 不提升，提前引用会 TDZ 报错）。
- JSDoc 类型引用写作 `import('./x.js').类名`（路径**相对当前文件**，改目录后极易失配）。
- 只有类的模块因此没有对象导出（`platformInterface.js`、`NeonaicUriMeta.js`）。

## NeonaicConfig（SConfig.java 的 JS 移植）

- 已实现：`WRITE_MODES` 五种模式（**默认 AUTOSAVE**）、自动重载（`setAutoReload` / `setAutoReloadInterval` / `setAutoReloadBreak` / `onAutoReloaded`）、`onLoadFailure`、`reload` / `getRawData` / `getFile`、`isExist` / `isReachable` / `remove`、全套类型化 getter/putter（含 `Date` 版 LocalDate/LocalTime/LocalDateTime）、`getListOfString` / `getSection`（浅拷贝）/ `putSection`、链式调用、原子写入、`_root_array` 根数组特例、`\.` 转义点号、静态工厂 `fromObject` / `fromJSON5`（内存态 + 惰性临时文件）。
- 有意不实现：多格式（只 JSON5）、注释、RootName（Java 专属）、BigDecimal（JS 无原生十进制）。
- 与 Java 的差异：无锁（JS 单线程）、`getBoolean` 是超集、保存后同步自身 mtime（Java 会被自己的写入触发重载）、`getFile(true)` 直接写入当前内容。

## CLI 命令系统

`neonaicCommandServer.registerCommand(namespace, name, handler, opts)`；各模块 import 时自注册，`handler` 的 `this` 是 `NeonaicCommandContext`（参数按 `handler.call(ctx, ...args)` 展开）。opts：`alias` / `permissions`（第一层 AND、第二层 OR，`!perm` 表示须缺失）/ `description` / `usage`。命令引用支持 `name` / `alias` / `ns:name` / `ns:alias`。

内置：`neonaic:{help, sudo, runuser, version, stop}` + `permission`(perm) / `whoami` / `reload` / `platform`(pm) / `ai`(askai) / `extension`(ext)；拓展注册 `joyous:mc`、`qqbot:qbsend`、`wordle:wordle`(wd)。
（`argsCount` 校验、错误防抖已不存在。）设计原则：声明式、子模块互不引用（经组合根注入）、惰性单例、优雅关闭（5s 超时强制退出）。

## 扩展系统

- 加载器 `src/extension/extLoader.js`（`NeonaicExtItem` + `neonaicExtensionLoader`）、管理器 `src/extension/extManager.js`（`neonaicExtensionManager`）。**已接入 `entry.js`**：`loadAll([...(await neonaicExtensionManager.scan()).keys()])`；失败项由 `entry.js` 用 `forEach` 逐条 error 输出。
- 管理器 API：`scan(root)` / `list` / `find` / `load` / `unload` / `loadAll` / `unloadAll` / `enable` / `disable` / `enableAll` / `disableAll`，getter `root` / `size` / `ids`。
- 子命令：`list`(默认) / `scan [dir]` / `info <ext>` / `load` / `unload` / `enable` / `disable`；省略拓展名即对全部操作。
- **返回结构以文件里的 `@typedef` 为准**（用户写的，改实现前先读）：`NeonaicExtOperateStatusPayload` = `{ operation, status, error, id }`，`operation` ∈ `load|unload|enabled|disabled`（enable/disable 用**过去分词**），`status` ∈ `notfound|successfully|failed|disabled`（`disabled` 只在 `operation='load'`）；`NeonaicExtOperateStatus` = `{ operation, succeed, notfound, disabled, failed }`，**没有 `affected`**。
- **两套语义正交**：`load`/`unload` 只管运行期（`unload` 标 `@deprecated`，有内存泄漏风险）；`enable`/`disable` 只管 `config/saves/ext.json` 的开关、**默认不改运行状态**（故 disable 后仍在跑是预期）。运行状态不进 payload，需要时查 `list()`。
- **布局**：`extensions/<name>/src/*.js` + 同级 `manifest.json`（`entry` 写 `./src/entry.js`）。`meta.version` 如 `[1,"0.1.0"]`、`meta.id` 须匹配 `^[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)*$`、`particulars.{name,author,description,url,license}`、`depends`/`softdepends`。
- `NeonaicExtItem.enable()` 要求入口模块同时导出 `onEnable` 与 `onDisable`（必须都是函数）；开关存 `ext.json` 的 `<id>.enabled`（缺省 true）。
- **约定**：拓展内导入内核模块用 `../../../src/...`（文件在 `extensions/<name>/src/` 下，向上三层）；入口必须叫 `entry.js` 且在 `src/` 子目录里。

## 拓展：Wordle

- `extensions/wordle/src/` 三个文件：`entry.js`（命令层）、`session.js`（对局与难度规则）、`word_provider.js`（词表 + 全角字母表）。命令 `wordle:wordle`（别名 `wd`/`wl`）。
- `session.js` 导出 `WordleDifficulty`（`normal|hard|uhard`）、`resolveDifficulty`、`WordleEnums`、`WordleSession`、`newSession(user, timeout, difficulty)`、`clearSession`、`hasSession`。
- 难度别名**刻意不收单字母 `h`**（与历史指令冲突，否则「无对局时输入 `/wordle h`」会开出一局困难）。接受 `normal|n`、`hard`、`uhard|uh|ultrahard`。
- 困难 = 绿色位置不可动 + 黄色必须继续使用；极限 = 困难 + 黄色必须换位 + 白色不得再出现。约束由 `#constraints()` 从历史推导，`checkDifficulty()` 是公开只读版本。
- **猜中那一行在 `#triesResult` 里存的是 `'right'` 字符串（不是数组）**，推导约束与渲染历史时都要展开成全绿。
- `entry.js` 参数解析：`sub = args[0]` 判子命令、`param = args.join('')` 判猜测。**不要只看 join 后的整串**，否则 `/wd new hard` 会被拼成 `newhard`、`new` 分支永不触发。
- 无对局时：`hard`/`uhard` → 按该难度开局；5 字母 → 普通开局并当作第一次猜测；其余（`stop`、`h`、乱码）→ 普通开局。
- **字母判定按份数结算**（两趟：先认领绿格份额，再按剩余份额判黄，份额用尽才判白）。**因果必须记住**：修好后 `missing` 不再等于「答案里没有这个字母」（例：答案 `posse` 猜 `bokos`，第 4 个 `o` 是白但 `o` 确实在答案里，只是份额被绿格用光），因此 `#constraints().white` **必须剔掉已在绿/黄里出现过的字母**，否则极限模式的「白色字母不得出现」会误封正确字母、把局面变成无解（当时实测 400 局里 56 局失败）。
- 已修（用户自己提交）：`usable` 守卫、`set usable` 补 `new`、`timeouts` 过期清理、`guess()` 长度判定、`onDisable` 清会话、`history` 注明不可修改。
- `set usable` 现写成 `if (!v) return;`（用户加的）：`usable = false` 成了**静默空操作** → 外部已无法关闭会话（`clearSession` 里那句 `usable = false` 失效、`guess()` 的 `!this.#usable` 守卫沦为死代码、第 89 行的 `throw` 不可达）。正常玩法不受影响（赢/输/放弃/超时都仍会把会话从 `sessions` 里删除），只是「外部持有引用者仍能继续作答」。**要真正幂等应写成「当前值已等于目标值才 return」**，而不是对 `false` 一律 return。
- 难度约束**不会**让局面无解（400 局极限模式 + 40000 对字母判定比对，0 次失败）。

## 配置文件

- `config/main.json` — 名称/次名、命令前缀 `prefix`、`maxLogFileSize`、`detailedLog`（JSONC）
- `config/prompts/<profile>.md` — 各 AI Profile 系统提示词（**已 gitignore**）
- `config/saves/permissions.json`、`config/saves/ext.json` — 运行时写入
- `config/secret.json` — 凭据模板（假 key，**入库**）；`secret.json`（根目录）— 真凭据（**gitignore**）

## 编辑器 / 语言服务

- `jsconfig.json` 的 `include` 必须写 `src/**/*.js`。**`src/**.js` 与 `src/**` 匹配 0 个文件**（TS 的 `**` 必须自成路径段 `/**/`），会导致整个项目只剩 `main.js`，除 main.js 静态可达的文件外，所有自动 import / 跨文件补全全部失效。
- `extensions/**/*.js` 必须显式加进 `include`：拓展靠运行时动态 `import()` 加载，语言服务静态追不到，不加就等于「没有任何引用的代码」。
- 需设 `module: NodeNext` + `moduleResolution: NodeNext`。不设时 TS 按 target 推出 `module=ES2015` → `moduleResolution=Classic`，Classic 读不懂 `package.json` 的 `exports`/`types`（`qq-official-bot`、`json5` 都解析不出来）。
- `.vscode/settings.json` 设 `importModuleSpecifierEnding: "js"`，否则自动 import 可能写出无后缀导入，Node ESM 下直接 `ERR_MODULE_NOT_FOUND`。

## 注意事项

- **⚠️ NeonaicConfig 默认 AUTOSAVE**：任何 `put*`/`set`/`remove` **立即落盘**。测试脚本**绝不要指向真实配置文件**，一律用临时副本或先 `setWriteMode('inertia')`。（已踩过一次：测试键写进了 `config/saves/ext.json`。）
- NeonaicConfig 写出的是 **JSON5**（键无引号、字符串单引号），读回要用 `JSON5.parse`。
- 嵌套路径**不能下探数组**（`a.0.b` 退化成顶层字面键，Java 版相同）；`isReachable` 可提前发现退化。
- macOS 大小写不敏感，`import './AI.js'` 之类的大小写错误在本地不报、**Linux 上必炸**。核对路径大小写要逐段比对目录名。
- Git 提交按用户全局约定（`NeoNai <neonai+coding@kdxiaoyi.top>`，仅用 `git -c` 携带，不写入 git config；Conventional Commits 中英双语；只 add 必要文件）。

## 已知待办

- `extLoader.js` 的 `disable()` 无空守卫：`#instance` 为 null 时 `unload` 必抛（TypeError 被包成 `NeonaicExtensionError`）。加 `if (!this.#instance) return;` 即可。（enable 的 catch 已会重置 `#instance = null`，原先「加载失败被误判为已加载」的缺陷已修复。）
- `extLoader.js` 的 `this.id.replaceAll('.', '\.')` 里 `'\.'` 在 JS 中就是 `'.'`，转义是空操作（点号 id 会按嵌套路径写进 ext.json）；且键名用 `.enabled`，而 `ext.json` 现存样例写的是 `enable`。
- `src/message/ai.js` 的 `neonaic:webfetch` 工具是半成品：`uri = new URL(address)` 赋给未声明变量（ESM 恒严格模式，必抛，被 catch 吞掉），「合法性校验」是个孤儿数组字面量。
- `src/system/entry.js:112` 的 `checkPermissionFromContext(this)` 只传 1 个参数（签名 `(ctx, permission)`），`permission` 为 undefined，`systemLine` 永远为空。
- `src/utils/NeonaicUriMeta.js:184` 的 JSDoc `{@link resolveUri}` 是悬空引用（该函数已随 `platformUtils.js` 删除）。
