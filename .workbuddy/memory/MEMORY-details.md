# Neonai-Connector 细节记忆（按需读取，不注入）

> 本文件是 `MEMORY.md` 的附属：主文件只放每次都要用到的硬约束，
> 分模块的实现细节都在这里。**动手改某个模块前先 Read 对应小节。**

## 表格 / 矩阵 / 算式（`utils/math.js`）
- `NeonaicTable` 五种数据源：`object-row`、`object-col`、`csv`、`markdown`、`array[]`。`option.rows/cols` 与数据冲突时**按 option**（截断/补空，矩阵补 0）。列数取「数据最大宽度」与「表头行宽度」的较大者。
- **表头** `option.header` ∈ `true|false|'auto'`（默认 `auto`），只对文本源生效。**`auto` 只在 Markdown 上推断**；CSV 首行一律视为数据（猜错会吞一行真实数据），需要时显式 `header: true`。文本源自带表头 + `option.colTitle` ⇒ 标题用 option 但表头行**仍从数据移除**；object 源按键→列映射**重排原始数据**，文本源只能整体覆盖。
- ⚠️ **`math.js` 的 import 顺序有讲究**：`NeonaicNewable` 必须写在 `NeonaicNewableError`/`chore` **之后**，否则本文件成了既有环（NewableClass ↔ Error ↔ chore → confManager → NeonaicConfig → NewableClass）的入口，直接 import 即 TDZ。
- ⚠️ `toCsv()` 转义是错的（转义 `|` 而非 `,`/`"`）；`toCsv` 后重新解析**必须**显式 `header: true`。`NeonaicMatrix.inverse()` **直接构造 `NeonaicMatrix`**（走 `map` 会退化成 `NeonaicTable`，丢 `det()`/`inverse()`）。`NeonaicTable.map(cb)` 默认 `'row'`，逐格要传 `'cell'`。
- ⚠️ `neonaicMath.toNumber` 曾**删掉负号**；现已处理前导 `-`/`−`（U+2212）。`µ`(U+00B5) 与 `μ`(U+03BC) 已在 `CALC_SYMBOLS` 折叠。
- **常量两张表**：`PHYSICAL_CONSTANTS`（15 个名字，全是 `number`）与 `HIGH_PRECISION_CONSTANTS`（41 个，CODATA 2022 十进制字面量字符串），浮点表是高精表子集（加载时断言）。`toNumber` **只查浮点表**（整串匹配 + `hasOwnProperty`，否则 `constructor` 会被当常量）。
- `calc`：常量、隐式乘法（`2π`/`3(1+2)`，**不认纯数字**）、`log`（`ln2`/`lg 100`/换底）、**后缀阶乘 `!`**（比 `^` 更紧：`2^3!`=64、`-3!`=-6）。`science` = 小数位数（1..200），BigInt 定点引擎（工作精度 scale+12，只最后舍入一次）；常量在给定 scale 下被舍成 0 时**必须报错**（曾静默变 0 让 `h*NA` 整条失效）。

## 消息片段（`src/message/messageFragment.js`）
- `NeonaicMessage` 持片段链；`markdown(override)` 返回**数组**，`toMarkdown()` 拼字符串。类型 18 种（`raw-fragment` 无实现）：`text`/`br`/`inline-code`/`code`/`link`/`emoji`/`table`/`at`/`heading`/`image`/`audio`/`video`/`ordered-list`/`unordered-list`/`checkbox`/`blockquote`/`divider`。
  ⚠️ **typedef `NeonaicTMessageFragmentTypes` 是唯一清单**，自检要**解析该 typedef** 比对实现类（别拿硬编码表自证——曾这样漏掉 `heading`）。
- **块级 vs 行内**：`static BLOCK`。块级 = `heading`/`br`/`code`/`table`/三类列表/`checkbox`/`blockquote`/`divider`/`audio`/`video`；行内 = `text`/`inline-code`/`link`/`emoji`/`image`/`at`。
  ⚠️ `toMarkdown()` 在块级片段两侧补空行（否则 `说明` + 代码块会拼成 `说明```…`）；**新增块级必须标 `static BLOCK = true`**。首尾换行一律裁掉。
- **样式与空白**（`styleText()`）：先摘首尾空白、套完再接回。⚠️ 定界符必须**紧贴非空白**，否则 `**  aaa**` 退化成字面量、`* aaa*` 会被渲染成**列表项**；纯空白不套标记；按 `\n{2,}` 切段各自闭合。
- **`br` = 强制分段**（`markdown` 是 `\n\n`）：1 个与 2 个等价，放首尾会被裁掉。**段内换行是部分支持特性**，要 `new NeonaicTextMsgFrag('\n')` 手写（CommonMark 会渲染成空格）。代价：列表里放 `br` 会让列表变松散。
- **嵌套是数据表** `NESTING`（容器 → 允许子类型），`assertNestable` 构造期校验。`link` 的 label 只允许 `text`/`inline-code`/`emoji`/`image`（`alt` 只能纯文本）；`heading` 允许 ±`link`，拒绝块级与 `br`（层级 1–6，空内容输出裸 `#`）；列表/引用/复选框不限子类型但仍拒绝 `raw-fragment`。
  ⚠️ `assertPlainText()` 守「本该纯文本」的位置（`text`/`code`/`at`/表格单元格），否则 `parseString(fragment)` 静默得到 `"image:![…]"`。行内渲染 `renderInlineFragments()` **只转义 `text`**。
- **列表用 `NeonaicMessageFragment[][]`**（内部归一成 `NeonaicMessage[]`，复用 `toMarkdown` 的块级拼接）。`checkbox` 做成「一组条目」（单项会被空行隔成松散列表）。`renderListItems()` 按每项自己的 marker 宽度缩进续行。媒体继承 `NeonaicMediaMsgFrag`（Buffer/Blob/URL/Request/NeonaicUriMeta/string 归一化 + MIME 推断 + HTML 标签）。⚠️ `NeonaicUriMeta.toString()` 会补尾斜杠。

## Joyous 桥接拓展（`extensions/joyous/`）
与 Java 插件 [StreackMC/Joyous](https://github.com/StreackMC/Joyous) 协作的双通道桥接。**V1 见 `PROTOCOL.md`（§16 是 V2 落地说明）；V2 以 `PROTOCOL-V2.md` 为唯一约定来源，必需改动见 `NEONAIC-REQUIRED-CHANGES.md`**。常量以 `src/protocol/constants.js` 为准，对端以 `Neonaic/bridge/BridgeProtocol.java` 为准（自检解析该 Java 文件逐项比对）。
- 分层：`entry.js` 组合根｜`config`｜`identity`｜`status`｜`protocol/`（`constants`/`codec`/`session`/`http`/`uds`/`dispatch`/`methods`）。两个接缝：`dispatch.js` 认识命令系统、`methods.js` 认识平台/AI/身份，**都不认识传输**。
- 传输：HTTP = 既当客户端又当服务端（`/neonai/command`、`/neonai/invoke`）；UDS = **被动端**，主动 connect 对端建的路径（**Joyous 是监听方且 accept 后先发 hello ⇒ 本端必须 `responder`**）。`transport` = `auto`(UDS 优先，失败回退 HTTP)/`http`/`uds`。
- ⚠️ **Joyous 不主动重连，恢复完全依赖本端重拨**：保留指数退避（1000/×2/30000/抖动 0.2），且**退避计数只在握手成功后清零**（否则「连上就被踢」→ 重连风暴）。对端未 `bridge start` 时持续 `ENOENT/ECONNREFUSED` 是**预期**。
- 方法：应答 `chat.publish`（投递到 `bridge.profiles.<p>.channels`，并按 `sender.uuid` 刷新绑定表名字快照）、`ai.request`、`identity.bind`/`resolve`（`code` 空＝不校验）、`identity.unbind`（回 `{bound:false, removed:[…]}`，空 `removed` 不是错误）；发起 `identity.claim`（失败一律提示「无效或已过期」，对端刻意不区分）、`chat.broadcast`。
- **内播**：订阅 `neonaic:message`，按**执行者链 × 频道白名单**匹配。`user` 载荷 = `{uuid, name, nickname, subname:'', id}`；**未登记代号绝不当前名字展示**。入站 `chat.broadcast` 的 `user.name` 正是 `chat.publish` 刷新的那份快照（闭环）。
- **授权两套独立**：命令走 `joyous.bridge.execute` + 命令 `permissions`；业务走 `bridge.allowedMethods`（缺省 5 项）+ `joyous.bridge.business`（总闸，**默认不授予**）+ `joyous.bridge.<method>`（**显式 false 才拒绝**）。`BRIDGE_EXECUTOR = '$joyous'` 定义在拓展内，改名会让既有授权失效。
- 自助命令 `/joyous:bind`/`bind clear`/`chatsync`：**只作用于调用者自己**，拒绝 `ctx.internalCall` 与 `$` 合成执行者。`chatsync` 切**逐用户**权限 `joyous.chatsync.disabled`（持有＝不内播自己的聊天）。
- 绑定表 `config/saves/joyous-identities.json`（`profile → chatId → {uuid,name,boundAt}`；有 uuid 只认 uuid）。⚠️ 两侧 profile 命名不必相同，靠 `bridge.profiles.<键>.platform` 对应。⚠️ 改 `config.json` 后要 `/neonaic:reload` **并重启拓展**，通道不热切换。⚠️ 对端 `connect.timeout.request` 是**它等我方应答**的上限，`ai.request` 建议调到 60s 以上。

## AI 调用链
- 链路：平台事件 → 平台拓展 → `neonaicMessageIn.resolveReply(msg, {AI, AIlist, resolveCommandWith})` → `neonaicAI.askAI(msg, {AIlist, context, speaker, overridePrompt, overrideAITool})` → `callProvider`。**`caller` 已弃用**，改 `context`（`NeonaicCommandContext` 或普通对象，二者互斥；垫片 `privateExecutor=false`）。
- **Profile = `secret.json` 的 `oai[]`**：`{name, available, address, token, model, tools, maxToolcall, prompt}`。`address` 是 **base URL**，端点由 SDK 追加（chat → `/chat/completions`，responses → `/responses`）。
- **`AIlist` 只过滤、不决定顺序** ⇒ 尝试顺序恒等于 `oai` 声明顺序；`available:false` 是独立闸门。**模式列表**（`tools` 与 `AIlist` 共用 `resolvePatternList`）：`"*"`/`"!name"`（排除优先）/`"!*"`；`AIlist` 严格（只写排除项 → 抛错），`tools` 宽松（`["!x"]` = 一个都不给）。匹配粒度由传入的 `match` 决定：`AIlist` 精确；`tools` 走 `matchToolPattern`，`*` 通配符可出现在命名空间段与工具名段（`"ns:*"`、`"*:name"`、`"n*:a*"`、`"!ns:*"`），省略命名空间即 `*:name`（跨命名空间同名工具）。
- `PlatformManager` 构造 profile 为 `{...raw, _debug}` ⇒ 平台 Profile 可携带任意自定义键透传（qqbot 的 `aiRouting` 由 `pickAIList` 消费：维度 `scene`/`group`/`user`/`permission`/`match`，when 字段间 AND、字段内 OR，首条命中即用）。⚠️ `_writeProfileEnabled` 用 `JSON5.stringify` 整体重写 `secret.json`，**会丢注释**。
- **用户名录** `neonaicUserDirectory`（`src/message/userDirectory.js`），`code → {name, pronoun?, note?}`，存 `config/saves/identities.json`。判据：名录是通用概念 ⇒ 内核；「平台怎么拿名字」⇒ 拓展。投递走临时 AI 工具 `neonaic:speaker`，**不注入提示词**。**未登记的 code 一律丢弃**。
- **工具上下文注入**：`buildToolSet` 在**调用期**包装 `execute`，传 `options.neonaic`（本轮 ctx）与 `options.userInput`（多模态只取 text）。**不要用 SDK 的 `contextSchema`**（`z.object()` 会把类实例剥成 `{}`）。工具表必须扁平 `{模型名→工具}`，传 SDK 时包成 `{ tools }`；基础与临时工具**一次 build**（`joinObject` 是浅合并，对两层结构会整体覆盖）。
- **Provider 托管工具**：`oai[].providerTools`（`resolveProviderTools`）只收录 `isProviderExecuted` 的内置工具（webSearch / webSearchPreview / codeInterpreter / fileSearch / imageGeneration / mcp），与 `tools` 相互独立。⚠️ **只在 Responses API 生效**：Chat 的 `prepareChatTools` 只认 `function`（多一条 `unsupported` warning），Responses 的 `switch (tool.id)` **连 default 都没有**（无声丢弃）⇒ 配置了而 `responseAPI:false` 时直接抛错。⚠️ factory 会解构 options，「默认参数」也必须传 `{}`（`webSearchPreview()` 直接 TypeError）。
- **第三方自定义工具类型**（deepseek 的 `deepseek_web_search` 等）：SDK 无透传通道 ⇒ 走 `oai[].extraTools` + `createExtraToolsFetch()` 中间件（`createOpenAI({ fetch })`，键=type、值=其余字段），在请求体序列化后追加进 `tools`。body 非 JSON 原样透传、按 type 幂等、调用时才取 `globalThis.fetch`。⚠️ 注入的工具 SDK 不认识，平台若要求客户端执行会抛 `NoSuchToolError`。
- **多模态**：Profile 的 `multimodal`（兼容 `mutimodal`）声明 `{image, video, audio}`；`askAI` 按 Profile 逐个构建内容（URL → `{type:'url'}`，base64 → `{type:'data'}`）；未开启/格式不在白名单 → 降级 markdown（**只有这条路禁止 base64**）。⚠️ MIME 未知**不放行**（要全收写 `"*"`）。⚠️ Chat Completions 音频只收 wav/mp3 内联、视频不收；Responses 非图片 URL 走 `input_file.file_url`（`providerOptions` Key 固定 `openai`/`azure`，**不是 Profile 名**）。AI SDK 默认会下载不在 `supportedUrls` 里的 URL，`callProvider` 已按 Profile 补白名单。

## qqbot（`extensions/qqbot/`）
- ⚠️ **一帧事件会被多次 `emit`**：SDK 的 `client.em()` 按 `.` 拆事件名逐个前缀 emit ⇒ `GROUP_AT_MESSAGE_CREATE` 会依次触发 `message` → `message.group` → `message.group.at`，**两次回调拿到同一个对象**。
  ⇒ 不要用「先到先得」的锁去重（会让后一个回调的整条 `cmd + AI` 流程永不执行）。正确做法是**让出 + 认领**：`onGroupMessageIn` 先 `await Promise.resolve()`；`onGroupAtMessageIn` 在第一个 `await` **之前**把事件塞进 `claimedByGroupAt` WeakSet。
- ⚠️ **`event.sub_type` 不能当判据**：`Message` 基类构造时固定成 `'normal'`，`em()` 写的 `'at'` 会被 `...payload` 覆盖回去。
- `msgPayloadConvertor.js`：入站 `convert_qqBotMsg_to_NeonaicMsg`，出站 `convert_NeonaicMsg_to_qqBotMsg`；`sendMsg` → `toQbSendable` → 按 `qUSR#`/`qGRP#` 分派。出站 switch 覆盖全部片段类型（`code`/`inline-code` 曾漏 → 抛「未知的消息类型」；QQ 无对应元素的统一 `qbSegment.markdown(frag.markdown)`）。入站 `markdown` 原样当 `NeonaicTextMsgFrag`（**不做结构还原**）。
- ⚠️ **`#/` 子路径别名有版本差异**：Node 26 接受 `"#/*"`，**Node 22 报 `ERR_INVALID_MODULE_SPECIFIER`**。已全量改 `#src/`（imports 与 jsconfig.paths 同步）。
- ⚠️ 导入 `msgPayloadConvertor.js` 前**必须先 `new PlatformManager(...)`**（模块链上的 `entry.js` 加载时 `registerPlatform`）。
- 测试脚本 `scripts/qqbot-msg-convertor.test.mjs`：默认离线；`--live --send [--only=<子串>]`、`--live --listen=N`。沙箱标识：`qUSR#DE5D74452748FAFEF5063175198C950C@8528533035224324959`、`qGRP#588A721FF0F068E24B68628F087AFB31@8528533035224324959`。**需要内核能力时不要 mock**：写临时拓展、`node main.js` 拉真内核跑完删掉（见技能 `neonai-temp-extension-live-test`）。

## aicode 沙箱拓展（`extensions/aicode/`）
- **结构**：`sandboxmgr.js`（进程池/父子协议）｜`eval.js`（子进程）｜`framing.js`（帧编解码）｜`sanitize.js`（结果剥离）｜`ipc.js`（消息类型）｜`config.js`。
- **削峰缓冲 + 待机阶梯**：`maxChildren` 默认 10；待机预算用等差数列 `step = idleMaxMs*idleDecay/待机数`、`budget(i) = idleMaxMs - (k-1-i)*step`（i=0 最久没用）⇒ 进程越多杀得越快、最后一位恰好活满 `idleMaxMinutes`；`idleDecay=0` 退化为同时到期；预算有 5s 下限。阶梯由**全池一个** 500–2000ms 扫描器执行（不是每进程一个定时器），到点直接 SIGKILL（待机进程没有未完成工作，池容量立刻释放）。
- ⚠️ **交付即占用**：`acquire()` 必须在返回前 `worker.busy = true`。曾写成「acquire 只挑选、runOnWorker 再置忙」，两个并发任务在同一微任务间隙挑中同一进程，后者覆盖 `worker.task`，前者永久等不到结论；而硬超时又「id 不匹配就 return」，于是**永久悬挂**（表现为 `Promise.all` 永不 settle、`conversations` 计数不归零）。
- ⚠️ **父子通道不能用 `fork` 的 IPC**：那条通道的解析在 Node 内部（`parseChannelMessages`），子进程往 fd 3 写一段非法 JSON 会让宿主的 `channel.onread` 抛**未捕获 SyntaxError，直接把内核打死**（Node 22.22.2 实测）。现改为 `spawn` + 两根私用管道（子读 fd 3 / 子写 fd 4）+ 自己分帧：`\n` 分隔、半包留缓冲、粘包切开、单帧 ≤ 1MB、非 JSON/非对象/超长 ⇒ **协议异常 ⇒ 立即 SIGKILL 子进程**（内核不受影响）。结果帧还要求 `id` **严格相等**，否则丢弃（早期写「id 存在才校验」，等于允许子进程省略 id 顶掉当前任务）。
- ⚠️ **guest 只能回字符串**：库的 `handleToNative` 会把 guest 值**反向构造为真实宿主对象**（数组→`[]`、函数→宿主闭包、Error→宿主 Error），并用 `defineProperty` 按 guest 给的键名落属性 ⇒ 宿主对象图由 guest 决定。更糟的是实测它对**任何非原始值**都漏句柄，导致 runtime 无法释放、`JS_FreeRuntime` 断言 abort 掉整条进程（修复前 `return {a:1}` 就能打崩子进程）。现在在 guest 内 `JSON.stringify` 成 `aicode:<status>\n<payload>` 一帧，宿主 `JSON.parse` 后再过 `sanitize.js`（深度≤8/节点≤4000/数组≤500/键≤200/单串≤128K，丢弃 `__proto__`/`constructor`/`prototype`，超 512K 换 `{truncated,size,preview}`）——父子各做一次。`BigInt`/循环引用在 guest 内就被拦成 `UnserializableResult`。
- ⚠️ **`memoryLimit` 单位是字节**，且**大数组能绕过 QuickJS 记账**（8MB 限制下 RSS 可冲到 1.5GB）⇒ 子进程内另起 **RSS 监控 Worker** 超限 SIGKILL（必须在任何阻塞任务**之前**启动；`--permission` 下要 `--allow-worker`）。父进程把「非自己发起的 SIGKILL」判定为 poison。
- ⚠️ **`maxStackSize` 超过 256KB 会触发 quickjs-ng 断言 abort**，该 abort 必须按 fatal/poison 处理。
- `spawn` 必须 `delete env.NEONAIC`（内核哨兵会让子进程自杀）。`--permission --allow-fs-read=<ROOT>` 在 node_modules 是软链时要额外授权 `realpath(node_modules)`。
- **安全边界（实测 Node 22）**：写盘/删盘、读项目根**之外**、`child_process`、`process.binding` 都被拒绝；但**读项目根之内是允许的（含 `secret.json`）**、**网络完全不受限**（dns/tcp 实测可用）、环境变量继承父进程、`process.kill(ppid)` 可用。⇒ 真被攻陷时拿不到写盘与起子进程，但读得到密钥、连得上内网、能杀内核；这三条只能靠外部手段（独立低权限用户、容器网络策略、把密钥移出项目根）。QuickJS 侧实测 `process.env` 只有 `{NODE_DEBUG}`、`import('node:fs')` 报 "File access is disabled"、`fetch` 被禁用、`import('node:http')` 报 "not implemented"。
- 结果封顶 512K 字符、日志 200 条/16K；`vm` 层关 `codeGeneration.strings/wasm`；`onDisable` 必须 `unregisterAITool`（否则停用后仍被模型调用并重新拉起进程）。

## 小游戏（`extensions/`）
- **Wordle**（`wd`）：难度别名 `n`/`hard`/`uh`（**刻意不收 `h`**）；字母判定**按份数结算** ⇒ `missing` ≠「答案里没有」；参数解析 `sub = args[0]` 与 `param = args.join('')` 要分开判。**24 点**（`24`/`tf`/`tfp`）：4 数取自 1–13，**允许重复、不保证有解**（约 25% 无解），**每局一次机会**（只有 `invalid` 不消耗）；`/24 solve` 永远列全。
