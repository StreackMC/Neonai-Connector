# Neonai-Connector

> 澪奈 (Neonai) 的后端连接器 —— 与澪奈沟通的桥梁

基于 Node.js 的服务端项目，负责平台适配、消息中转与 AI 调用。

## 架构

```
Neonai-Connector/
├── main.js                   # 入口（仅做错误兜底，委托至 system/entry.js）
├── debug.cjs                 # 调试会话入口（--debug 模式，$(cmd) 交互）
├── src/
│   ├── system/               # SYSTEM 层：bootstrap · 配置 · 日志 · CLI
│   │   ├── entry.js          # 组合根（依赖注入，组装系统与平台）
│   │   ├── conf.js           # 声明式配置模块（JSON5 / JSONC）
│   │   ├── logger.js         # 分模块日志（Proxy 路由 · gzip 轮转 · console 劫持 · 蹦床）
│   │   ├── pid.js            # PID 进程锁（防止多实例）
│   │   ├── cli.js            # 注册式命令系统（参数校验 · TAB 补全 · readline REPL）
│   │   └── platform-manager.js  # 平台生命周期管理
│   ├── platform/             # Platform 层：平台适配（接收 IN，发送 OUT）
│   │   └── qqbot.js          # QQ 频道机器人
│   └── Handler/              # Handler 层：IN → OUT 中转（调用 AI / Tool）
├── config/
│   ├── main.json             # 主配置（名称、监听平台开关、console 重定向）
│   ├── logger.json           # 日志配置
│   └── secret.json           # 凭据模板
└── logs/                     # 日志输出 + 崩溃报告（运行时生成）
```

## 快速开始

```bash
npm install
npm start                 # 正常启动（CLI REPL）
node debug.cjs            # 调试模式（$(cmd) 交互，原生 console）
```

启动后进入 CLI REPL（`>` 提示符），输入 `help` 查看可用命令。

## License

本项目使用 [AGPL 3.0](./LICENSE) 进行开源，同时叠加以下附加条款：

- 不得以任何形式继续使用本项目中、由开发者持有著作权的美术资源；
- 不得以任何形式将 "Neonai""澪奈" 等名称用作自己的项目、产品、品牌或宣传名称（项目名 "Neonai-Connector" 除外）。

上述限制仅约束"将名称作为自身作品名称 / 品牌使用"的行为；在署名、致谢、参考链接等正当引用场景下提及，不属于被禁止的使用。
