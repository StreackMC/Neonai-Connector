---
name: neonai-temp-extension-live-test
description: "在 Neonai-Connector 里做「需要内核能力」的测试（连真实 QQ/平台、跑命令与 AI 全链路、验证收发与生命周期）时，不要 mock 内核：写一个临时拓展，取得授权后用真内核 `node main.js` 拉起，测试完删掉。含临时拓展的 manifest/entry 骨架、onEnable 早于平台启动的时序坑、onEnable 异常被加载器吞掉、兜底定时器与 shutdown 收尾、以及「哪些失败是假素材造成的」判别。触发词：线上测试/真机测试/连沙箱/发消息测试/不要 mock 内核/临时拓展/测试平台/内核拉不起来/qbot 测试。"
agent_created: true
---

# neonai-temp-extension-live-test：用临时拓展做线上测试

## 什么时候用

需要「内核真的跑起来」才能验证的东西：

- 平台连接与真实收发（QQ 沙箱群/私聊、消息审核、频控）；
- 命令 / AI / 权限 / 事件总线的全链路；
- 生命周期、看门狗、优雅关闭；
- 以及任何**依赖 ESM 求值顺序、单例、配置加载**的行为。

这时**不要**去手搓 PlatformManager + 日志 + 命令系统。那些桩代码要复现真实求值顺序（`#src/` 别名、`NeonaicNewable` 的 TDZ 环、`registerPlatform` 的时序），投入大、还容易把「桩写错」当成「被测代码有 bug」。

正确姿势：**写临时拓展 → 取得授权 → 拉起真内核 → 看日志 → 删掉拓展**。

## 前提：先拿授权

任何会触达外部服务（发消息、调用第三方 API、改线上状态）的测试，动手前必须明确：

- 具体会话（哪个群、哪个用户），要拿到完整标识，例如
  `qGRP#588A721FF0F068E24B68628F087AFB31@8528533035224324959`（`@` 后面是机器人自身 id）；
- 允许的动作（能发消息？能 @？能连续发几条？）。

没授权就只做离线断言（纯函数转换、构造结果比对），别连。

## 骨架

```
extensions/live-probe/
├── manifest.json
└── src/entry.js
```

`manifest.json`（`meta.id` **不能带连字符**，否则整个拓展不会被加载，只会留一条 `extH.warn`）：

```json
{
  "meta": { "version": [1, "0.0.0"], "id": "liveprobe" },
  "particulars": {
    "name": "Live Probe (temporary)",
    "author": ["neonai-agent"],
    "description": "临时拓展：验证 XXX，测试完即删。",
    "url": "", "license": "AGPL-3.0 modified"
  },
  "entry": "./src/entry.js",
  "depends": {}, "softdepends": {}
}
```

`src/entry.js` 必须同时导出 `onEnable` / `onDisable`（加载器强制要求），并在 `onEnable` 里**自己起一个自带 catch 的 async IIFE**：

```js
export async function onEnable() {
  (async () => {
    try {
      const pp = await waitForPlatform();          // 见下方时序
      await pp.sendMsg(GROUP, new NeonaicMessage('测试'));
    } catch (error) {
      getLogger().extH.error('[probe] 异常：', error);
    } finally {
      await neonaicLifeCycleManager.shutdown('PROBE-DONE');
    }
  })();
  timer = setTimeout(() => neonaicLifeCycleManager.shutdown('PROBE-TIMEOUT'), 60_000);
  timer.unref?.();
}
export function onDisable() { if (timer) { clearTimeout(timer); timer = null; } }
```

注：也可使用 EventBus 订阅各种消息类型并过滤得到内部过程结果，同时不干扰正常流程。

## 三个必踩的坑

**① onEnable 早于平台启动。** `bootstrap()` 的顺序是「先 `loadAll(extensions)`，后 `loadEnabled()`」，而且 `loadEnabled()` **没有被 await**。所以 onEnable 执行时平台实例要么不存在、要么还在 `start()` 中途。

判据要选对：`getPlatform(profile)` 返回实例 ≠ 已登录；必须等 `pp.selfInfo?.id` 有值，再发消息。

```js
const pp = PlatformManager.instance?.getPlatform?.(PROFILE);
if (pp?.bot && pp.selfInfo?.id) return pp;
```

**② onEnable 抛出的异常会被加载器吞掉。** `load()` 只把 `onEnable` 的异常转成 `status: 'failed'`，不会 throw 到你眼前。所以异步测试必须自己 try/catch 并写日志，否则表现是「什么都没发生」。

**③ 一定要有兜底收尾。** 测试失败时若不 shutdown，进程会被平台连接和保活定时器吊着。用 `setTimeout(...).unref()` 兜底 + `finally` 里 `shutdown()`；`onDisable` 里清定时器（`shutdown` 会卸载拓展，顺带调它）。

## 收尾

1. `rm -rf extensions/live-probe`；
2. **不要把临时拓展提交**（也不要给它起和正式拓展相近的 id，避免哪天误启用）；
3. 若它顺手暴露了正式代码的 bug，那些修复单独提交。

## 实证：真内核对 mock 的降维打击

2026-10-29 验证 qqbot 的 `NeonaicTValidMessage` 转换层时，先用桩跑通 53 条离线断言（全绿），再用临时拓展跑真内核，**立刻多抓到两个 mock 测不到的缺陷**：

- `PlatformQQBot.sendMsg(who, ...msg)` 把 rest 参数直接丢给 `new NeonaicMessage(msg)`：只传一个 `NeonaicMessage` 时会变成 `[NeonaicMessage]`，构造函数只收片段/字符串数组 ⇒ 抛 `IllegalArgument`。**桩测试里我传的是字符串，正好绕过了这条**。
- `NeonaicLinkMsgFrag` 的 `alt` 缺省时 `parseString(undefined)` 得到字面量 `"undefined"`，输出 `[文本](url "undefined")`。

另外，真机还会告诉你「失败到底是代码还是素材」：用 8 字节 PNG 头造图，QQ 回 `850019 富媒体文件格式不支持`；用不存在的 URL，回 `40093007 富媒体文件下载失败`——都是素材问题。换成真 1×1 PNG 与真实可下载地址后同一段代码就通了。**所以线上失败先怀疑测试数据，再怀疑代码。**

## 判断成功的依据

不要只看「没抛异常」。QQ 场景看 `SendResult`：有 `id` 才算提交成功，`brief` 能对照内容（例如 `<markdown,content=…>`、`<image:hash>`）；`audit_status === 'pending'` 是「审核中」，同样是成功提交。

## 与离线断言的分工

- 离线（纯函数、构造结果、边界与非法入参）→ 写成脚本，`node scripts/xxx.test.mjs`，零网络、可反复跑；
- 需要内核/外部服务的 → 临时拓展 + 真内核，一次性、有授权、跑完即删。

两者不互相替代：离线负责覆盖分支，临时拓展负责证明「在真实求值顺序下也成立」。
