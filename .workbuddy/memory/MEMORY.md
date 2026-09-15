# Neonai-Connector 项目长期记忆

## 概览

- **Neonai-Connector** — Node.js (ESM) 服务端，与「澪奈 (Neonai)」沟通的桥梁；显示名取 `config/main.json` 的 `name`/`subname`。
- **License** AGPL-3.0 + 附加条款（禁止复用美术资源、禁止把 "Neonai"/"澪奈" 当自身品牌）；仓库 `git@github.com:StreackMC/Neonai.git`。

## 架构

三层 + 组合根 + 依赖注入：`src/{system,logger,command,message,platform,extension,utils}/` 各司其职（system 含 entry 组合根、confManager、cliProcessor、pidManager、watchdog、restartProcess），拓展在 `extensions/`。具体模块名以 `ls` 为准。

- `main.js` 瘦入口（仅 `neonaicEntry.bootstrap()` + 兜底错误）；`debug.cjs` 调试入口，非 TTY 下用 `$("cmd")` 模拟 CLI。
- 错误统一抛 `NeonaicNewableError.js` 的 `Neonaic*Error`（IllegalState/IllegalArgument/IO ↔ Java 同名），不抛裸 `Error`。

## 模块导出约定（强制）

- 函数/常量**只导出单个命名空间对象**（`export const neonaicXxx = { ... }`）；**类一律 `export class`，不嵌套**；命名统一 **camelCase**（迁移已完成，含 extensions 侧）。
- **顶层具名导出的例外**（高频调用点语法糖，不重复放进对象）：`chore.js` 的 `parseString`（**`text.js` 已并入 `chore.js`**，另导出 `neonaicChore`）、`Logger.js` 的 `getLogger()`；`log4js_inject.js` 的 `configure` 是 appender 硬性要求。
- 对象字面量放文件**末尾**（`class` 不提升，提前引用 TDZ）；JSDoc 类型引用写 `import('./x.js').类名`（路径相对当前文件）。
- 只有类的模块没有对象导出（`platformInterface.js`、`NeonaicUriMeta.js`）。Worker 入口没有导出（它不是被 import 的模块）。

## NeonaicConfig（SConfig.java 的 JS 移植）

- 已实现 SConfig 的全部特性（写入模式 / 自动重载与回调 / 类型化读写含 `Date` 版日期时间 / 段落与列表 / 链式 / 原子写 / `_root_array` / `\.` 转义点号 / 静态工厂），逐项见文件头注释。
- **默认 AUTOSAVE**（写入模式之一，见「注意事项」）。有意不做：多格式（只 JSON5）、注释、RootName、BigDecimal。与 Java 差异：无锁、`getBoolean` 是超集、保存后同步自身 mtime、`getFile(true)` 写入当前内容。

## CLI 命令系统

`neonaicCommandServer.registerCommand(namespace, name, handler, opts)`；各模块 import 时自注册，handler 的 `this` 是 `NeonaicCommandContext`（`handler.call(ctx, ...args)` 展开）。opts：`alias`/`permissions`（第一层 AND、第二层 OR，`!perm` 须缺失）/`description`/`usage`；引用支持 `name`/`alias`/`ns:name`/`ns:alias`。内置命令见 `neonaic:help`；拓展注册 `joyous:mc`、`qqbot:qbsend`、`wordle:wordle`(wd)、`twentyfourpoints:24`(tf/tfp/twentyfour)。原则：声明式、子模块互不引用、惰性单例、优雅关闭（5s 超时）。

## 看门狗与进程重启（`src/system/watchdog*.js`）

- 三个文件：`watchdog.js`（主进程侧：读配置、喂狗、退避记账、`restart()`）、`watchdog.worker.js`（Worker 侧：判定与强杀）、`restartProcess.js`（共用「拉起新进程」，只依赖 `child_process`）。
- **判定必须放在 Worker**：主线程被同步代码卡死时，它自己的 `setTimeout` 也不触发，同线程看门狗永远发现不了。
- 流程：按期 `feed()`（默认 10s）→ 超过 `timeoutMs`（默认 120s）没喂 → Worker 报 `stalled` → 等 `graceMs`+退避 → 期间恢复喂狗则 `recovered` 取消，否则 `killing`：拉起新进程 + `SIGKILL` 自己。
- 配置在 `config/main.json` 的 `watchdog` 段（enabled/timeoutMs/feedIntervalMs/graceMs/backoff*），全有默认值。**调试模式不启动看门狗**（断点会长时间阻塞事件循环，会被误判成卡死）。
- 退避：状态存项目根 `.neonai.watchdog.json`（已 gitignore），`nextDelay(n)` = 1s×2^(n-1) 封顶 5min；稳定运行超过 `backoffResetMs` 归零；人工重启清零。
- 「接棒」：新进程带 `NEONAIC_RESTART`，启动时先 `neonaicPidManager.waitForHandover()` 等旧实例交出 PID 锁。重启顺序 **spawn → 释放锁 → 清理 → exit**，拉不起来就不退位。
- Worker 的三个硬约束：**`process.argv` 指向 Worker 自己的入口**（重启命令必须由主线程经 `workerData` 传）、**`execArgv` 会被继承**（`--input-type` 会让 Worker 起不来）、**不能 import 重模块**（会经 `chore → confManager` 把配置与日志拖进线程）。

## 扩展系统

- 加载器 `extLoader.js`（`NeonaicExtItem`+`neonaicExtensionLoader`）、管理器 `extManager.js`（`neonaicExtensionManager`）；**已接入 `entry.js`**：`loadAll([...(await scan()).keys()])`，失败项逐条 error 输出。
- API：`scan(root)`/`list`/`find`/`load`/`unload`/`loadAll`/`unloadAll`/`enable`/`disable`/`enableAll`/`disableAll` + getter `root`/`size`/`ids`；子命令同名，另多一个 `info <ext>`，省略拓展名即对全部操作。
- **返回结构以文件里的 `@typedef` 为准**（用户写的，改实现前先读）：payload = `{ operation, status, error, id }`，`operation` ∈ `load|unload|enabled|disabled`（enable/disable 用**过去分词**），`status` ∈ `notfound|successfully|failed|disabled`（`disabled` 只在 `operation='load'`）；批量 = `{ operation, succeed, notfound, disabled, failed }`，**没有 `affected`**。
- **两套语义正交**：`load`/`unload` 只管运行期（`unload` 标 `@deprecated`）；`enable`/`disable` 只管 `ext.json` 开关、**默认不改运行状态**。
- **布局**：`extensions/<name>/src/*.js` + 同级 `manifest.json`（`entry` 写 `./src/entry.js`）；`meta.id` 须匹配 `^[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)*$`（**不能带连字符**，目录名可以）。`enable()` 要求入口同时导出 `onEnable` 与 `onDisable`；开关存 `ext.json` 的 `<id>.enabled`（缺省 true）；拓展内导入内核用 `../../../src/...`。

## 拓展：Wordle

- 文件：`entry.js`（命令层）、`session.js`（对局与难度）、`word_provider.js`（词表）。命令 `wordle:wordle`（`wd`/`wl`）；难度别名**刻意不收单字母 `h`**（与「查看历史」冲突），规则细节见代码。
- 猜中那行在 `#triesResult` 里存的是 `'right'` **字符串**而非数组，推导与渲染都要展开成全绿。
- 参数解析：`sub = args[0]` 判子命令、`param = args.join('')` 判猜测。**不要只看 join 后的整串**，否则 `/wd new hard` 拼成 `newhard`、`new` 分支永不触发。无对局时 `hard`/`uhard` 按该难度开局、5 字母则普通开局并当第一次猜测。
- **字母判定按份数结算**（两趟：先认领绿格份额，再按剩余份额判黄，用尽才判白）。**因果必须记住**：修好后 `missing` 不再等于「答案里没有该字母」（`posse` 猜 `bokos`，第 4 个 `o` 是白但确实在答案里，份额被绿格用光），因此 `#constraints().white` **必须剔掉已在绿/黄中出现过的字母**，否则极限模式的「白字母不得再现」会误封正确字母、局面无解（实测 400 局中 56 局失败）。
- 会话那套（私有 Map + 超时清理器 + 魔术 token 构造器 + **幂等 `usable` setter**）**新拓展照抄即可**。

## neonaicMath（`src/utils/math.js`）

- `calc(expr, options)` — 递归下降算式求值，**参数不能叫 `eval`**（ESM 恒严格模式 → `SyntaxError`）。优先级：加减 → 乘除模 → 一元正负 → 幂（右结合，`-2^2`=-4、`2^-3` 合法）→ 根号 → 括号/数字；除号 `/` 与 `÷` 等价，乘号还收 `×`/`·`，全角符号与数字自动折算，`**` ≡ `^`。
- `options` 三项**默认全 false**（只解析四则）：`power`/`root`/`mod`。**紧跟根号的整数（含上标）一律当次数**，故 `2√9` = 3 而非 `2*√9`。语法错误抛 `NeonaicIllegalArgumentError`（带位置），除数为零 / 负数开偶次方抛 `NeonaicArithmeticError`。
- `solve24(numbers, target=24)` — DFS 二叉树穷举，Set 按算式文本去重（`+`/`*` 先按字典序规范再拼接，消交换律重复；`-`/`/` 两种顺序都留）。**正确性用文献值校准过**：1–13 的 1820 种牌型里 1362 有解 / 458 无解（25.16%）。内部 `clamp(toNumber(n), 1, MAX_SAFE_INTEGER)`，**0 与负数被静默改成 1**，调用方要先校验。
- `random` 已由 `Math.round` 改为 `min + Math.floor(Math.random() * (max - min + 1))`：原写法让 **min/max 各只有一半概率**（wordle 选词首尾、24 点 A 与 K）。

## 拓展：24 点（`extensions/twenty-four-points/`）

- id `twentyfourpoints`（目录名带连字符但 id 不行），命令 `24`，别名 `tf`/`tfp`/`twentyfour`；**命令名含数字没问题**。文件：`src/entry.js` + `src/session.js` + `manifest.json`。
- 规则：4 个数取自 1–13（扑克 A–K），**允许重复、不保证有解**；**每局只有一次机会**（`invalid` 不消耗）。子命令 `help` / `new` / `<算式>` / `?|无解|insoluble` / `stop|放弃` / `solve 1 2 3 4 [target]` / 作弊 `win`（需管理员）。
- **用户自己在迭代它**（超时改 10 分钟、`MAX_LISTED_IN_GAME = 5`、`solve` 支持第 5 参数作目标值、有对局时 `solve` 被拒、调试用作弊命令）→ 行为**以代码为准**，记忆易过时。
- 文案被反复润色（`🎉`→`✓`、`🎴 新的 24 点牌局`→`→ x y z w ←`）→ **测试断言按语义关键词写，别绑死措辞**（绑死文案曾一次性造成 32 项假失败）。
- `joined = args.join('')` 使算式被空格拆开也能解析；裸命令要单独判，否则走成「没有收到算式」。

## 配置文件

- `config/main.json` — 名称/次名、`prefix`、`maxLogFileSize`、`detailedLog`、`moderate`、`watchdog`（JSONC）；`config/saves/{permissions,ext}.json` 运行时写入；`config/prompts/<profile>.md` 各 AI Profile 提示词（**gitignore**）。
- `config/secret.json` — 模板（假 key，**入库**）；`secret.json`（根目录）— 真凭据（**gitignore**）。根目录还有 `.neonai.pid` 与 `.neonai.watchdog.json`（运行时，均 gitignore）。

## 编辑器 / 语言服务

- `jsconfig.json` 的 `include` 必须写 `src/**/*.js`。**`src/**.js` 与 `src/**` 匹配 0 个文件**（TS 的 `**` 必须自成路径段 `/**/`），会让项目只剩 `main.js`，除静态可达文件外所有自动 import / 跨文件补全失效；`extensions/**/*.js` 也必须显式加进去（拓展靠运行时动态 `import()`，静态追不到）。
- 需设 `module`/`moduleResolution` 为 `NodeNext`，并在 `.vscode/settings.json` 设 `importModuleSpecifierEnding: "js"`（否则无后缀导入在 Node ESM 下 `ERR_MODULE_NOT_FOUND`）。

## 注意事项

- **⚠️ NeonaicConfig 默认 AUTOSAVE**：任何 `put*`/`set`/`remove` **立即落盘**。测试脚本**绝不要指向真实配置文件**，用临时副本或先 `setWriteMode('inertia')`（已踩过：测试键写进了 `config/saves/ext.json`）。
- NeonaicConfig 写出的是 **JSON5**（键无引号、单引号字符串），读回要 `JSON5.parse`；嵌套路径**不能下探数组**（`a.0.b` 退化成顶层字面键），`isReachable` 可提前发现退化。
- macOS 大小写不敏感，`import './AI.js'` 这类大小写错误本地不报、**Linux 上必炸**。
- Git 提交按用户全局约定（`NeoNai <neonai+coding@kdxiaoyi.top>`，仅 `git -c` 携带不写 config；Conventional Commits 中英双语；只 add 必要文件）。
- 本地跑真实 `bootstrap()` 前先看 `.neonai.pid`：可能已有实例在跑，抢锁会直接失败（干跑请用临时副本）。

## 已知待办

- `extLoader.js` 两处：`disable()` 无空守卫（`#instance` 为 null 时 `unload` 必抛）；`replaceAll('.', '\.')` 的转义是空操作。
- `ai.js` 的 `neonaic:webfetch` 是半成品：`uri = new URL(address)` 赋给未声明变量（ESM 恒严格模式必抛，被 catch 吞掉）。
- `entry.js` 的 `neonaic:version` 里 `checkPermissionFromContext(this)` 只传 1 个参数（签名 `(ctx, permission)`），`systemLine` 永远为空。
