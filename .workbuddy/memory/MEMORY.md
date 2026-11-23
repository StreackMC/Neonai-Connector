# Neonai-Connector 项目长期记忆

## 概览与代码约定
- **Neonai-Connector** — Node.js (ESM) 服务端，与「澪奈 (Neonai)」沟通的桥梁；显示名取 `config/main.json` 的 `name`/`subname`。License **AGPL-3.0 + 附加条款**（禁止复用美术资源、禁止把 "Neonai"/「澪奈」当自身品牌）。
- 分层：`src/{system,logger,command,message,event,platform,extension,utils}/`（内核）＋ `extensions/`（拓展）。`main.js` 瘦入口，`debug.cjs` 调试入口（非 TTY 下 `$("cmd")` 模拟 CLI）。错误统一抛 `Neonaic*Error`，不抛裸 `Error`。
- 函数/常量**只导出单个命名空间对象**（`export const neonaicXxx = {...}`）；**类一律 `export class`，不嵌套**；camelCase（含 extensions）。例外只有 `chore.parseString`、`Logger.getLogger()`、`log4js_inject.configure`。对象字面量放文件**末尾**（`class` 不提升 → TDZ）；JSDoc 类型引用写 `import('./x.js').类名`，**不写悬空 `{@link}`**。
- **单文件过大就拆成同名目录 + 兼容入口**：`src/message/ai.js` 现在只有 8 行（`export { neonaicAI } from './ai/index.js'`），实现在 `src/message/ai/`（`prompt` / `toolRegistry` / `toolPattern` / `providerTools` / `multimodal` / `callProvider` / `caller` / `ask` / `commands` + `index` 汇总）。`index.js` **必须 import `commands.js`**——命令靠 import 副作用自注册，删了它 `ai` 命令就消失。
- ⚠️ **内核不得出现任何拓展名**（解耦硬判据）：判断标准是「本体是否只在某拓展存在时才有意义」。拓展专属合成执行者（`$joyous`）必须定义在拓展内，**不得写进内核 `COMMAND_ENUMS`**；`$` 是内核保留的合成身份命名空间（内核只占 `$console`/`$unknown`）。反例：`NeonaicProtocolError` 这类**通用词汇**进内核不算耦合。
- ⚠️ 常见实现坑：`extends` 了 `*Newable` 的类必须 `super()` 且早于任何 `this` 访问（漏了直接 ReferenceError）；`net.connect({path})` 失败是**异步 `emit('error')`、不抛**；ESM **私有字段不能跨类访问**（子类 `this.#x` 会在解析期报错，每个类必须自己声明）。

## 系统层 / 生命周期（`src/system/lifeCycleManager.js`）
- **内核级常量全归管理器**：`DEBUGING`、`ROOT_PATH`、`APP_NAME`、`APP_VERSION`、`PID_FILE_PATH`、`ANSI`。
- **保活由管理器持有**（`startKeepAlive`/`stopKeepAlive`，ref 的 1h 空 `setInterval`）。**不能**放 `cliProcessor`（非 TTY 下 `startCLI()` 提前 return 会连带丢保活）；**不要** `process.stdin.resume()`（抢输入流）。
- 状态机 `idle → running → stopping → stopped`：`start()`/`stop()` 幂等（重复 stop 返回**同一个 Promise**）；`stopped` 后再 start 抛 `NeonaicIllegalStateError`。
- 关闭编排：`registerCloser(name, fn)` 存 Map，**后注册先执行**；单步抛错只记报告不中断；`shutdown()` = `stop()` + 5s 兜底 + `exit(0)`。entry 注册序 `pid-lock → platforms → extensions → cli`，执行序相反。
- ⚠️ **保活必须最后再停**：先停保活再跑 closers，若 closer 只 await 已 resolve 的 Promise，事件循环立刻空转退出，后续关闭全跑不到。
- ⚠️ **`main.js` 不能 `process.exit(0)`**：必须 `await bootstrap()`，否则异步启动被截断（日志停在「正在加载可用拓展」、退出码却 0）。`bootstrap` 抛错现在会真的以 1 退出并打印 `[FATAL]`。

## 内核要点
**NeonaicConfig**：五种 `WRITE_MODES`（**默认 AUTOSAVE＝赋值即落盘**）、自动重载 + `onAutoReloaded`/`onLoadFailure`、`reload`/`getFile`、`isExist`/`remove`、类型化 getter/putter、`getSection`（浅拷贝）、链式、原子写入、`\.` 转义点号、静态 `fromObject`/`fromJSON5`。只支持 JSON5。
- ⚠️ **`getConfig(path)` 按原始字符串缓存**：`'./x.json'` 与 `'x.json'` 是两个实例；测试必须用与生产**逐字相同**的路径；缓存实例**不会**因外部改写自动重读。
- ⚠️ **`getList(key, def = [])`/`getString(key)` 要显式传默认值**，否则「字段缺省」得到 `[]`/`undefined`，被归一化层误判成「用户写了空值」并记 issue。
- ⚠️ 写出的是 **JSON5**（键无引号、单引号），读回要 `JSON5.parse`；嵌套路径**不能下探数组**。macOS 大小写不敏感，`import './AI.js'` 这类错误本地不报、**Linux 必炸**。

**命令系统**：`registerCommand(ns, name, handler, opts)`，import 时自注册，`this` 是 `NeonaicCommandContext`。opts：`alias`/`permissions`/`description`/`usage`/`permissionDefault`。输入解析全仓库只有一份 `resolveCommandArgs(input, prefixes?, trim)`：省略 `prefixes` 时与旧 `parseArgs` 一致；传了 `prefixes` 而**无一匹配返回 `null`**（交给 AI 兜底）；长度 0 的 token 被丢弃（既有行为）。

**权限系统**（`command/permissionServer.js`）：4 层（临时 > 永久按用户 > 全局临时 > 全局永久）；执行者链 `["USR#x","GRP#y"]` 从左继承，末尾隐式 `*`。
- **表达式**：叶子=字符串（可带 `!` ＝须缺失）；数组=分组，语义**按嵌套深度交替**（0 层 AND → 1 层 OR → 2 层 AND…；`[[[a,b],c]]` = (a AND b) OR c）。`[]` 恒 true、`[[]]` = false。
- **无 null 三态**：三个 check 都是 `(…, fallback = false)` **恒返回布尔**；未设置时取 `fallback`，**之后**才施加 `!`。`undefined`/`''`/`'*'` 恒 false。`getSinglePermissionStatus` 返回 `{status, scope, permanent}`（**不是布尔**）。
- `checkPermissionFromContext` 在 `ctx.internalCall` 时**直接放行** ⇒「能执行代码/能代理」这类不该免检的场景要用 `checkPermission(ctx.executor, …)`。
- ⚠️ `commandServer.js` 写 `permissions: perms` **不复制数组**（外部改原数组即可改已注册命令的权限）。

**扩展系统**：`extLoader.js`（`NeonaicExtItem`）｜`extManager.js`。`scan()` 返回 `Map<id, item>`（公开访问器只有 `export`/`manifest`/`name`/`id`/`fullname`/`enabled`）。payload = `{operation, status, error, id}`（`operation` ∈ `load|unload|enabled|disabled`；`status` ∈ `notfound|successfully|failed|disabled`）；批量 = `{operation, succeed, notfound, disabled, failed}`。
- **`load`/`unload` 管运行期，`enable`/`disable` 管 `ext.json` 开关**，两套语义正交。⚠️ **`load` 会吞 onEnable 异常并返回 `status:'failed'`**（不 throw）⇒ 验证 onEnable 必须检查返回值或直接调 `entry.onEnable()`。
- 布局：`extensions/<name>/src/*.js` + 同级 `manifest.json`（`entry: ./src/entry.js`）；`meta.id` 须匹配 `^[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)*$`（**不能带连字符**，目录名可以）。⚠️ id 带连字符会让**整个拓展静默不加载**（只 warn 一条）；排查 `for f in extensions/*/manifest.json; do grep '"id"' "$f"; done`。
- 拓展内导入内核用相对路径（顶层拓展 `../../../src/...`；joyous 的 `protocol/` 是 `../../../../src/...`），也可用 `#src/*`（见下）。`enable()` 要求入口同时导出 `onEnable`/`onDisable`。

## 模块细节（不注入，按需 Read）

`.workbuddy/memory/MEMORY-details.md` 收着各模块的实现细节与踩坑记录，动手前先看对应小节：

- **表格 / 矩阵 / 算式** — `NeonaicTable` 五种数据源与表头推断、`NeonaicMatrix`、`toNumber` 负号、两张常量表、`calc`/阶乘/BigInt 定点引擎
- **消息片段** — 18 种 TYPE、块级补空行、样式与空白定界符、`br`=强制分段、`NESTING` 数据表、列表用 `[][]`、媒体基类
- **Joyous 桥接** — 双通道传输、握手角色、指数退避、方法表、两套授权、自助命令、绑定表
- **AI 调用链** — `askAI` 选项、Profile 结构、`AIlist` 顺序语义、工具上下文注入、多模态降级规则
- **qqbot** — 一帧多 emit 的「让出 + 认领」、`sub_type` 不可用、转换层、`#src/` 版本差异、测试脚本
- **aicode 沙箱** — 削峰阶梯、交付即占用、私用管道分帧、guest 只回字符串、权限模型实测边界
- **小游戏** — Wordle/24 点的结算语义

## 配置 / git / 硬约束
- `config/main.json` — 名称、`prefix`、`maxLogFileSize`、`detailedLog`、`ai.*`；`config/prompts/<profile>.md` 提示词（**gitignore**）。**`config/saves` 整目录 gitignore**，但 `ext.json`/`permissions.json` 因规则加入前已跟踪而仍在版本控制；新增文件（`identities.json`、`joyous-identities.json`）不会入库。根 `secret.json` 是真凭据（gitignore），`config/secret.json` 是模板（入库）。
- ⚠️ 拓展自带 `extensions/<name>/config.json` **已入库**且用户会填自己的部署参数 ⇒ 自检**不要依赖它的内容**，要自带配置。
- **⚠️ NeonaicConfig 默认 AUTOSAVE**：任何 `put*`/`set`/`remove` 立即落盘 ⇒ 测试脚本**绝不要指向真实配置文件**。
- Git 按全局**权责边界**（见 `~/.workbuddy/MEMORY.md`）：身份 `Neonai <neonai+coding@kdxiaoyi.top>`（仅 `git -c` 携带）；Conventional Commits 中英双语；**必须主动提交自己的改动**，只 add 本次任务产出的文件（含 `.workbuddy/memory/`）；**不提交无关代码，不做 push/pull/fetch/rebase/merge**。

## 沙箱自检 / 编辑器陷阱
- 零污染配方见技能 `side-effect-test-isolation`、`js-selfcheck-script-mechanics`、`cross-process-bridge-design`、`bigint-fixedpoint-math-engine`。要点：`rsync` 真实仓库到沙箱（**`src/` 必须复制不能软链**，否则 `ROOT_PATH` 自算指回真实根）+ 软链 `node_modules`；**改完源码必须重新 rsync**；沙箱内改权限用 `setPermission`/`clearPermission`（写文件对已加载内存态无效）；JSON5 打补丁锚定小节正则（**不能按「相邻两行」匹配**）；`import(x + '?bust=1')` 会造出**新模块实例**。
- 拓展文件导入内核的 `#src/*` 由**最近的 package.json** 解析 ⇒ 把探针副本放在项目内的临时目录（`extensions/.probe/`）就能直接跑到真实依赖，跑完删掉。
- `jsconfig.json` 的 `include` 必须写 `src/**/*.js`（`src/**.js` 匹配 0 个文件，自动 import / 跨文件补全全失效）；`extensions/**/*.js` 也要显式加；需 `module/moduleResolution: NodeNext` + `importModuleSpecifierEnding: "js"`。

## 已知待办
- **`commandServer.js` 的 `executeCommand`/`executeCommandSilent` 只拦同步异常**：async 处理器抛出的拒绝会逸出、不被包成 `NeonaicCommandError`（影响全项目所有 async 命令）。
- `extLoader.js` 的 `disable()` 无空守卫；`replaceAll('.', '\.')` 是空操作，且键名用 `.enabled` 而 `ext.json` 样例写 `enable`。
- `src/utils/registerUtilsSupport.js` 的 `neonaic:webfetch` 已正常实现（走 `neonaicNetwork.fetch` + `NeonaicUriMeta.resolve`，不是当年那个 `new URL(address)` 半成品）；`entry.js` 的 `checkPermissionFromContext(this)` 只传 1 个参数，`systemLine` 永远为空；`NeonaicUriMeta.js:184` 的 `{@link resolveUri}` 悬空。
- `NeonaicTable.toCsv()` 仍未按 RFC4180 转义（只转义 `|`）。
- Joyous Java 侧需按 `PROTOCOL.md` 实现 UDS 才能真联调。
