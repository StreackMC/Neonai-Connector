# AICode

让 AI 在隔离沙箱里执行 JavaScript，并把结果/日志带回对话。

## 安全模型（四层）

1. **进程隔离**：每个沙箱是独立 `fork` 出来的 Node 子进程；父进程只通过 IPC 派发任务。
2. **系统级权限**：子进程以 `--permission --allow-fs-read=<项目根>` 启动（Node 支持时），
   即便沙箱被绕过，也读不到项目外的文件。
3. **QuickJS + WASM**：用户代码只在 QuickJS（wasm）里执行，`allowFs`/`allowFetch` 恒为 false；
   `process` 只是 `{ env, cwd }` 垫片，拿不到宿主的 `NEONAIC` 或密钥。
4. **每任务重建**：每次任务都新建一个 `vm` 上下文 + 一个新 QuickJS runtime；
   上一段代码的全局变量、原型污染、未释放句柄都不会进入下一段。

## 资源与生命周期

| 机制 | 行为 |
|---|---|
| `pool.maxChildren` | 最多同时存在的子进程数；没有空位时**立即返回 busy**，不排队 |
| `pool.idleMinutes` | 子进程连续无任务达到该时长即自行退出，下次按需拉起 |
| `pool.feedIntervalMs` / `feedTimeoutMs` | 父进程定期喂食；子进程断粮超时就自杀（防止父进程消失后留孤儿） |
| `limits.executionTimeoutMs` | QuickJS 软超时；到点中断并返回 `ExecutionTimeout`，该进程按超限回收 |
| `limits.taskTimeoutMs` | 父进程硬超时；到点 SIGKILL 并换新进程（必须大于软超时） |
| `limits.memoryLimitMB` | QuickJS 堆上限（字节制）。注意：大数组可能绕过它的记账 |
| `limits.maxStackSizeKB` | QuickJS 栈上限；超过 256KB 会触发 quickjs-ng 断言崩溃，已封顶 |
| `limits.maxRssMB` | 进程 RSS 上限：子进程内有监控线程（主线程被 wasm 阻塞也能跑），超限直接 SIGKILL；任务结束后父进程再补一次检查 |
| `conversation.maxConcurrent` | 同一对话（`ctx.executor[0]`）同时只允许一个任务，抑制 LLM 重复调用 |

**poison**：OOM、栈溢出导致 wasm abort、RSS 超限时，子进程会先发 `poison` 再退出；
父进程立即把它摘出池并 reject 本次任务。不重试，也不复用可疑进程。

## 权限

默认要求 `aicode.execute`，未授权时工具返回 `permission_denied`：

```
/neonaic:permission set USR#<id> aicode.execute true
```

把 `config.json` 的 `permission` 设为空串可关闭校验（不建议）。
校验走 `checkPermission(ctx.executor, …)`，**不**使用 `checkPermissionFromContext`——后者对
`internalCall` 直接放行，而「能执行代码」不应该因为调用来自内部就免检。

## 代码约定

代码按 async 函数体执行，**用 `return` 返回结果**；`console.log` 会被收集到 `logs`：

```js
const fs = await import('node:fs'); // 会被拒绝：File access is disabled
const xs = [3, 1, 2].sort((a, b) => a - b);
console.log('sorted', xs);
return xs.join(',');
```

不能使用 `export`（会与包装冲突）。单段代码受 `limits.maxCodeBytes` 限制。

## 配置

见 [`config.json`](./config.json)，改完需 `/neonaic:reload` 并重启拓展（与其它通道类拓展一致）。
