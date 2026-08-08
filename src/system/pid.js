/**
 * pid.js — PID 进程锁
 *
 * 防止多实例重复启动。旧锁对应的进程已不在运行时自动清理。
 *
 * 用法：
 *   import { acquirePidLock, releasePidLock } from './pid.js';
 *
 *   acquirePidLock(pidFilePath, logger);
 *   process.on('exit', () => releasePidLock(pidFilePath));
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

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
 * @param {import('./logger/logger.js').Logger} logger 日志器实例
 * @throws {Error} 已有实例运行时拒绝启动
 */
export function acquirePidLock(pidFile, logger) {
  if (existsSync(pidFile)) {
    const oldPid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
    if (pidAlive(oldPid)) {
      throw new Error(`检测到已有实例正在运行（PID ${oldPid}），拒绝重复启动`);
    }
    logger.main.warn(`自动清理失效 PID 锁（PID ${oldPid} 已不在运行）`);
    unlinkSync(pidFile);
  }
  writeFileSync(pidFile, String(process.pid), 'utf8');
}

/**
 * 释放 PID 锁（仅当锁内 PID 为当前进程时删除）。
 *
 * @param {string} pidFile PID 锁文件路径
 */
export function releasePidLock(pidFile) {
  try {
    if (!existsSync(pidFile)) return;
    const locked = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
    if (locked === process.pid) unlinkSync(pidFile);
  } catch {
    // 忽略释放时的竞态错误
  }
}
