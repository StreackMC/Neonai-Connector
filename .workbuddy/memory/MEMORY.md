# Neonai 项目长期记忆

## 项目概览

- **名称**：澪奈 Neonai — 基于 Node.js (ESM) 的服务端项目，作为与"澪奈"沟通的桥梁
- **License**：AGPL-3.0 + 附加条款（禁止复用美术资源、禁止将项目名用作自身品牌）
- **远程仓库**：`git@github.com:StreackMC/Neonai.git`（GitHub）

## 架构设计

采用 **组合根 (Composition Root) + 依赖注入** 模式：

- `main.js` — 入口/组合根：加载配置 → 创建日志器 → PID 进程锁 → 按配置加载监听器 → 注册优雅关闭
- `src/conf.js` — 声明式配置：`CONFIG_PATHS` 硬编码内部名→路径映射，用 JSON5 解析（兼容 JSON/JSONC）
- `src/logger.js` — 分模块日志：`LOG_TYPES` 声明式定义类型，Proxy 路由 `logger.<call>.<level>()`，控制台+文件双输出，gzip 轮转，支持 console 劫持
- `src/QQBot/entry.js` — QQ 频道机器人监听器（qq-guild-bot），`init()` 返回 `{ close }` 供优雅关闭
- `src/Handler/` — 预留目录（消息处理器，当前为空）

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

- README.md 内容过时：仍提及已移除的 `src/websocket.js`，未记录 QQBot 模块和当前实际目录结构
- `logs/` 下残留 `Chat/`、`WebSocket/` 空目录（来自已移除的模块）
