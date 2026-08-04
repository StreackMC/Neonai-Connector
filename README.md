# 澪奈 Neonai

> 与澪奈沟通的桥梁

一个基于 Node.js 的服务端项目，作为与澪奈（Neonai）沟通的桥梁。

## 架构

```
Neonai/
├── main.js                   # 入口（仅做错误兜底，委托至 system/entry.js）
├── src/
│   ├── system/               # SYSTEM 层：bootstrap · 配置 · 日志 · CLI
│   │   ├── entry.js          # 组合根（依赖注入，组装系统与平台）
│   │   ├── conf.js           # 声明式配置模块（JSON5 / JSONC）
│   │   ├── logger.js         # 分模块日志（Proxy 路由 · gzip 轮转 · console 劫持）
│   │   ├── pid.js            # PID 进程锁（防止多实例）
│   │   └── cli.js            # 注册式命令系统（参数解析含引号转义 · readline REPL）
│   ├── platform/             # Platform 层：平台适配（接收 IN，发送 OUT）
│   │   └── qqbot.js          # QQ 频道机器人（qq-guild-bot）
│   └── Handler/              # Handler 层：IN → OUT 中转（调用 AI / Tool）
├── config/
│   ├── main.json             # 主配置（监听平台开关、console 重定向等）
│   ├── logger.json           # 日志配置
│   └── secret.json           # 凭据模板（假 key，真凭据在根目录 secret.json）
└── logs/                     # 日志输出目录（运行时生成，自动 gzip 轮转）
```

### 三层架构

| 层 | 职责 |
|----|------|
| **System** | 底层基础设施：bootstrap / config / logger / CLI |
| **Handler** | 输入→输出中转：调用 AI、Tool 等将 IN 转为 OUT |
| **Platform** | 平台交互适配：接收消息流（IN），调用 Handler 获取回复（OUT），发送回平台 |

各层均通过 CLI 命令系统 `registerCommand(name, handler)` 注册命令供交互式 REPL 调用。

## 快速开始

```bash
npm install
npm start
```

启动后将进入 CLI REPL（`>` 提示符），输入 `help` 查看可用命令。

## 配置

配置文件位于 `config/` 目录，内部名与配置路径的对应关系在 `src/system/conf.js` 的 `CONFIG_PATHS` 中声明。支持 JSONC / JSON5 语法（注释、尾逗号、单引号等）。

## License

本项目使用 [AGPL 3.0](./LICENSE) 进行开源，同时叠加以下附加条款：

- 不得以任何形式继续使用本项目中、由开发者持有著作权的美术资源（包括但不限于图片、视频等）；
- 不得以任何形式将本项目名（"Neonai""澪奈"等任何可与本项目及其开发者关联的字词）用作自己的项目、产品、品牌或宣传名称。

上述关于项目名的限制，仅约束"将项目名作为自身作品名称 / 品牌使用"的行为；在署名、致谢、参考链接等正当引用场景下提及本项目（例如在 README 中注明"基于本项目"并附上本项目地址），不属于被禁止的"再次使用"。
