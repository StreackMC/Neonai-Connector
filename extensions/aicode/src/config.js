import { neonaicConfManager } from '#src/system/confManager.js';

/** 拓展配置路径（相对项目根） */
const CONFIG_PATH = 'extensions/aicode/config.json';

/**
 * 缺省值。所有读取都会显式带上默认值——`getInt`/`getDouble` 不传默认值时，
 * 「字段缺省」会得到 0，被归一化层误判成「用户写了 0」。
 */
const DEFAULTS = Object.freeze({
  pool: Object.freeze({
    maxChildren: 10,
    idleMaxMinutes: 5,
    idleDecay: 0.5,
    feedIntervalMs: 20000,
    feedTimeoutMs: 60000,
    spawnTimeoutMs: 10000,
    nodePermissionModel: true,
    maxOldSpaceMB: 128,
  }),
  limits: Object.freeze({
    taskTimeoutMs: 12000,
    executionTimeoutMs: 10000,
    memoryLimitMB: 64,
    maxStackSizeKB: 256,
    maxRssMB: 256,
    maxCodeBytes: 65536,
  }),
  conversation: Object.freeze({
    maxConcurrent: 1,
  }),
  permission: 'aicode.execute',
});

/**
 * 读取并归一化拓展配置。
 *
 * @returns {{
 *   pool: { maxChildren: number, idleMaxMinutes: number, idleMaxMs: number, idleDecay: number,
 *           feedIntervalMs: number, feedTimeoutMs: number, spawnTimeoutMs: number,
 *           nodePermissionModel: boolean, maxOldSpaceMB: number },
 *   limits: { taskTimeoutMs: number, executionTimeoutMs: number, memoryLimitMB: number,
 *             memoryLimitBytes: number, maxStackSizeKB: number, maxStackSizeBytes: number,
 *             maxRssMB: number, maxRssBytes: number, maxCodeBytes: number },
 *   conversation: { maxConcurrent: number },
 *   permission: string,
 *   issues: string[],
 * }}
 */
function load() {
  const conf = neonaicConfManager.getConfig(CONFIG_PATH);
  /** @type {string[]} 可容忍的问题；不影响启动，但会记日志 */
  const issues = [];

  /**
   * 读一个正数，非法时回退默认值并记一条 issue。
   * @param {string} key
   * @param {number} def
   * @param {{ min?: number, max?: number, integer?: boolean }} [range]
   * @returns {number}
   */
  const positive = (key, def, range = {}) => {
    const raw = range.integer ? conf.getInt(key, def) : conf.getDouble(key, def);
    const value = Number(raw);
    const { min = 0.01, max = Number.MAX_SAFE_INTEGER, integer = false } = range;
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      issues.push(`${key} = ${raw} 不合法，回退为 ${def}`);
      return def;
    }
    return value;
  };

  /**
   * 读最大待机时长；兼容旧键 `pool.idleMinutes`（当时它同时充当「唯一一个待机时长」）。
   * @returns {number}
   */
  const idleMaxMinutesOf = () => {
    const hasNew = conf.isExist('pool.idleMaxMinutes');
    const hasOld = conf.isExist('pool.idleMinutes');
    if (hasNew && hasOld) {
      issues.push('pool.idleMinutes 已弃用（与 pool.idleMaxMinutes 同时存在时以新键为准）');
    } else if (!hasNew && hasOld) {
      issues.push('pool.idleMinutes 已改名为 pool.idleMaxMinutes，本次按旧键读取');
    }
    const key = hasNew || !hasOld ? 'pool.idleMaxMinutes' : 'pool.idleMinutes';
    return positive(key, DEFAULTS.pool.idleMaxMinutes, { min: 0.01, max: 1440 });
  };

  const pool = {
    maxChildren: positive('pool.maxChildren', DEFAULTS.pool.maxChildren, { min: 1, max: 32, integer: true }),
    // 最大待机时长：待机阶梯里**最后**一个进程的存活时长（也是子进程自己的兜底上限）
    idleMaxMinutes: idleMaxMinutesOf(),
    // 递减系数：0 = 所有待机进程同时到期（旧行为），1 = 最快削峰（最早的进程只留 idleMax/k）
    idleDecay: positive('pool.idleDecay', DEFAULTS.pool.idleDecay, { min: 0, max: 1 }),
    feedIntervalMs: positive('pool.feedIntervalMs', DEFAULTS.pool.feedIntervalMs, { min: 1000, max: 300000, integer: true }),
    feedTimeoutMs: positive('pool.feedTimeoutMs', DEFAULTS.pool.feedTimeoutMs, { min: 2000, max: 600000, integer: true }),
    spawnTimeoutMs: positive('pool.spawnTimeoutMs', DEFAULTS.pool.spawnTimeoutMs, { min: 1000, max: 120000, integer: true }),
    nodePermissionModel: conf.getBoolean('pool.nodePermissionModel', DEFAULTS.pool.nodePermissionModel),
    maxOldSpaceMB: positive('pool.maxOldSpaceMB', DEFAULTS.pool.maxOldSpaceMB, { min: 16, max: 4096, integer: true }),
  };
  pool.idleMaxMs = Math.round(pool.idleMaxMinutes * 60000);

  const limits = {
    taskTimeoutMs: positive('limits.taskTimeoutMs', DEFAULTS.limits.taskTimeoutMs, { min: 500, max: 300000, integer: true }),
    executionTimeoutMs: positive('limits.executionTimeoutMs', DEFAULTS.limits.executionTimeoutMs, { min: 100, max: 300000, integer: true }),
    // 传给 QuickJS 的堆上限（字节制）；大数组可能绕过它的记账，另有 maxRssMB 监控线程兜底
    memoryLimitMB: positive('limits.memoryLimitMB', DEFAULTS.limits.memoryLimitMB, { min: 8, max: 4096 }),
    // 0.5MB 以上会触发 quickjs-ng 的断言 abort，这里硬性封顶在 256KB
    maxStackSizeKB: positive('limits.maxStackSizeKB', DEFAULTS.limits.maxStackSizeKB, { min: 64, max: 256 }),
    maxRssMB: positive('limits.maxRssMB', DEFAULTS.limits.maxRssMB, { min: 32, max: 8192 }),
    maxCodeBytes: positive('limits.maxCodeBytes', DEFAULTS.limits.maxCodeBytes, { min: 1024, max: 1048576, integer: true }),
  };
  // QuickJS 的 memoryLimit 按字节计（运行时自身基线约 32KB；大数组可能绕过该记账，另有 RSS 监控兜底）
  limits.memoryLimitBytes = Math.round(limits.memoryLimitMB * 1024 * 1024);
  limits.maxStackSizeBytes = Math.round(limits.maxStackSizeKB * 1024);
  limits.maxRssBytes = Math.round(limits.maxRssMB * 1024 * 1024);

  const conversation = {
    maxConcurrent: positive('conversation.maxConcurrent', DEFAULTS.conversation.maxConcurrent, { min: 1, max: 8, integer: true }),
  };

  const permission = conf.getString('permission', DEFAULTS.permission).trim();

  // 交叉不变量：父进程的硬超时必须晚于 QuickJS 的软超时，否则永远等不到 ExecutionTimeout。
  if (limits.taskTimeoutMs <= limits.executionTimeoutMs) {
    const fixed = limits.executionTimeoutMs + 2000;
    issues.push(`limits.taskTimeoutMs(${limits.taskTimeoutMs}) 必须大于 executionTimeoutMs(${limits.executionTimeoutMs})，已按 ${fixed} 处理`);
    limits.taskTimeoutMs = fixed;
  }
  // RSS 上限必须给 QuickJS 堆留出余量，否则正常任务也会被 poison。
  const minRss = limits.memoryLimitMB + 128;
  if (limits.maxRssMB < minRss) {
    issues.push(`limits.maxRssMB(${limits.maxRssMB}) 相对 memoryLimitMB(${limits.memoryLimitMB}) 过小，已按 ${minRss} 处理`);
    limits.maxRssMB = minRss;
    limits.maxRssBytes = Math.round(minRss * 1024 * 1024);
  }

  // 喂食周期必须明显短于断粮判定，否则正常喂食也会被判成超时。
  if (pool.feedIntervalMs * 2 > pool.feedTimeoutMs) {
    const fixed = Math.max(1000, Math.floor(pool.feedTimeoutMs / 3));
    issues.push(`pool.feedIntervalMs(${pool.feedIntervalMs}) 相对 feedTimeoutMs(${pool.feedTimeoutMs}) 过长，已按 ${fixed} 处理`);
    pool.feedIntervalMs = fixed;
  }

  return { pool, limits, conversation, permission, issues };
}

export const aicodeConfig = Object.freeze({
  CONFIG_PATH,
  DEFAULTS,
  load,
});
