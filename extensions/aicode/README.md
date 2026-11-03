# AICode

让 AI 在隔离沙箱里执行 JavaScript，并把结果/日志带回对话。

## 安全模型（四层 + 两条明确的边界）

1. **进程隔离**：每个沙箱是独立 `spawn` 出来的 Node 子进程；父进程只通过两根私用管道（fd 3 读 / fd 4 写）派发任务。
2. **系统级权限**：子进程以 `--permission --allow-fs-read=<项目根>` 启动（Node 支持时）。
3. **QuickJS + WASM**：用户代码只在 QuickJS（wasm）里执行，`allowFs`/`allowFetch` 恒为 false；
   `process` 只是 `{ env: {}, cwd }` 垫片，拿不到宿主环境变量。
4. **每任务重建**：每次任务都新建一个 `vm` 上下文 + 一个新 QuickJS runtime；
   上一段代码的全局变量、原型污染、未释放句柄都不会进入下一段。

### 明确**不**承诺的两件事

- **QuickJS → 宿主的那一层不是安全边界**。用户代码拿不到任何宿主对象（它只能看见 `evalCode` 传进去的字符串），
  所以 JS 语义层面的原型链逃逸没有入口；但一旦有人在 wasm 层做出越界读写，攻击者就等于拿到了子进程的任意内存权限，
  这时 `vm`/`codeGeneration` 之类的设置全部失效 —— 真正的边界只剩下面第 2 层（进程 + 权限模型）。
- **权限模型覆盖不到的地方**（Node 22 实测）：

  | 通道 | 状态 |
  |---|---|
  | 写文件 / 删文件 | 拒绝（`ERR_ACCESS_DENIED`） |
  | 读项目根**之外** | 拒绝 |
  | 读项目根**之内** | **允许** —— 包括 `secret.json`、`config/`、`.env` |
  | `child_process` | 拒绝 |
  | `process.binding` | 拒绝 |
  | 网络（`net`/`dns`/`fetch`） | **不限制** |
  | 环境变量 | 只剩 `PATH`/`HOME`/`TMPDIR`/`LANG`/`LC_ALL`/`TZ`（见下） |
  | 发信号（`process.kill(ppid)`） | 不限制 |

  也就是说：真被攻陷时，攻击者拿不到「写盘」和「起子进程」，
  但读得到项目里的密钥、连得上内网、能杀掉内核。
  要堵这三条，只能靠外部手段（独立低权限用户、容器网络策略、把密钥移出项目根）。

  **环境变量是显式白名单，不继承 `process.env`**：早先是 `{ ...process.env }` 再删掉 `NEONAIC`，
  于是一条 `NODE_OPTIONS=--require ./x.js` 就能让子进程在 **Node 主线程**（QuickJS 之外）
  执行任意代码，整套沙箱形同虚设；凭证（`AWS_*` / `GITHUB_TOKEN` …）也会白送进子进程。

## 进程池：削峰缓冲

突发请求会撑起最多 `pool.maxChildren` 个进程吸收峰值，没有空位时**立即返回 busy**（不排队）。

待机回收用一条**等差数列**排开，而不是所有进程同一时刻集体到期：

```
step   = idleMaxMinutes * idleDecay / 当前待机进程数
budget(i) = idleMaxMinutes - (待机进程数 - 1 - i) * step      // i = 0 是最久没用的
```

- `i = 0` 的那位预算最小 → **进程越多，越早开始杀**；
- 最后一位（最新闲下来的）预算恰好是 `idleMaxMinutes`，即**最大待机时长**；
- `idleDecay = 0` 退化成「全体同时到期」；`idleDecay = 1` 削峰最凶（最早的只留 `idleMax/进程数`）；
- 预算有 5s 下限，避免「刚跑完就被回收」的抖动。

例：`idleMaxMinutes = 5`、`idleDecay = 0.5`

| 待机进程数 | 各自的待机预算（秒） |
|---|---|
| 1 | 300 |
| 3 | 200 / 250 / 300 |
| 10 | 165 / 180 / … / 300 |

## 资源与生命周期

| 机制 | 行为 |
|---|---|
| `pool.maxChildren` | 最多同时存在的子进程数；没有空位时**立即返回 busy**，不排队 |
| `pool.idleMaxMinutes` | 待机阶梯的上限：最后一位待机进程的存活时长 |
| `pool.idleDecay` | 递减系数（0~1），决定阶梯的陡峭程度 |
| `pool.feedIntervalMs` / `feedTimeoutMs` | 父进程定期喂食；子进程断粮超时就自杀（防止父进程消失后留孤儿） |
| `limits.executionTimeoutMs` | QuickJS 软超时；到点中断并返回 `ExecutionTimeout`，该进程按超限回收 |
| `limits.taskTimeoutMs` | 父进程硬超时；到点 SIGKILL 并换新进程（必须大于软超时） |
| `limits.memoryLimitMB` | QuickJS 堆上限（字节制）。注意：大数组可能绕过它的记账 |
| `limits.maxStackSizeKB` | QuickJS 栈上限；超过 256KB 会触发 quickjs-ng 断言崩溃，已封顶 |
| `limits.maxRssMB` | 进程 RSS 上限：子进程内有监控线程（主线程被 wasm 阻塞也能跑），超限先往 stderr 写一行 `[aicode:rss-limit]` 再 SIGKILL；任务结束后父进程再补一次检查 |
| `conversation.maxConcurrent` | 同一对话（`ctx.executor[0]`）同时只允许一个任务，抑制 LLM 重复调用 |

**交付即占用**：`acquire()` 在返回进程之前就把它标成 busy。否则两个并发任务会在同一个微任务间隙里
挑中同一个空闲进程（后者覆盖 `worker.task`，前者永久等不到结论）。

**poison**：OOM、栈溢出导致 wasm abort、RSS 超限时，子进程会先发 `poison` 再退出；
父进程立即把它摘出池并 reject 本次任务。不重试，也不复用可疑进程。

判定「是不是资源超限」**只看耗时和子进程自己发的帧，不看错误文本**。错误名与消息都来自 guest，
早先用 `/out of memory|aborted|assertion failed/i` 去匹配，`throw new Error("assertion failed")`
就能把自己伪装成资源超限、白嫖一次进程回收，还把普通错误报成系统故障。
现在用户级失败一律不当 poison，唯一的例外是「跑了接近 `limits.executionTimeoutMs` 才失败」——
那是 QuickJS 的 interrupt 打断过 wasm，可以按超时回收（guest 想伪造就得先付掉同样的 CPU 时间）。

## 父子进程协议（自己实现的帧校验）

**刻意不用 `fork` 的 IPC 通道**：那条通道的解析在 Node 内部（`parseChannelMessages`），
子进程往 fd 3 写一段非法 JSON 会让宿主的 `channel.onread` 抛未捕获异常，
**直接把 Neonai 内核打死**（Node 22.22.2 实测）。所以改成两根私用管道 + 自己的分帧：

- 帧 = 一行 JSON（`JSON.stringify` 不输出裸换行，`\n` 是安全的分隔符）；
- 半包留缓冲、粘包按分隔符切、单帧上限 1MB；
- 非 JSON / 非对象 / 超长 → 判定**协议异常** → 立即 SIGKILL 子进程（内核不受影响）；
- 结果帧还要求 `id` **严格相等**，否则丢弃（防止子进程省略 id 顶掉当前任务）。

## 结果剥离

用户代码在 QuickJS 里**只能回字符串**：宿主侧用 `JSON.stringify` 把返回值编码成一帧
（`aicode:<status>\n<payload>`），宿主再 `JSON.parse` 回来并重建一遍结构。

这么做有两个原因：

1. 库的 `handleToNative` 会把 guest 的值**反向构造为真实宿主对象**（数组 → `[]`、对象 → `{}`、
   函数 → 宿主闭包、Error → 宿主 `Error` 实例），并且用 `Object.defineProperty` 按 guest 提供的键名逐个落属性
   —— 等于「宿主对象图的形状」由 guest 决定。只回字符串就把这条路径彻底关掉。
2. 实测 `handleToNative` 处理**任何**非原始值时都会漏句柄，导致 QuickJS runtime 无法释放，
   最终在 `JS_FreeRuntime` 触发 `list_empty(&rt->gc_obj_list)` 断言、abort 掉整个进程。
   （也就是说：修复前 `return { a: 1 }` 会让子进程直接崩。）

**`console.*` 走同一条规则。** 早先只把 `hostLog` 直接交给库，于是 `console.log({})` 的实参
同样要经过 `handleToNative`；对象/数组侥幸没炸，但 `console.log(function foo(){})`
（把一个 guest 函数交给宿主回调 → 宿主闭包）会让子进程 abort，
一行代码就换掉一个进程。现在 harness 在 guest 内重写了 `globalThis.console`：
所有宿主注入的方法都被包一层，先把实参格式化成**字符串**再回调宿主。

`JSON.parse` 之后还要过一层 `sanitize.js`：深度 ≤ 8、节点 ≤ 4000、数组 ≤ 500、键 ≤ 200、
单串 ≤ 128K，并丢弃 `__proto__` / `constructor` / `prototype` 键；超过 256K **字节**时换成
`{ truncated, size, preview }`（而不是截断出一段残缺 JSON）。子进程与父进程**各做一次**。

体积上限一律按 **UTF-8 字节**：帧传输按字节限长，而 `JSON.stringify` 不转义中文
（一个汉字 3 字节）。早先按字符数判断，20 万个汉字的中文结果就能撑爆 1MB 的帧，
被父进程判成协议异常并强杀 —— 正常返回大量中文也会踩到。

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

- 不能使用 `export`，单段代码受 `limits.maxCodeBytes` **字节**（UTF-8）限制；
  zod schema 同样按字节校验，不会出现「校验放行、沙箱再拒」。
- 返回值必须是 **JSON 可序列化**的：`BigInt`、循环引用会返回 `UnserializableResult` 错误
  （在沙箱内就被拦下，不会带崩进程）。

### 代码是**编译**的，不是拼进源码的

harness 用 `JSON.stringify(code)` 把代码变成字符串字面量，再交给 `AsyncFunction` 编译：

```js
const __code = "用户代码（已转义）";
const fn = new (Object.getPrototypeOf(async function () {}).constructor)(__code);
const value = await fn();
```

早先是 `await (async () => {` + code + `})()` 直接拼接，写一句
`})(); throw new Error("assertion failed"); (async () => {` 就能提前闭合内层函数、
把代码挪到外层 `try`，甚至摸到 harness 里的 `__emit` / `__encode`。

副作用：`AsyncFunction` 的函数体是**宽松模式**且在全局作用域编译，
所以用户代码看不到 harness 的任何绑定（这正是我们要的），但 `this` 从 `undefined`
变成了 `globalThis`，`"use strict"` 也不再默认生效。顶层 `await` 仍然可用。

## 配置

见 [`config.json`](./config.json)，改完需 `/neonaic:reload` 并重启拓展（与其它通道类拓展一致）。
