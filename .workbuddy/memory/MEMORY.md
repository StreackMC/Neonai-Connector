# Neonai-Connector 项目长期记忆

## 项目概览

- **名称**：Neonai-Connector — 基于 Node.js (ESM) 的服务端项目，作为与"澪奈 (Neonai)"沟通的桥梁
- **显示名称**：澪奈 / Neonai（配置在 config/main.json 的 `name` / `subname`，当前为「澪奈」/「Neonai」）
- **License**：AGPL-3.0 + 附加条款（禁止复用美术资源、禁止将 "Neonai""澪奈" 用作自身品牌，项目名 "Neonai-Connector" 除外）
- **远程仓库**：`git@github.com:StreackMC/Neonai.git`（GitHub）

## 架构设计

采用 **三层架构 + 组合根 (Composition Root) + 依赖注入** 模式：

### 目录 / 层划分

| 层 | 目录 | 职责 |
|----|------|------|
| **System** | `src/system/` | 底层基础设施：entry（组合根）、confManager、NeonaicConfig、Logger 之外的 CLI / PID |
| **Logger** | `src/logger/` | 日志系统（Logger.js）+ log4js 注入 |
| **Command** | `src/command/` | 命令引擎 commandServer + 权限 permissionServer + 枚举 commandInterface |
| **Message** | `src/message/` | IN→OUT 中转：ai.js（AI 交互）、messageIn.js（命令→AI 双层回复） |
| **Platform** | `src/platform/` | 平台适配：platformInterface（基类）、platformManager、platformUtils |
| **Extension** | `src/extension/` | 拓展加载（extLoader；extManager 正在改写） |
| **Utils** | `src/utils/` | 通用件：NeonaicConfig / NeonaicNewableClass / NeonaicNewableError / NeonaicUriMeta / network / text |
| **Extensions** | `extensions/` | 具体拓展：`qqbot/`、`joyous/` |

### 模块清单（当前真实布局）

- `main.js` — 瘦入口（仅调用 `neonaicEntry.bootstrap()` 并兜底错误）
- `src/system/entry.js` — 组合根：PID 锁、平台管理器初始化、CLI 启动、权限/配置命令安装、优雅关闭
- `src/system/confManager.js` — 声明式配置：`CONFIG_PATHS` 硬编码，JSON5 解析，按路径缓存单例 `getConfig(path)`
- `src/utils/NeonaicConfig.js` — 单文件配置处理器（SConfig 的 JS 移植，详见下节）
- `src/utils/NeonaicNewableClass.js` — `NeonaicNewable` 基类 + 静态 `getUniqueId()`
- `src/utils/NeonaicNewableError.js` — 错误类体系：`NeonaicError` 及 Command / Extension / Network / IO / FileNotFound / IllegalArgument / IllegalState / Arithmetic / UnsupportedOperation 子类
- `src/utils/text.js` — `parseString`（从 Logger.js 抽出，顶层具名导出）
- `src/utils/NeonaicUriMeta.js`、`src/utils/network.js`（`neonaicNetwork`）
- `src/system/cliProcessor.js` — CLI 交互层：readline REPL、TAB 补全、保活定时器、prompt 擦除/重绘
- `src/logger/Logger.js` — 分模块日志：`LOG_TYPES` 声明式定义，Proxy 路由，gzip 轮转，console 劫持，`getLogger()` 顶层语法糖
- `src/command/commandServer.js` — 注册式命令引擎：`registerCommand` / `executeCommand(Silent)` / `inferNext`，冲突检测
- `src/command/permissionServer.js` — 4 层权限（临时 > 永久 > 全局临时 > 全局），持久化到 `config/saves/permissions.json`
- `src/message/ai.js` — Vercel AI SDK 封装（`askAI`、`registerAITool`，Profile 从 `secret.json` 的 `oai` 读取）
- `src/platform/platformManager.js` — 平台生命周期：`registerPlatform(Cls)`，`platform` CLI 命令（list/start/stop/enable/disable），enable/disable 写回 `secret.json`
- `src/platform/platformInterface.js` — `NeonaiPlatform` 基类
- `debug.cjs` — 调试会话入口（CJS→ESM 过渡），非 TTY 下通过全局 `$("cmd")` 模拟 CLI 输入

### 模块导出约定（强制）

- 函数 / 常量**只导出一个命名空间对象**，禁止分散具名导出；类**一律直接导出**（`export class X`），不嵌套进对象。
- **命名风格正从 PascalCase 迁往 camelCase**（`neonaicConfManager` / `neonaicCommandServer` / `neonaicAI` / `neonaicNetwork` / `neonaicEntry` …）。**迁移尚未完成**（`extensions/joyous` 还在用旧名与旧大小写 `AI.js`），改任何导入前先 grep 实际导出名。
- 只有类的模块没有对象导出（`platformInterface.js` → `NeonaiPlatform`、`NeonaicConfig.js` → `NeonaicConfig`）。
- **例外（高频调用点的语法糖，顶层具名导出、不再放进对象）**：`text.js` 的 `parseString`、`Logger.js` 的 `getLogger()`；另 `log4js_inject.js` 的 `configure` 是 log4js appender 的硬性要求。
- 对象字面量统一放在文件**末尾**（类声明不提升，提前引用会 TDZ 报错）。
- 错误统一抛 `NeonaicNewableError.js` 里的 `Neonaic*Error`，不再抛裸 `Error`（`IllegalState` ↔ Java 的 IllegalStateException，`IllegalArgument` ↔ IllegalArgumentException，`IO` ↔ IOException）。

### NeonaicConfig（SConfig 的 JS 移植）

对齐 `StreackLib` 的 `SConfig.java` / `docs/types/SConfig.md`，已实现：`WRITE_MODES` 五种写入模式（**默认 AUTOSAVE**）、自动重载（`setAutoReload` / `setAutoReloadInterval` / `setAutoReloadBreak` / `onAutoReloaded`）、`onLoadFailure`、`reload` / `getRawData` / `getFile`、`isExist` / `isReachable` / `remove`、全套类型化 getter/putter（含 `Date` 版 LocalDate / LocalTime / LocalDateTime）、`getListOfString` / `getSection`（浅拷贝）/ `putSection`、链式调用、原子写入、`_root_array` 根数组特例、`\.` 转义点号、静态工厂 `fromObject` / `fromJSON5`（仅内存态 + 惰性临时文件）、可配编码。

有意不实现：多格式（只有 JSON5）、注释、RootName（后两者是 Java 后端专属能力）、BigDecimal（JS 无原生十进制类型）。

### CLI 命令系统

签名：`NeonaicCommandServer.registerCommand(namespace, name, handler, opts)`。各模块在 import 时自注册，`handler` 的 `this` 是 `NeonaicCommandContext`。

opts 包含：`alias`（别名）、`permissions`（第一层 AND、第二层 OR，`!perm` 表示须缺失）、`description`、`usage`。命令引用支持 `name` / `alias` / `ns:name` / `ns:alias`。

特性：TAB 补全（`inferNext`）、别名撞原名的覆盖例外、保活定时器（无平台时进程不退出，仅 `stop` 安全关闭）。

**调试模式**：非 TTY 环境（VS Code 调试等）跳过 REPL，通过 `globalThis.$("cmd")` 模拟 CLI 输入。使用 `debug.cjs` 作为入口（CJS → ESM 过渡）。

内置命令：`neonaic:{help, sudo, runuser, version, stop}` + `neonaic:permission`(perm) / `whoami` / `reload` / `platform`(pm) / `ai`(askai)；扩展注册 `joyous:mc`、`qqbot:qbsend`。（旧记忆里的 `status` 命令、`argsCount` 校验、错误防抖均已不存在。）

设计原则：声明式（模块顶部硬编码映射表）、解耦（子模块互不引用，经组合根注入）、惰性单例（import 无副作用）、优雅关闭（5s 超时强制退出）。

## 扩展系统 (Extensions)

项目规划通过 **扩展自动发现** 实现插件化，无需在入口硬编码路径：

- 加载器：`src/extension/extLoader.js`（`NeonaicExtItem` / `MANIFEST_STRUCTURE`）。**当前尚未接入 `entry.js`**（组合根里留了 `// todo: refactor`），`extMgr.js` 还是 0 字节空文件。
- 布局：`extensions/<name>/index.js` + 同目录 `manifest.json`。
- `manifest.json` 结构：`meta.version`（如 `[1, "0.1.0"]`）、`meta.id`（须匹配 `^[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)*$`）、`particulars.{name,author,description,url,license}`、`entry`（如 `./index.js`）、`depends` / `softdepends`。
- `NeonaicExtItem.enable()` 要求入口模块导出 `onEnable` 与 `onDisable`。
- **约定**：扩展内导入内核模块用 `../../src/...`（相对本文件向上两层）。
- 注意：扩展文件必须叫 `index.js` 且位于子目录中；扁平文件不会被加载。

## 配置文件

- `config/main.json` — 机器人名称/次名、命令前缀 `prefix`、`maxLogFileSize`、`detailedLog`（JSONC）
- `config/prompts/<profile>.md` — 各 AI Profile 的系统提示词，按 `oai[].name` 加载；`config/prompts` **已 gitignore**
- `config/saves/permissions.json` — 权限持久化（运行时写入）
- `config/saves/ext.json` — 拓展启用状态
- `config/secret.json` — 凭据模板文件（假 key），**已入库 Git 跟踪**
- `secret.json`（根目录）— 真实敏感信息（`oai` Profile、`platforms`），**已 gitignore，不入库**

## Git 提交约定（全局强制）

- **用户名**：`NeoNai`
- **邮箱**：`neonai+coding@kdxiaoyi.top`
- **传递方式**：仅通过命令行 `-c user.name=... -c user.email=...` 携带，**不得写入 git config**
- **提交消息格式**：Conventional Commits（`type(scope)：描述`），**中英双语**
  - 示例：`feat(logger)：优化Error落盘格式 / improve error logging format`
  - 常用 type：feat / fix / refactor / style / docs / chore / env
- **暂存规则**：只 `git add` 必要文件，**禁止盲目 `git add .`**
- **记忆文件**：`.workbuddy/memory/` 下的记忆文件需一并提交

## 注意事项

- 凭据管理：`config/secret.json` 是模板（假 key），`secret.json`（根目录）是真凭据，gitignore 已正确排除根目录版本
- 运行程序前需确保根目录 `secret.json` 已填入真实凭据
- **⚠️ NeonaicConfig 默认 AUTOSAVE**：任何 `put*` / `set` / `remove` 都会**立即落盘**。写测试或脚本时**绝不要指向真实配置文件**（`config/*.json`、`secret.json`），一律用临时副本；需要只改内存就先 `setWriteMode('inertia')`。（已踩过一次：把测试键写进了 `config/saves/ext.json`。）
- `NeonaicConfig` 写出的文件是 **JSON5**（键无引号、字符串单引号），要用 `JSON5.parse` 读回，不能用 `JSON.parse`。
- 嵌套路径**不能下探数组**（`a.0.b` 会退化成顶层字面键），Java 版行为相同；用 `isReachable` 可提前发现退化。

## 已知待办

- 拓展加载链路未打通：`extLoader.js` 未接入 `entry.js`；`extensions/qqbot/index.js` 在 import 时靠 `registerPlatform` 自注册、并未导出 `onEnable`/`onDisable`，与 `NeonaicExtItem.enable()` 的契约不一致。
- `extensions/joyous` 的 `onEnable`/`onDisable` 是空实现。
- **camelCase 迁移的遗留失配**（非本轮引入，属用户 in-flight 工作）：`src/extension/extLoader.js` 与 `extManager.js` 仍 import `../system/NeonaicNewableClass.js`（已迁到 `../utils/`）；`extensions/joyous/index.js` 仍用旧导出名 `NeonaicAI` / `NeonaicCommandServer` / `NeonaicConfManager` 且路径写成 `../message/AI.js`。
- `src/message/ai.js` 底部的 `neonaic:webfetch` 工具是半成品：`uri = new URL(address)` 赋值给未声明变量（严格模式下会抛错），内网校验逻辑也没写完。
- `entry.js` 的 `neonaic:version` 里 `checkPermissionFromContext(this)` 只传了 1 个参数（签名是 `(ctx, permission)`），导致 `systemLine` 永远为空；`platformManager` 的命令权限串拼写为 `neonaic.commmand.platform`（多一个 m）。
- CLI 命令系统的 `argsCount` 参数校验、错误防抖在现行 commandServer 中已不存在（旧记忆已过时）。
