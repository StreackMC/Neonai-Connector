#!/usr/bin/env node

/**
 * main.js — 项目入口（组合根 Composition Root）
 *
 * 职责：加载配置 -> 创建日志器 -> 获取 PID 进程锁（自动清理旧锁）
 *       -> 按配置加载各平台监听器 -> 注册信号处理并优雅关闭。
 *
 * 本模块可被其他模块 import 以复用共享单例：
 *   getConfigs() / getLogger()（惰性初始化，import 本身不产生副作用）。
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAllConfigs } from './src/conf.js';
import { createLogger } from './src/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** PID 锁文件路径（防止多实例重复启动） */
const PID_FILE = resolve(__dirname, '.neonai.pid');

/** 共享单例（惰性初始化） */
let _configs = null;
let _logger = null;

/** 已加载监听器的清理函数集合 */
let closers = [];

/** 获取全部配置（首次调用时加载） */
export function getConfigs() {
  if (!_configs) _configs = loadAllConfigs();
  return _configs;
}

/**
 * 获取日志器（首次调用时创建）。
 * @returns {import('./src/logger.js').Logger} 共享日志器实例
 */
export function getLogger() {
  if (!_logger) {
    const { logDir, maxFileSize } = getConfigs().logger;
    _logger = createLogger({ logDir, maxFileSize });
  }
  return _logger;
}

/** 判断某 PID 是否仍在运行 */
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

/** 获取 PID 进程锁；旧锁对应的进程已不在时自动清理并重建 */
function acquirePidLock() {
  if (existsSync(PID_FILE)) {
    const oldPid = Number.parseInt(readFileSync(PID_FILE, 'utf8'), 10);
    if (pidAlive(oldPid)) {
      throw new Error(`检测到已有实例正在运行（PID ${oldPid}），拒绝重复启动`);
    }
    getLogger().main.warn(`自动清理失效 PID 锁（PID ${oldPid} 已不在运行）`);
    unlinkSync(PID_FILE);
  }
  writeFileSync(PID_FILE, String(process.pid), 'utf8');
}

/** 释放 PID 锁（仅当锁内 PID 为当前进程时删除） */
function releasePidLock() {
  try {
    if (!existsSync(PID_FILE)) return;
    const locked = Number.parseInt(readFileSync(PID_FILE, 'utf8'), 10);
    if (locked === process.pid) unlinkSync(PID_FILE);
  } catch {
    // 忽略释放时的竞态错误
  }
}

/** 按配置加载各平台监听器，并收集其清理函数 */
async function loadAllListeners() {
  const { main } = getConfigs();
  if (main?.listening?.qqbot) {
    getLogger().main.info('正在加载 QQBot 传入流监听');
    const module = await import('./src/QQBot/entry.js');
    const handle = module.init();
    if (typeof handle === 'function') {
      closers.push(handle);
    } else if (handle && typeof handle.close === 'function') {
      closers.push(() => handle.close());
    }
  } else {
    getLogger().main.info('由配置决定的不加载 QQBot 传入流监听');
  }
}

let shuttingDown = false;

/** 优雅关闭：依次释放监听器，5 秒内未完成则强制退出；PID 锁由 exit 钩子清理 */
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  getLogger().main.warn(`收到 ${signal}，正在关闭…`);

  // 兜底：5 秒内未能优雅退出则强制退出
  const forceTimer = setTimeout(() => process.exit(1), 5000);
  forceTimer.unref();

  await Promise.allSettled(closers.map((close) => close()));
  closers = [];

  getLogger().main.info('服务已关闭');
  process.exit(0);
}

/** 启动流程 */
async function bootstrap() {
  const { name } = getConfigs().app;
  getLogger().main.info(`${name} 服务启动`);

  acquirePidLock();
  await loadAllListeners();

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('exit', releasePidLock);
}

bootstrap().catch((err) => {
  try {
    getLogger().main.error(`启动失败: ${err.message}`);
  } catch {
    // 配置加载失败时日志器尚不可用，退化为控制台输出
    console.error('[FATAL] 启动失败:', err);
  }
  process.exit(1);
});