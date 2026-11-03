/**
 * 父进程 ↔ 子进程的 IPC 消息类型。
 *
 * 通道本身**不是** Node 的 `child.send()` / `process.send()`：那是两条私用管道
 * （子读 fd 3 / 写 fd 4）+ 自研分帧，原因见 `framing.js` 开头。
 * 这里只定义分帧之内的消息类型。
 */
export const IPC = Object.freeze({
  /** 子进程就绪（父进程据此结束 spawn 等待） */
  READY: 'ready',
  /** 父 → 子：执行一段代码 */
  TASK: 'task',
  /** 父 → 子：喂食，重置断粮看门狗 */
  FEED: 'feed',
  /** 子 → 父：任务结果 */
  RESULT: 'result',
  /** 子 → 父：进程已被资源限制污染，即将自杀 */
  POISON: 'poison',
  /** 子 → 父：即将正常退出（空闲/停机） */
  BYE: 'bye',
  /** 父 → 子：优雅停机 */
  SHUTDOWN: 'shutdown',
});

/**
 * RSS 监控线程自杀前写到 stderr 的标记。
 *
 * 父进程只能看到 `signal=SIGKILL`，无法区分「我们的监控线程」和「外部 kill / 系统 OOM killer」，
 * 所以让子进程在杀自己之前先留一行日志；父进程从 `worker.tail` 里认这个标记。
 * 认不出来就按「外部 SIGKILL」处理，不再一律当成资源超限。
 */
export const RSS_KILL_MARKER = '[aicode:rss-limit]';

