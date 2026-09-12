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
| **Extension** | `src/extension/` | 拓展加载（extLoader；extMgr.js 目前为空文件） |
| **Extensions** | `extensions/` | 具体拓展：`qqbot/`、`joyous/` |

### 模块清单（当前真实布局）

- `main.js` — 瘦入口（仅调用 `NeonaicEntry.bootstrap()` 并兜底错误）
- `src/system/entry.js` — 组合根：PID 锁、平台管理器初始化、CLI 启动、权限/配置命令安装、优雅关闭
- `src/system/confManager.js` — 声明式配置：`CONFIG_PATHS` 硬编码，JSON5 解析，按路径缓存单例 `getConfig(path)`
- `src/system/NeonaicConfig.js` — 单个配置文件的读写类（点号嵌套路径 + 类型化 getter）
- `src/system/NeonaicNewableClass.js` — `NeonaicNewable` 基类 + `getUniqueId()`
- `src/system/cliProcessor.js` — CLI 交互层：readline REPL、TAB 补全、保活定时器、prompt 擦除/重绘
- `src/logger/Logger.js` — 分模块日志：`LOG_TYPES` 声明式定义，Proxy 路由，gzip 轮转，console 劫持，落盘自动截断
- `src/command/commandServer.js` — 注册式命令引擎：`registerCommand` / `executeCommand(Silent)` / `inferNext`，冲突检测
- `src/command/permissionServer.js` — 4 层权限（临时 > 永久 > 全局临时 > 全局），持久化到 `config/saves/permissions.json`
- `src/message/ai.js` — Vercel AI SDK 封装（`askAI`、`registerAITool`，Profile 从 `secret.json` 的 `oai` 读取）
- `src/platform/platformManager.js` — 平台生命周期：`registerPlatform(Cls)`，`platform` CLI 命令（list/start/stop/enable/disable），enable/disable 写回 `secret.json`
- `src/platform/platformInterface.js` — `NeonaiPlatform` 基类
- `src/platform/platformUtils.js` — `resolveUri` / `NeonaicUriMeta`（含内网判定、DNS 异步解析）
- `debug.cjs` — 调试会话入口（CJS→ESM 过渡），非 TTY 下通过全局 `$("cmd")` 模拟 CLI 输入

### 模块导出约定（强制）

- 函数 / 常量**只导出一个命名空间对象**：`export const NeonaicXxx = { ... }`，禁止分散具名导出。
- 命名规则：`Neonaic` + 文件名 PascalCase（如 `commandServer.js` → `NeonaicCommandServer`）。
- **类一律直接导出**（`export class NeonaicCommandContext`），**不嵌套进对象**；只有类的模块（`platformInterface.js` → `NeonaiPlatform`、`NeonaicConfig.js` → `NeonaicConfig`）因此没有对象导出。
- 混合模块：类顶层直接导出 + 其余成员进对象。如 `NeonaicNewableClass.js` 导出 `class NeonaicNewable` 与 `NeonaicNewableClass = { getUniqueId }`。
- **例外**：`Logger.js` 的 `parseString` 与 `getLogger()`——两者都是「高频调用点的语法糖」，保持顶层具名导出，**且不再重复放进 `NeonaicLogger` 对象**（避免双重暴露）。`NeonaicLogger` 对象现只剩 `{ setDebugMode, getDebugMode, setConsoleHooks, createLogger }`。另 `log4js_inject.js` 的 `configure` 是 log4js appender 的硬性要求。
- 调用点：对象成员走对象访问（`NeonaicConfManager.getBotName()`、`NeonaicCommandInterface.COMMAND_ENUMS.X`）；日志入口直接用 `getLogger()`；类直接按类名用，继承写作 `extends NeonaicNewable`。
- JSDoc 类型引用用 `import('./x.js').类名`（类直接导出才合法）。
- 对象字面量统一放在文件**末尾**（类声明不会提升，提前引用会 TDZ 报错）。

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

## 已知待办

- 拓展加载链路未打通：`extLoader.js` 未接入 `entry.js`，`extMgr.js` 为空；`extensions/qqbot/index.js` 在 import 时靠 `registerPlatform` 自注册、并未导出 `onEnable`/`onDisable`，与 `NeonaicExtItem.enable()` 的契约不一致。
- `extensions/joyous` 的 `onEnable`/`onDisable` 是空实现。
- `src/message/ai.js` 底部的 `neonaic:webfetch` 工具是半成品：`uri = new URL(address)` 赋值给未声明变量（严格模式下会抛错），内网校验逻辑也没写完。
- `entry.js` 的 `neonaic:version` 里 `checkPermissionFromContext(this)` 只传了 1 个参数（签名是 `(ctx, permission)`），导致 `systemLine` 永远为空；`platformManager` 的命令权限串拼写为 `neonaic.commmand.platform`（多一个 m）。
- CLI 命令系统的 `argsCount` 参数校验、错误防抖在现行 commandServer 中已不存在（旧记忆已过时）。
