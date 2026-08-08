# Neonai-Connector

> 澪奈 (Neonai) 的后端连接器 —— 与澪奈沟通的桥梁

基于 Node.js 的服务端项目，负责平台适配、消息中转与 AI 调用。

## 架构

* `src` 存放系统核心代码
  * `system` 系统底层代码，提供与CLI交互、各服务注册的能力
  * `platform` 与平台拓展交互，接入平台
  * `handler` 处理消息传入
* `extensions` 存放拓展代码
  * `handler` 拓展消息处理能力
  * `platform` 拓展平台兼容性

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
  - 因此，您应当在使用本项目前修改 [`/config/main.json`](/config/main.json) 的内容。

上述限制仅约束"将名称作为自身作品名称 / 品牌使用"的行为；在署名、致谢、参考链接等正当引用场景下提及，不属于被禁止的使用。
