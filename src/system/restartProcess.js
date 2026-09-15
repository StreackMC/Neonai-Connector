/**
 * restartProcess.js — 进程级重启的共用部分
 *
 * 有两个调用方，两边都不能带重依赖：
 *   1. 主进程（watchdog.js 与 /restart 命令）主动重启；
 *   2. 看门狗的 Worker：主线程被同步代码卡死、自己救不了自己时强行重启。
 * 因此本模块只依赖 node:child_process。
 */

import { spawn } from 'node:child_process';

/** 标记「本次启动来自进程内重启」的环境变量名 @type {String} */
export const RESTART_ENV = 'NEONAIC_RESTART';

/**
 * 以分离进程的方式重新拉起自身。
 * @apiNote 新进程会带上 {@link RESTART_ENV}，于是它启动时会先等旧实例释放 PID 锁，
 *          否则新进程会因为在旧进程还活着时就抢锁而被 `acquirePidLock` 拒绝。
 * @apiNote 用 `detached` + `unref`，让新进程不受当前进程退出影响；`stdio: 'inherit'`
 *          让它继续使用同一个终端。
 * @apiNote **必须显式传入 argv**：在 Worker 线程里 `process.argv` 会被改写成 Worker 自己的
 *          入口文件（`['…/node', '…/watchdog.worker.js']`），照默认值取会把 Worker 文件
 *          当成主程序拉起来 —— 看门狗那条路因此由主线程把 argv 显式传进 Worker。
 * @param {String[]} [argv=process.argv.slice(1)] 新进程要执行的脚本与参数
 * @returns {Promise<number>} 新进程的 PID
 * @throws {Error} 子进程拉起失败（error 事件）
 */
function spawnReplacement(argv = process.argv.slice(1)) {
  return new Promise((resolve, reject) => {
    // 入口未知时宁可失败：spawn 一个没有脚本的 node 会拉起 REPL，那就等于服务没了
    if (!Array.isArray(argv) || argv.length === 0) {
      reject(new Error('无法确定要重启的入口脚本（argv 为空）'));
      return;
    }
    const child = spawn(process.execPath, argv, {
      cwd: process.cwd(),
      detached: true,
      stdio: 'inherit',
      env: { ...process.env, [RESTART_ENV]: String(Date.now()) },
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve(child.pid);
    });
  });
}

/** 本次启动是否来自进程内重启 @returns {boolean} */
function isRestart() {
  return !!process.env[RESTART_ENV];
}

export const neonaicRestartProcess = {
  RESTART_ENV,
  spawnReplacement,
  isRestart,
};
