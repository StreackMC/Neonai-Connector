/**
 * 父进程 ↔ 子进程的 IPC 消息类型。
 *
 * 只走 `child.send()` / `process.send()` —— `channel.emit()` 只在本进程内触发，
 * 不会跨进程（曾经踩过：父发 `channel.emit('code')`，子进程永远收不到）。
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
