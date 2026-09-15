/**
 * pidManager.js — PID 进程锁
 *
 * 防止多实例重复启动。旧锁对应的进程已不在运行时自动清理。
 *
 * 用法：
 *   import { NeonaicPidManager } from './pidManager.js';
 *
 *   NeonaicPidManager.acquirePidLock(pidFilePath, logger);
 *   process.on('exit', () => NeonaicPidManager.releasePidLock(pidFilePath));
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { NeonaicIllegalStateError } from '../utils/NeonaicNewableError.js';

/**
 * 判断某 PID 是否仍在运行。
 *
 * @param {number} pid
 * @returns {boolean}
 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM：进程存在但无操作权限，同样视为存活
    return err.code === 'EPERM';
  }
}

/**
 * 获取 PID 进程锁。若锁文件存在且对应 PID 已不在运行则自动清理。
 *
 * @param {string} pidFile PID 锁文件路径
 * @param {import('../logger/Logger.js').neonaicLogger} logger 日志器实例
 * @throws {Error} 已有实例运行时拒绝启动
 */
function acquirePidLock(pidFile, logger) {
  if (existsSync(pidFile)) {
    const oldPid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
    if (pidAlive(oldPid)) {
      throw new NeonaicIllegalStateError(`检测到已有实例正在运行（PID ${oldPid}），拒绝重复启动`);
    }
    logger.main.warn(`自动清理失效 PID 锁（PID ${oldPid} 已不在运行）`);
    unlinkSync(pidFile);
  }
  writeFileSync(pidFile, String(process.pid), 'utf8');
}

/**
 * 等待上一个实例释放 PID 锁（供进程级重启的接棒使用）。
 *
 * 新实例由旧实例 spawn 出来，而旧实例此时还活着、锁还在它名下，
 * 直接 `acquirePidLock` 会被判定为「已有实例正在运行」。这里先等锁空出来。
 *
 * @param {string} pidFile PID 锁文件路径
 * @param {number} [timeoutMs=10000] 最长等待时间
 * @param {number} [intervalMs=100] 轮询间隔
 * @returns {Promise<boolean>} 是否已经可以接棒（锁不存在或锁内 PID 已死）
 */
async function waitForHandover(pidFile, timeoutMs = 10000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!existsSync(pidFile)) return true;
    let locked = NaN;
    try {
      locked = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
    } catch {
      // 读不到（正在被改写）也算暂时不能接棒，下一轮再说
    }
    if (locked === process.pid || !pidAlive(locked)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * 释放 PID 锁（仅当锁内 PID 为当前进程时删除）。
 *
 * @param {string} pidFile PID 锁文件路径
 */
function releasePidLock(pidFile) {
  try {
    if (!existsSync(pidFile)) return;
    const locked = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
    if (locked === process.pid) unlinkSync(pidFile);
  } catch {
    // 忽略释放时的竞态错误
  }
}

export const neonaicPidManager = {
  acquirePidLock,
  waitForHandover,
  releasePidLock,
};
