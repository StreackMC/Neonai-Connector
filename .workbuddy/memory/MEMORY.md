# Neonai-Connector 项目长期记忆

## 概览与架构
- **Neonai-Connector** — Node.js (ESM) 服务端，与「澪奈 (Neonai)」沟通的桥梁；显示名取 `config/main.json` 的 `name`/`subname`。License **AGPL-3.0 + 附加条款**（禁止复用美术资源、禁止把 "Neonai"/「澪奈」当自身品牌）。
- 组合根 + 依赖注入：`src/system/`（entry、**lifeCycleManager**、confManager、cliProcessor、pidManager）｜`logger/`｜`command/`（commandServer、permissionServer、commandInterface）｜`message/`（ai、messageIn、userDirectory）｜`event/`｜`platform/`｜`extension/`（extLoader、extManager）｜`utils/`（NeonaicConfig、NeonaicNewableClass、NeonaicNewableError、NeonaicUriMeta、io、chore、math）；拓展在 `extensions/`。`main.js` 瘦入口，`debug.cjs` 调试入口（非 TTY 下 `$("cmd")` 模拟 CLI）。错误统一抛 `Neonaic*Error`（IllegalState/IllegalArgument/IO/Protocol/Network ↔ Java 同名），不抛裸 `Error`。
- 函数/常量**只导出单个命名空间对象**（`export const neonaicXxx = {...}`）；**类一律 `export class`，不嵌套**；camelCase（含 extensions 侧）。例外只有 `chore.js` 的 `parseString`、`Logger.js` 的 `getLogger()`、`log4js_inject.js` 的 `configure`。对象字面量放文件**末尾**（`class` 不提升 → TDZ）；JSDoc 类型引用写 `import('./x.js').类名`，**不写悬空 `{@link}`**。

## 系统层 / 生命周期（`src/system/lifeCycleManager.js`）
- **内核级常量全部归管理器**：`DEBUGING`、`ROOT_PATH`、`APP_NAME`、`APP_VERSION`、`PID_FILE_PATH`、`ANSI`（cyan/dim/bold/reset）。`entry.js` 只做本地解构取用，`neonaicEntry` 保留同名转发（外部无消费者，只是向后兼容）。
- **保活由管理器持有**（`startKeepAlive`/`stopKeepAlive`）：一个 **ref 状态的 `setInterval`**（1h，空回调），`keepAliveActive` 可查。**不能**放在 `cliProcessor`：非 TTY 下 `startCLI()` 提前 return 会连带丢保活，`stopCLI()` 会连进程生命周期一起停掉。也**不要**用 `process.stdin.resume()`（抢输入流、与 readline 打架）。
- **状态机** `idle → running → stopping → stopped`：`start()` 幂等（第二次返回 false）、`stopped` 后再 start 抛 `NeonaicIllegalStateError`；`stop()` 幂等（重复调用返回**同一个 Promise/报告**）。
- **关闭编排**：`registerCloser(name, fn)` 存入 Map（后注册先执行），`stop()` 反向遍历、单步抛错只记进报告不中断，`shutdown()` = `stop()` + 超时兜底（5s，`unref` 定时器）+ `process.exit(0)`。注册顺序在 entry 里是 `pid-lock → platforms → extensions → cli`，实际执行 `cli → extensions → platforms → pid-lock`。
- ⚠️ **保活必须最后再停**：`runStop` 里若先 `stopKeepAlive()` 再跑 closers，当 closer 只 await 已 resolve 的 Promise 时事件循环会立刻空转退出，后面的关闭步骤永远跑不到。
- ⚠️ **`main.js` 不能 `process.exit(0)`**：必须 `await bootstrap()`，否则异步启动被截断（日志停在「正在加载可用拓展」，退出码却是 0，且 PID 锁被 exit 钩子清掉，排障极难）。`bootstrap` 抛错（如 PID 锁冲突）现在会真的以 1 退出并打印 `[FATAL]`。
- 卸载拓展现在走 closer（`unloadAll()`），会执行各拓展 `onDisable`——顺带暴露了 `twenty-four-points` 的缺 import（`getAllSessionUser`）。

## 内核要点
**NeonaicConfig**：五种 `WRITE_MODES`（**默认 AUTOSAVE**）、自动重载 + `onAutoReloaded`/`onLoadFailure`、`reload`/`getFile`、`isExist`/`remove`、全套类型化 getter/putter、`getSection`（浅拷贝，非对象回退 `def`）、链式、原子写入、`\.` 转义点号、静态 `fromObject`/`fromJSON5`。有意不做：多格式（只 JSON5）、注释、RootName、BigDecimal。
- ⚠️ **`getConfig(path)` 按原始字符串缓存**：`'./x.json'` 与 `'x.json'` 是**两个实例**；测试里改配置必须用与生产**逐字相同**的路径（如 `joyousConfig.CONFIG_PATH`）。缓存实例**不会**因外部改写自动重读，要显式 `reload()`。
- ⚠️ **`getList(key, def = [])`/`getString(key)` 要显式传默认值**：不传时「字段缺省」得到 `[]`/`undefined`，会被归一化层误判成「用户写了空值」并记 issue（已在 joyous `bridge.ai.AIlist` 踩过）。
- ⚠️ 写出的是 **JSON5**（键无引号、单引号），读回要 `JSON5.parse`；嵌套路径**不能下探数组**。

**命令系统**：`registerCommand(ns, name, handler, opts)`；import 时自注册，handler 的 `this` 是 `NeonaicCommandContext`（`handler.call(ctx, ...args)`）。opts：`alias`/`permissions`/`description`/`usage`/`permissionDefault`。**输入解析全仓库只有一份 `resolveCommandArgs(input, prefixes?, trim)`**：省略 `prefixes` 时与旧 `parseArgs` 逐字一致；传了 `prefixes` 而**无一匹配返回 `null`**（＝「不是命令」，交给 AI 兜底）；其余恒为 `[命令名, 参数]`。既有行为（非 bug）：**长度为 0 的 token 被丢弃**。

**权限系统**（`command/permissionServer.js`）：4 层存储：临时 > 永久（按用户）> 全局临时 > 全局永久；执行者链 `["USR#x","GRP#y"]` 从左到右继承，末尾隐式 `*`。
- **表达式**：叶子=字符串（可带 `!` ＝须缺失）；数组=分组，语义**按嵌套深度交替**（第 0 层 AND → 第 1 层 OR → 第 2 层 AND…；`[[[a,b],c]]` = (a AND b) OR c）。`[]` 恒 true、`[[]]` = false。
- **无 null 三态**：`checkPermission`/`checkSinglePermission`/`checkPermissionFromContext` 均 `(…, fallback = false)` **恒返回布尔**；未显式设置时取 `fallback`，**之后**才施加 `!`。`undefined`/`''`/`'*'` 恒 false。`checkSinglePermission` 只收**单个**用户字符串；`getSinglePermissionStatus` 返回 `{status:'true'|'false'|'unset', scope, permanent}`（**不是布尔**），perm 不可带 `!`。
- `checkPermissionFromContext` 在 `ctx.internalCall` 时**直接放行**。⚠️ `commandServer.js` 写 `permissions: perms` **不复制数组**（外部改原数组即可改已注册命令的权限）。

**扩展系统**：`extLoader.js`（`NeonaicExtItem`）｜`extManager.js`。`scan()` 返回 `Map<id, NeonaicExtItem>`（item 公开访问器只有 `export`/`manifest`/`name`/`id`/`fullname`/`enabled`）。返回结构以文件 `@typedef` 为准：payload = `{operation, status, error, id}`（`operation` ∈ `load|unload|enabled|disabled`，enable/disable 用过去分词；`status` ∈ `notfound|successfully|failed|disabled`）；批量 = `{operation, succeed, notfound, disabled, failed}`。
- **两套语义正交**：`load`/`unload` 只管运行期；`enable`/`disable` 只管 `ext.json` 开关。⚠️ **`load` 会吞掉 onEnable 异常并返回 `status:'failed'`**（不 throw）⇒ 验证 onEnable 必须**检查返回值**或直接调 `entry.onEnable()`。
- 布局：`extensions/<name>/src/*.js` + 同级 `manifest.json`（`entry` 写 `./src/entry.js`）；`meta.id` 须匹配 `^[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)*$`（**不能带连字符**，目录名可以）；拓展内导入内核用 `../../../src/...`。`enable()` 要求入口同时导出 `onEnable`/`onDisable`。会话式拓展模板：私有 `Map` + 超时清理器 + 魔术 token。

## 表格 / 矩阵（`utils/math.js` 的 `NeonaicTable` / `NeonaicMatrix`）
- 五种数据源：`object-row`（对象数组，键＝列名）、`object-col`（列对象 / 对象数组，键＝行名）、`csv`、`markdown`、`array[]`。`option.rows/cols` 与数据冲突时**按 option 来**（小则截断、大则补空；矩阵补 0）。
- **表头**：`option.header` ∈ `true|false|'auto'`（默认 `auto`），只对 `csv`/`markdown`/`array[]` 生效。**`auto` 只在 Markdown 上推断**——分隔行紧跟首行 ⇒ 首行是表头；CSV 首行没有任何语法线索，一律视为数据（猜错会吞掉一整行真实数据），需要时必须显式 `header: true`。
- **冲突裁决：option 优先**。文本源自带表头 + `option.colTitle` ⇒ 标题用 option，表头行**仍然从数据中移除**（否则同一份标题出现两次）。object 源的键序与 option 标题序冲突 ⇒ **按 option 重排原始数据**（键→列有映射）；文本源标题是位置性的，只能整体覆盖、无法重排。
- 列数取「数据最大宽度」与「表头行宽度」的较大者（否则只有表头的表会被判成 0 列、标题被 `normalizeTitles` 截成空数组）。`colTitle`/`rowTitle` 接受数组或单值（单值曾被 `Array.isArray` 静默丢弃）。
- ⚠️ **`math.js` 的 import 顺序有讲究**：`NeonaicNewable` 必须写在 `NeonaicNewableError`/`chore` **之后**，否则本文件成了既有环（NewableClass ↔ Error ↔ chore → confManager → NeonaicConfig → NewableClass）的入口，直接 `import` 即 TDZ。
- ⚠️ `toCsv()` 的转义是错的（转义 `|` 而非 `,`/`"`），含逗号的单元格导出后无法原样解析；且 `toCsv` 写出标题行后，重新解析**必须**显式传 `header: true`。
- `NeonaicMatrix`：`rank` 已实现（高斯消元 + 部分主元，容差按元素最大绝对值 ×1e-9 缩放；`this.matrix` 本身是副本，可原地消元）。`inverse()` **直接构造 `NeonaicMatrix`**，不要走 `map` —— 基类 `map` 返回普通 `NeonaicTable`，会把 `det()`/`squared`/`inverse()` 丢掉。`map` 第三态 `'cell'` 原先被 `assertTableDirection(…, true)` 挡住（分支成了死代码），现已放开。
- ⚠️ **`neonaicMath.toNumber` 原先会删掉负号**（`'-1'` → `1`），矩阵里就是静默算错；现已单独处理前导 `-` / `−`（U+2212）。下游（`calc`/`solve24`/`parseStorageText`/`timeout`）均已回归。
- `neonaic:matrix` 工具（`utils/registerUtilsSupport.js`）：行分隔容忍换行与分号；**先校验形状与单元格是否可解析为数字**再建矩阵（`NeonaicTable` 对不齐数据是截断/补空，不校验会算出「看起来正常的错答案」）；输出字段 `singular`（布尔，原 `signature` 是不存在的方法）；奇异矩阵**不返回** `inverse`；`rank/fullrank/squared` 在 schema 里改为可选，失败只回 `info`。

## 科学常量与算式（同一文件的 `PHYSICAL_CONSTANTS` / `HIGH_PRECISION_CONSTANTS` / `calcExpression`）
- **两张表，不再靠 `typeof` 分辨**：`PHYSICAL_CONSTANTS`（15 个名字，**全是 `number`**：π/pi、e、φ/phi、c、R、F、α/a、mppme、VM/Vm/V_M/V_m）与 `HIGH_PRECISION_CONSTANTS`（41 个名字，值是 **CODATA 2022 十进制字面量字符串**，允许负号与 `e` 指数）。浮点表是高精表的**子集**，模块加载时断言「浮点表每个名字都在高精表里」，缺项直接抛 `NeonaicIllegalStateError`。导出为 `neonaicMath.constants` / `neonaicMath.highPrecisionConstants`。
- 高精表用字面量而不用 `mantissa×10^exponent`：旧整指存储位数少（`h` 只有 7 位、`NA` 7 位），混进 50 位 π 的算式会平白损失精度；字面量按 scale 精确移位，同一个常量在 science=20/100 下是同一个数。**`ħ` 由精确 h 与 50 位 π 推出**（1.054571817646156391262428003302280744722e-34），`VM` 由 R·T/p 推出。
- **`toNumber` 只查浮点表**（整串匹配，允许前置 `-`），表里全是 number，故**没有 `typeof` 判断**；高精常量一律不转换（`'NA'`/`'h'` → NaN）。查表用 `hasOwnProperty`，否则 `constructor`/`__proto__` 会被当成常量。
- **`calc` 的新特性**：常量（`basicConstant` 默认 true）、隐式乘法（`2π`、`3(1+2)`、`(1+2)(3+4)`，但**不认数字**，`2 3` 仍报错）、对数（`log` 默认 false；`ln2`/`lg 100`，操作数取一元表达式，`lg8/lg2` 换底）、**后缀阶乘 `!`**（`factorial` 默认 false）。解析链：加减 → 乘除模(含隐式) → 一元 → 幂 → 根号 → 对数 → **阶乘** → 常量/括号/数字。阶乘比 `^` 更紧：`2^3!`=64、`-3!`=-6、`3!!`=`(3!)!`=720；浮点 170! 封顶、高精 10000! 封顶，参数必须是非负整数。
- 浮点算式里用只有高精版本的常量（NA/h/…）会**明确报错**并提示开 `science`；高精模式用未知/无高精版本的名字也会分别报错。
- **`science` = 小数位数（1..200），已实现 BigInt 定点引擎**：`+ - * /`、整数次幂、n 次根、`ln`/`lg`、阶乘，返回 `NeonaicTDecimalStore`。内部值 = 真实值 × 10^scale 的 BigInt；工作精度 = scale+12，**只在最后舍入一次**。
  - `ln` 用 `2·atanh((m-1)/(m+1))` 级数，先把值归一化到 [1,10) 再折半到 [1,2)（y ≤ 1/3，每项缩到 1/9）；`ln2`/`ln10` 按精度缓存。`lg` 的分子分母都取到工作精度再相除（否则 `lg8/lg2` 会明显漂）。
  - n 次根：integerRoot（牛顿 + 末位修正）在 `a·10^(scale(n-1)+n)` 上取整根，再 `/10` 四舍五入 —— 少算这一位会让末位总是偏小。
  - ⚠️ 每步都按 scale 舍入，链式除法/换底末位会漂 1 ulp（`lg8/lg2` → `3.00000000000000000003`），属定点固有行为。
  - ⚠️ **常量在给定 scale 下会舍入为 0 时必须报错**（如 `h` 在 science=20）：`scaledFromDecimal` 检测到非零字面量转出 0 就抛 `NeonaicIllegalArgumentError`，并算出「至少多少位才不为 0」与「保留全部有效数字需要多少位」（h 分别是 34 / 42）。静默变 0 曾让 `h*NA` 整条算式失效。
  - 明确拒绝的情形：非整数指数、非法 `science`（非 1..200 整数）、阶乘参数非整数/超上限。`decimalToString` 与 JS 的 `Number#toString` 对齐（小数点后超 6 个 0 才科学记数法）。
- ⚠️ `µ`(U+00B5) 与 `μ`(U+03BC) 码位不同但长得一样，`CALC_SYMBOLS` 已把前者折成后者，否则 `µ0` 查不到常量。`！`（全角）也会折成 `!`。

## 消息片段协议（`src/message/messageFragment.js`）
- `NeonaicMessage` 持有片段链：`markdown(override)` 返回**数组**（可按 `TYPE` 替换或置 null），`toMarkdown()` 拼成字符串；`forEachFrag`/`mapFrag` 的回调第三个参数是 `TYPE`。构造函数接受 `string | fragment | fragment[] | string[] | NeonaicMessage`，留空创建空消息。⚠️ 构造函数末尾曾有一个**无条件 `throw`**，任何消息都构造失败。
- 片段类型：`text`/`br`/`link`/`emoji`/`table`/`image`/`audio`/`video`，共同基类 `NeonaicMessageFragment`（抽象，直接实例化抛错）。
- ⚠️ **ESM 私有字段不能跨类访问**：在基类声明 `#payload`、子类写 `this.#payload` 会在**解析期**报 `Private field '#payload' must be declared in an enclosing class`（不是运行期）。每个类必须自己声明 `#payload`。
- 媒体统一继承 `NeonaicMediaMsgFrag`（抽象；子类用静态 `KIND`/`TAG` 声明身份）：负责 `Buffer|Blob|URL|Request|NeonaicUriMeta|string` 归一化（Buffer → data URL；Blob 在浏览器走 object URL，需 `dispose()`）、MIME 推断（magic number + 扩展名兜底）、HTML 标签生成（`src`/`title`/`aria-label`/`controls`/`loop`/`muted`/`autoplay`/`preload`，`poster` 仅 video）。图片只覆写 `markdown` 为 `![alt](url "title")`。
- ⚠️ `NeonaicTable.map(cb)` 默认 `direction='row'`，回调收到的是**整行数组**；逐格处理必须传 `'cell'`（`NeonaicTableMsgFrag` 曾因此把每行 stringify 成 `"['a','b']"`）。
- ⚠️ `NeonaicUriMeta.toString()` 会补尾斜杠（`https://e.com` → `https://e.com/`），断言链接输出时要按规范化后的值。

## Joyous 桥接拓展（`extensions/joyous/`）
与 Java 插件 [StreackMC/Joyous](https://github.com/StreackMC/Joyous) 协作的双通道桥接。**V1 见 `PROTOCOL.md`（§16 是 V2 落地说明）；V2 增量以 `PROTOCOL-V2.md` 为唯一约定来源，必需改动清单见 `NEONAIC-REQUIRED-CHANGES.md`**（后两份是对端 `docs/neonaic/` 的副本）。常量以 `src/protocol/constants.js` 为准，对端以 `Neonaic/bridge/BridgeProtocol.java` 为准，**自检解析该 Java 文件逐项比对**。
- 分层：`src/entry.js` 组合根｜`config.js`｜`identity.js`｜`status.js`｜`protocol/`（`constants`/`codec`/`session`/`http`/`uds`/`dispatch`/`methods`）。**`protocol/` 下导入内核是 4 层** `../../../../src/...`。两个接缝：`dispatch.js` 认识命令系统、`methods.js` 认识平台/AI/身份，**都不认识具体传输**；http.js/uds.js 只认「handler + {method,payload}」。
- 传输：HTTP = 同时当客户端与服务端（`/neonai/command` + `/neonai/invoke`）；UDS = **被动端**，主动 `connect` 对端建立的路径（**Joyous 是监听方且 accept 后先发 hello ⇒ 本端 `handshake` 必须 `responder`**）。`status.transport`/`bridge.transport` = `auto`(UDS 就绪优先，失败回退 HTTP)/`http`/`uds`。
- ⚠️ **连接生命周期（对端文档 §11）**：Joyous **是监听端且不主动重连**，恢复**完全依赖本端重拨**。必须保留指数退避（`initialDelayMs=1000`/`factor=2`/`maxDelayMs=30000`/抖动 0.2），且**退避计数只在握手成功后清零**（否则「连上就被踢」→ 重连风暴）。对端未 `bridge start` 时套接字不存在 → 持续 `ENOENT/ECONNREFUSED` 是**预期行为**，按退避重拨即可，不报致命错误。
- 方法：本端**应答** `chat.publish`（MC→聊天，投递到 `bridge.profiles[profile].channels` 白名单频道；并按 `sender.uuid` **刷新绑定表里的玩家名快照**）、`ai.request`、`identity.bind`/`identity.resolve`（`code` 空＝不校验）、`identity.unbind`（回 `{bound:false, removed:[chatId…]}`，`removed` 空**不是错误**）。本端**发起** `identity.claim`（一次性绑定代码换 MC 身份；失败一律按「无效或已过期」提示，对端刻意不区分原因）、`chat.broadcast`。
- **内播触发**：订阅内核 `neonaic:message`，按**执行者链 × 配置频道白名单**匹配（不硬编码平台前缀）。`user` 载荷 = `{uuid: 绑定的 MC UUID 或 null, name: MC 玩家名或聊天昵称, nickname: 聊天昵称, subname:'', id: 原始代号}`；**未登记的代号绝不当作名字展示**。**入站 `chat.broadcast` 的 `user.name` 正是取自 `chat.publish` 刷新的那份快照** —— 两侧构成闭环。
- **授权两套独立**：命令走 `joyous.bridge.execute` + 命令 `permissions` + 空权限命令的 `joyous.command.<ns>:<name>`；业务方法走 `bridge.allowedMethods`（配置白名单，缺省 5 项）+ `joyous.bridge.business`（总闸，**默认不授予**）+ `joyous.bridge.<method>`（**显式 false 才拒绝**）。`BRIDGE_EXECUTOR = '$joyous'` 定义在拓展内，改名会让既有授权失效。
- **自助命令** `/joyous:bind <code>`、`/joyous:bind clear`、`/joyous:chatsync [on|off]`：三者**只作用于调用者自己**，拒绝 `ctx.internalCall` 与 `$` 开头的合成执行者。`chatsync` 切换**逐用户**权限 `joyous.chatsync.disabled`（持有＝不把自己的聊天内播到服务器侧），与三层业务闸无关。
- 管理命令 `joyous:bridge`；AI 工具 `worldMeta`、`serverStatus`。绑定表 `config/saves/joyous-identities.json`（**以 `chatId` 为键**：`profile → chatId → {uuid, name, boundAt}`；有 uuid 只认 uuid，拿不到才退回按名字匹配）。
- ⚠️ 两侧 profile 命名可以不同：Joyous 的 `group-chat-sync.profile` 键与 Neonaic 平台 Profile 名**不是一套命名**，由 `bridge.profiles.<键>.platform` 显式对应（用户当前两处同名，频道形如 `qGRP#<群哈希>@<机器人号>`）。
- ⚠️ 对端 `Neonaic.yml` 的 `connect.timeout.request`（缺省 10 秒）是**对端等我方应答的上限**；`ai.request` 要调到 60 秒以上。
- ⚠️ 改 `extensions/joyous/config.json` 后要 `/neonaic:reload` **并重启拓展**，通道不热切换。

## AI 调用链
- 链路：平台事件 → 平台拓展（qqbot/msgHandler）→ `neonaicMessageIn.resolveReply(msg, {AI, AIlist, resolveCommandWith})` → `neonaicAI.askAI(msg, {AIlist, caller, speaker, overridePrompt, overrideAITool})` → `callProvider`。**AI Profile = `secret.json` 的 `oai[]`**：`{name, available, address, token, model, tools, maxToolcall, prompt}`（`prompt` 指向 `config/prompts/<file>.md`）。`address` 是 **base URL**（如 `https://api.deepseek.com/v1/`），端点由 SDK 追加（chat → `/chat/completions`，responses → `/responses`）；**不再要求用户手写完整端点，也没有 fetch 中间件改写 URL**。
- **`AIlist` 只过滤、不决定顺序**（`getList('oai').filter(...)` 保持源顺序）⇒ **尝试顺序恒等于 `oai` 声明顺序**。`available:false` 是**独立闸门**；内核已内置「跳过不可用 + 逐个 try 失败换下一个」。
- **模式列表（`tools` 与 `AIlist` 共用 `resolvePatternList`）**：`"*"` 全选 / `"!name"` 排除（排除优先）/ `"!*"` 全排除。**严格度不同**：`AIlist` **严格**（只写排除项 → 抛错），`tools` **宽松**（`["!x"]` = 一个都不给）。
- **`PlatformManager` 构造 profile 是 `{...raw, _debug}`** ⇒ 平台 Profile 可携带任意自定义键并原样透传（qqbot 的 `platforms[].aiRouting` 由 `extensions/qqbot/src/aiRoute.js` 的 `pickAIList` 消费：维度 `scene`/`group`/`user`/`permission`/`match`，when 字段间 AND、字段内 OR，首条命中即用，`use:"*"`=沿用 `allowedAI` 只能收窄）。⚠️ `_writeProfileEnabled` 用 `JSON5.stringify` 整体重写 `secret.json`，**会丢手写注释**。
- **用户名录**：`src/message/userDirectory.js` 的 `neonaicUserDirectory`，`code → {name, pronoun?, note?}`，存 `config/saves/identities.json`。**判据**：名录是通用概念 ⇒ 内核；「某平台怎么拿到名字」是平台特定 ⇒ 拓展。投递走 `askAI` 注册的**临时 AI 工具** `neonaic:speaker`，**不注入提示词**；入口 `/neonaic:ai whois <list|get|set|unset|show>`。qqbot 用免费的 `group_name` 自动登记；**QQ 群/C2C 拿不到发送者昵称**，只能人工登记。**未登记的 code 一律丢弃**。
- `askAI` 的 tools 合并坑（已修）：`provider.tools` 解析为空时整个 `tools` 键曾被省略、**overrideAITool 被静默丢弃**；必须**先合并再判空**。
- **多模态**：由 Profile 的 `multimodal`（兼容历史拼写 `mutimodal`，正字优先）声明，形如 `{ image: ["image/png"], video: [], audio: [] }`；空数组/缺省=不支持，`true` 等价 `["*"]`。`askAI` 先把 `string|fragment|fragment[]` 归一成 `NeonaicMessage`，再**按 Profile 逐个**构建内容：模态已开启时 **URL 与 base64 都会发**（URL → `data:{type:'url'}`，base64 → `data:{type:'data'}`）；未开启/格式不在白名单 → 降级 markdown（**只有这条路禁止 base64**，base64、`blob:`、`file:` 换成占位文本 `[图片已省略：来源不是可公开访问的 URL]`）。
  - ⚠️ MIME 未知时**不放行**（配置写的是「理解哪些 MIME」）；要全收就写 `"*"` / `"image"` / `"image/*"`。`image/jpg`→`image/jpeg`、`audio/mp3`→`audio/mpeg` 等别名已折叠。
  - ⚠️ `@ai-sdk/openai` 的 **Chat Completions**：图片 URL/data 都行；音频只收 **wav/mp3 的内联 data**（URL 会被拒）；**视频不接受内联**（URL 也传不了）。**Responses API**：非图片 URL → `input_file.file_url`；非图片内联需要 `providerOptions.openai.passThroughUnsupportedFiles = true`（Key 固定 `openai`/`azure`，**不是 Profile 名**）。
  - ⚠️ AI SDK 默认会**下载**不在 `model.supportedUrls` 里的文件 URL 再内联 base64；`callProvider` 已按 Profile 声明给 Responses 模型补上 `audio/*` / `video/*` 的 URL 白名单，否则视频会被整个拉下来。

### qqbot 的事件投递语义（`extensions/qqbot/`）
- ⚠️ **一帧事件会被多次 `emit`**：SDK 的 `client.em()` 把事件名按 `.` 拆开、逐个前缀 emit。所以
  `GROUP_AT_MESSAGE_CREATE`（未授权「获取全部群消息」时 QQ 只推这一种）会依次触发
  `message` → **`message.group`（`onGroupMessageIn`）** → **`message.group.at`（`onGroupAtMessageIn`）**，
  **两次回调拿到同一个事件对象**、顺序固定，与监听器注册顺序无关；而 `GROUP_MESSAGE_CREATE`（已授权）只到 `message.group`。
- ⇒ 不要用「先到先得」的锁（`event.neonaicused` / WeakSet）来去重：它确实能生效（同一对象），但会让后一个回调的
  **整条 `cmd + AI` 流程永远不执行**，表现为 @ 消息完全没有回复。
- ⚠️ **`event.sub_type` 不能作为判据**：`Message` 基类构造时把它固定成 `'normal'`，而 `em()` 写入的
  `sub_type: 'at'` 会被同一句 `Object.assign` 末尾的 `...payload`（事件对象自身）覆盖回去；类型声明也只允许
  `'direct' | 'friend' | 'temp' | 'normal'`。生产环境里它恒为 `'normal'`，`=== 'at'` 永远不成立。
- 正确做法：**让出 + 认领**。`em()` 的 emit 循环是同步的，`onGroupMessageIn` 先 `await Promise.resolve()`
  让出一个微任务；`onGroupAtMessageIn` 在第一个 `await` **之前**把事件加入 `claimedByGroupAt` WeakSet。
  随后 `onGroupMessageIn` 醒来见到认领标记就直接 `return`；没有 `.at` 回调（已授权）时则照常处理。
  ⇒ 已授权/未授权都只处理一次，顺序不依赖监听器注册次序。
- 两个回调各自只看得到一半上下文：`all=false` 时 `group` 那一侧 `event.mentions` 恒为 `[]`（@ 信息不在 payload 里），
  所以它既判断不出「被 @」，也不能在那里跑 AI。
- 实测（模拟 SDK 同步派发 + 真实执行 `/neonaic:help`）：修复前 group 与 at 各跑一次、命令回复 **2** 次；
  修复后只由 at 处理、回复 **1** 次；反向验证（去掉认领）能稳定复现 2 次。

### qqbot 的 `NeonaicTValidMessage` 转换层（`msgPayloadConvertor.js`，WIP）
- 两个方向：入站 `convert_qqBotMsg_to_NeonaicMsg(event, pp, textOnly)`、出站 `convert_NeonaicMsg_to_qqBotMsg(msg, allowTempSave)`；
  `msgHandler.sendMsg(instance, who, msg)` 会先 `toQbSendable` 再按 `qUSR#`/`qGRP#` 分派；`PlatformQQBot.sendMsg(who, ...msg)` 负责组装 NeonaicMessage。
- ⚠️ **`#/` 子路径别名有版本差异**（顶级别名是实验性功能）：**Node 26 接受** `"#/*": "./src/*"` + `#/a.js`；
  **Node 22 拒绝**，报 `ERR_INVALID_MODULE_SPECIFIER`（是 specifier 层面的校验，与 package.json 是否被探测到无关）。
  为让 `engines: >=18` 的项目在两边都能跑，**2026-10-29 已全量改用 `#src/`**（两边实测都可用）：53 个源文件的
  `'#/…'`/`"#/…"` 换成 `#src/…`，`package.json` 的 imports 与 `jsconfig.json` 的 paths 同步。
  批量替换只能匹配引号紧邻的形式 —— 正则 `/^qUSR#/` 里也含 `#/`。
- 2026-10-29 修完的缺陷（由 `scripts/qqbot-msg-convertor.test.mjs` + 临时拓展线上复验）：
  `frag.userId` → `frag.target`（At 片段只有 target，原来任意 @ 都抛 TypeError）；
  `msgPayloadConvertor.js` 漏 import `fromQQElement`（表情恒丢弃）与 `NeonaicIllegalArgumentError`；
  `event.message` 非数组时 `raw.forEach` 直接崩；
  `emoji.js` 的 `fromQQElement` 把字符串 `'face'` 当 type 传给 `getEmoji`（store 键是 `1:id`）；
  `NeonaicLinkMsgFrag.markdown` 的 `url + alt ? … : ""` 优先级错（URL 丢失）+ `alt` 缺省被 `parseString(undefined)` 变成 `"undefined"`；
  `PlatformQQBot.sendMsg` 的 `who.replace(/@.*$/,'').split('@')` 让 botId 恒空（跨 bot 拦截失效）+ `messageContent.replace(...)`（消息已发出却回「无法发送」）；
  以及 **`sendMsg(who, ...msg)` 把单个 `NeonaicMessage` 包成数组**（构造函数只收片段/字符串数组）⇒ `NeonaicTValidMessage` 的单消息形态反而不可用。
- 线上实测（临时拓展 + 真内核）：纯文本、@、markdown 链接、图片（URL/base64）都能发出；`SendResult.brief` 可用来对照内容。
- **做需要内核能力的测试时不要 mock**：写临时拓展，授权后用 `node main.js` 拉起真内核，跑完删掉。见项目技能
  `.workbuddy/skills/neonai-temp-extension-live-test/SKILL.md`（含 onEnable 早于平台启动、异常被吞、兜底收尾等坑）。
- 测试脚本 `scripts/qqbot-msg-convertor.test.mjs`：默认离线（桩 bot / 合成事件，零网络）；`--live --send` 真发、
  `--live --send --only=<子串>` 只跑部分用例、`--live --listen=N` 只观测。沙箱标识：用户 `qUSR#DE5D74452748FAFEF5063175198C950C@8528533035224324959`、
  群 `qGRP#588A721FF0F068E24B68628F087AFB31@8528533035224324959`（`@` 后是机器人 id）。

## 配置 / gitignore / 硬约束
- `config/main.json` — 名称/次名、`prefix`、`maxLogFileSize`、`detailedLog`、`ai.*`；`config/prompts/<profile>.md` 提示词（**gitignore**）。**`config/saves` 整目录 gitignore**，但 `ext.json`/`permissions.json` 因**规则加入前已被跟踪**而仍在版本控制；**新增文件（`identities.json`、`joyous-identities.json`）不会入库**。根目录 `secret.json` 是真凭据（gitignore），`config/secret.json` 是模板（入库）。拓展自带 `extensions/<name>/config.json` ⚠️ **已入库**且用户会填自己的部署参数（开启通道、真实频道、端口）——自检**不要依赖它的内容**，要自带配置。
- **内核不得出现任何拓展名**（解耦硬判据）：看一处改动**会不会留下「本体只在某拓展存在时才有意义」的东西**。拓展专属的合成执行者身份（`$joyous`）必须定义在拓展内，**不得写进内核 `COMMAND_ENUMS`**；`$` 前缀是内核保留的合成身份命名空间（内核只占 `$console`/`$unknown`），权限按执行者字符串存授权。反例：`NeonaicProtocolError` 这类**通用错误词汇**进内核不算耦合。
- **`extends` 了 `JoyousNewable`/`NeonaicNewable` 的类，构造函数必须 `super()` 且早于任何 `this` 访问**（漏掉构造即抛 ReferenceError）。已踩过：`codec.js` 的 `JoyousLineFrameCodec` ⇒ UDS 链路整体不可用。
- **Node 的 `net.connect({path})` 失败是异步 `emit('error')`、不抛**：只在同步 catch 里上报会让「对端没启动」这类最常见失败完全静默。事件文档承诺的 `error` 必须在 socket `error` 回调里 `emit`。已踩过（uds.js）。
- **⚠️ NeonaicConfig 默认 AUTOSAVE**：任何 `put*`/`set`/`remove` **立即落盘**。测试脚本**绝不要指向真实配置文件**。macOS 大小写不敏感，`import './AI.js'` 这类错误本地不报、**Linux 上必炸**。
- Git 按全局**权责边界**执行（见 `~/.workbuddy/MEMORY.md`）：身份 `Neonai <neonai+coding@kdxiaoyi.top>`（仅 `git -c` 携带）；Conventional Commits 中英双语；**必须主动提交自己所做的修改**，只 add 本次任务产出的文件（含 `.workbuddy/memory/`）；**不得提交无关代码，不得 push/pull/fetch/rebase/merge**。

## 沙箱自检 / 编辑器 / 拓展陷阱
- 零污染配方详见技能 `side-effect-test-isolation`、`js-selfcheck-script-mechanics`、`cross-process-bridge-design`。要点：`rsync` 真实仓库到沙箱（**`src/` 必须复制、不能软链**，否则 `ROOT_PATH` 自算指回真实根）+ 软链 `node_modules`；**改完源码必须重新 rsync**；**每份套件自管配置**；沙箱内改权限用 `setPermission`/`clearPermission` API（写文件对已加载内存态无效）；JSON5 打补丁要锚定小节正则（**不能按「相邻两行」匹配**）；`import(x + '?bust=1')` 会造出**新模块实例**。驱动 `runall.sh` + `selfcheck.mjs` + `loadercheck.mjs` 在 `/tmp/joyous-sandbox/`。
- `jsconfig.json` 的 `include` 必须写 `src/**/*.js`（`src/**.js` 匹配 0 个文件，会让自动 import / 跨文件补全全失效）；`extensions/**/*.js` 也要显式加；需 `module/moduleResolution: NodeNext` + `importModuleSpecifierEnding: "js"`。
- **Wordle**（`wd`）：难度别名 `n`/`hard`/`uh`（**刻意不收单字母 `h`**）。**字母判定按份数结算** ⇒ `missing` **不等于**「答案里没有该字母」。猜中那行内部存 `'right'` **字符串**。参数解析要 `sub = args[0]` 与 `param = args.join('')` 分开判（否则 `/wd new hard` → `newhard`）。
- **24 点**（`24`/`tf`/`tfp`，id `twentyfourpoints`）：4 数取自 1–13，**允许重复、不保证有解**（约 25% 无解），**每局一次机会**（**只有 `invalid` 不消耗**）；`/24 solve` 永远列全。

## 已知待办
- **`commandServer.js` 的 `executeCommand`/`executeCommandSilent` 只拦同步异常**：`async` 处理器抛出的异常以 Promise 拒绝逸出、不会被包成 `NeonaicCommandError`（产生未处理拒绝）。joyous 的 `dispatch.classify` 兜住了这一类，**内核侧应单独修**。影响全项目所有 async 命令。
- `extLoader.js`：`disable()` 无空守卫；`replaceAll('.', '\.')` 是空操作，且键名用 `.enabled` 而 `ext.json` 样例写的是 `enable`。
- `ai.js` 的 `neonaic:webfetch` 是半成品（`uri = new URL(address)` 赋给未声明变量，严格模式必抛，被 catch 吞掉）。`entry.js` 的 `checkPermissionFromContext(this)` 只传 1 个参数，`systemLine` 永远为空。`NeonaicUriMeta.js:184` 的 `{@link resolveUri}` 悬空。
- **`NeonaicTable.toCsv()` 的转义仍未按 RFC4180**：只转义 `|`，含 `,`/`"`/换行的单元格往返即错（`neonaic:matrix` 只输出纯数字，暂不受影响）。
- ✅ 已修：joyous `dispatch.js` 调不存在的 `checkCommandPerms`；`codec.js` 漏 `super()`；`JoyousUdsLink` 缺 `notify()`；`uds.js` 异步连接失败不发 `error`；`config.js` 的 `bridge.ai.AIlist` 缺省误报 issue；`NeonaicMatrix.rank`（高斯消元）、`neonaic:matrix` 的 `singular` 字段与 `toCsv()` 调用。
- ⚠️ **拓展 id 的连字符会让整个拓展静默不加载**：`extensions/rate-limiter/manifest.json` 曾写 `"id": "rate-limiter"`，被 `extLoader` 的 `^[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)*$` 判为「描述文件无效」；`extManager.scan()` 只 `extH.warn` 一条、`loadAll` 自然跳过，表现为「限流器完全没生效」。已改 `ratelimiter`。排查用 `for f in extensions/*/manifest.json; do grep '"id"' "$f"; done`。
