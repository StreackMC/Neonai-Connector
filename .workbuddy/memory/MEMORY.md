# Neonai 项目长期记忆

## 项目概览

- **名称**：澪奈 Neonai — 基于 Node.js (ESM) 的服务端项目，作为与"澪奈"沟通的桥梁
- **License**：AGPL-3.0 + 附加条款（禁止复用美术资源、禁止将项目名用作自身品牌）
- **远程仓库**：`git@github.com:StreackMC/Neonai.git`（GitHub）

## 架构设计

采用 **三层架构 + 组合根 (Composition Root) + 依赖注入** 模式：

### 三层划分

| 层 | 目录 | 职责 |
|----|------|------|
| **System** | `src/system/` | 底层基础设施：bootstrap、config、logger、CLI、PID 锁 |
| **Handler** | `src/Handler/` | IN→OUT 中转：调用 AI/Tool 将输入转换为输出 |
| **Platform** | `src/platform/` | 平台适配：接收消息流（IN），调用 Handler 获取回复（OUT），发回平台 |

### 模块清单

- `main.js` — 瘦入口（仅调用 system/entry.bootstrap 并兜底错误）
- `src/system/entry.js` — 组合根（惰性单例 getConfigs/getLogger、平台管理器初始化、CLI 启动、优雅关闭）
- `src/system/conf.js` — 声明式配置：`CONFIG_PATHS` 硬编码，JSON5 解析
- `src/system/logger.js` — 分模块日志：`LOG_TYPES` 声明式定义，Proxy 路由，gzip 轮转，console 劫持
- `src/system/pid.js` — PID 进程锁（通过参数接收 logger）
- `src/system/cli.js` — 注册式命令系统：`registerCommand(name, handler, opts)`，参数校验，防抖错误，TAB 补全，readline REPL + 保活定时器
- `src/system/platform-manager.js` — 平台生命周期管理：registerPlatform(name, {start,stop})，提供 `platform` CLI 命令（list/start/stop/enable/disable），enable/disable 直接写入 config/main.json
- `src/platform/qqbot.js` — QQ 频道机器人适配器，通过 registerPlatform 注册到管理器

### CLI 命令系统

通过 `registerCommand(name, handler, options?)` 注册命令，各层模块在 import 时自动注册。启动后进入 readline REPL（`>` 提示符）。

options 包含：`description`（帮助文本）、`argsCount`（参数数量校验，支持数字精确匹配和 [min, max] 范围）、`usage`（用法示例）。

特性：TAB 补全命令名、参数校验（红色高亮出错部分+原因说明）、错误防抖（800ms 内相同错误不重复）、保活定时器（无平台时进程不退出，仅 stop 命令安全关闭）。

内置系统命令：`help`（美化输出含描述）、`version`（版本/版权/系统信息）、`status`、`stop`、`platform list|start|stop|enable|disable`。QQBot 提供 `qqbot status|reconnect`。

设计原则：声明式（模块顶部硬编码映射表）、解耦（子模块互不引用，经组合根注入）、惰性单例（import 无副作用）、优雅关闭（5s 超时强制退出）。

## 配置文件

- `config/main.json` — 监听平台开关、console 重定向开关（JSONC）
- `config/logger.json` — 日志目录、单文件大小上限
- `config/secret.json` — 凭据模板文件（key 为随意填充），**已入库 Git 跟踪**
- `secret.json`（根目录）— 真实敏感信息（OAI 配置、QQBot 凭据），**已 gitignore，不入库**

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

- Handler 层待实现（当前仅为空目录，暂未填充实际 IN→OUT 逻辑）
- 平台层目前仅支持 QQBot，后续可扩展其他平台适配器
