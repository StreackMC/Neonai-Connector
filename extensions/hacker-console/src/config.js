import { neonaicConfManager } from '#src/system/confManager.js';

/** 拓展配置路径（相对项目根） */
const CONFIG_PATH = 'extensions/hacker-console/config.json';

/**
 * 缺省值。
 *
 * 所有读取都显式带默认值——`getInt`/`getString` 不传默认值时，
 * 「字段缺省」会得到 0 / undefined，被归一化层误判成「用户写了空值」。
 */
const DEFAULTS = Object.freeze({
  host: '127.0.0.1',
  port: 4780,
  token: '',
  executor: '$console',
  permission: 'aicode.execute',
  autoGrant: true,
  maxBodyBytes: 1048576,
});

/**
 * 读取并归一化拓展配置。
 *
 * @returns {{
 *   host: string,
 *   port: number,
 *   token: string,
 *   executor: string,
 *   permission: string,
 *   autoGrant: boolean,
 *   maxBodyBytes: number,
 *   issues: string[],
 * }}
 */
function load() {
  const conf = neonaicConfManager.getConfig(CONFIG_PATH);
  /** @type {string[]} 可容忍的问题：不影响启动，只记日志 */
  const issues = [];

  const host = conf.getString('host', DEFAULTS.host).trim() || DEFAULTS.host;
  // 这东西能跑任意代码，监听非回环地址时必须留下痕迹
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
    issues.push(`host = ${host} 不是回环地址；HackerConsole 会把任意代码执行能力暴露到网络上`);
  }

  const rawPort = conf.getInt('port', DEFAULTS.port);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    issues.push(`port = ${rawPort} 不合法，回退为 ${DEFAULTS.port}`);
  }

  const rawBody = conf.getInt('maxBodyBytes', DEFAULTS.maxBodyBytes);
  const maxBodyBytes = Number(rawBody);
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024) {
    issues.push(`maxBodyBytes = ${rawBody} 不合法，回退为 ${DEFAULTS.maxBodyBytes}`);
  }

  return {
    host,
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULTS.port,
    token: conf.getString('token', DEFAULTS.token).trim(),
    executor: conf.getString('executor', DEFAULTS.executor).trim() || DEFAULTS.executor,
    permission: conf.getString('permission', DEFAULTS.permission).trim(),
    autoGrant: conf.getBoolean('autoGrant', DEFAULTS.autoGrant),
    maxBodyBytes: Number.isInteger(maxBodyBytes) && maxBodyBytes >= 1024 ? maxBodyBytes : DEFAULTS.maxBodyBytes,
    issues,
  };
}

export const hackerConsoleConfig = Object.freeze({
  CONFIG_PATH,
  DEFAULTS,
  load,
});
