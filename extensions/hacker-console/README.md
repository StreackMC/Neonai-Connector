# HackerConsole

> ⚠️ **仅供安全测试**。启动后它会开一个本地 HTTP 页面，页面上的代码会被**原样**送进
> [aicode](../aicode) 的沙箱执行。用完请 `/neonaic:extension unload hackerconsole`，
> 或者直接把它在 `config/saves/ext.json` 里禁掉。

## 它做了什么

```text
浏览器 ──POST /api/exec──▶ HackerConsole ──AI 工具 aicode:evaljs──▶ aicode 沙箱 ──▶ stdout / stderr
```

- 走的是 aicode **注册在 AI 工具表里的公开接口**（`aicode:evaljs`），不是直接 import 它的
  进程池。所以 aicode 的权限校验、并发分组、结果剥离全都在链路上——
  这里测到的就是「模型真的去调 aicode 时」的攻击面。
- aicode 不在时页面只是显示 `aicode 未就绪`，不会因为跨拓展依赖把内核带崩。

## 页面

四个组件：**编辑器**（带行号、Tab 缩进、`Ctrl/⌘ + Enter` 执行）、**执行按钮**、**stdout**、**stderr**。

- stdout = 代码里 `console.log` 的输出 + `return` 的返回值（前缀 `←`）。
- stderr = 失败原因（`[错误码] 消息` + `ErrorName: message`）。
- 工具栏的预设片段按 aicode 的安全模型逐条列好（读盘 / 环境变量 / 内网连通 / 原型链逃逸 /
  死循环 / 内存炸弹），用来快速复现某一条边界。

## 配置

见 [`config.json`](./config.json)，改完需要重载并重启拓展。

| 键 | 默认 | 说明 |
|---|---|---|
| `host` | `127.0.0.1` | **别改成 `0.0.0.0`**；改成非回环地址时启动日志会警告 |
| `port` | `4780` | 监听端口 |
| `token` | `""` | 非空时用 `http://127.0.0.1:4780/?token=xxx` 打开，页面会自动带上 `X-HackerConsole-Token` |
| `executor` | `$console` | 以谁的身份调 aicode：决定权限校验和 aicode 的并发分组 |
| `permission` | `aicode.execute` | aicode 需要的权限名，只用于自动授予/回收 |
| `autoGrant` | `true` | 被 `permission_denied` 挡下时，给 `executor` 授一次权再重试一次 |
| `maxBodyBytes` | `1048576` | 请求体上限 |

`autoGrant` 的写入是**可逆的**：只在「确实被拒」时才写，拓展关闭时用 `clearPermission`
回收自己授出的那一份。注意内核的 `clearPermission` 只删权限键、保留身份条目，
所以 `config/saves/permissions.json` 里可能留下一个 `"$console": {}`。

不想让它动权限文件的话，把 `autoGrant` 设成 `false`，自己手动授：

```text
/neonaic:permission set $console aicode.execute true
```

## HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/` | 控制台页面 |
| `GET` | `/api/status` | `{ ok, executor, permission, granted, aicode, tool }` |
| `POST` | `/api/exec` | body `{ "code": "..." }` → `{ ok, code, message, stdout, stderr, durationMs, wallMs }` |

```bash
curl -s -X POST http://127.0.0.1:4780/api/exec \
  -H 'content-type: application/json' \
  -d '{"code":"console.log(\"hi\"); return 1+2"}'
```

## 已知取舍

- 这是个测试工具，不是对外服务：没有鉴权体系、没有 CSRF 防护、不限制频率。
  **唯一的安全边界是「只监听回环 + 你自己开的页签」**。
- 请求是串行的：aicode 的 `conversation.maxConcurrent` 默认 1，同一个 `executor` 只能同时跑一个任务，
  并发提交会拿到 `busy`。
- 页面资源（`src/page.html`）在首次请求时读一次并缓存；改样式要重启拓展。
