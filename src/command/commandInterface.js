/**
 * @typedef {Object} CommandRegisterOptions
 * @property {string|string[]} [alias=[]] 别名设置
 * @property {(string|string[])[]|string|string[]} [permissions=[]] 需求权限：第一层数组间为 AND 关系，第二层数组间为 OR 关系；有 ! 前缀表示需要缺失该权限。
 * @property {string} [description=""] 命令描述
 * @property {string} [usage=""] 命令用法
 */

/**
 * 命令条目。
 * @typedef {object} CommandMeta
 * @property {string} namespace 命名空间（'' 表示全局）
 * @property {string} name 原名
 * @property {string[]} aliases 别名列表
 * @property {Function} handler
 * @property {string[]} permissions
 * @property {string} [description]
 * @property {string} [usage]
 */

/**
 * 命令系统的一些枚举名
 *
 * @apiNote `$` 前缀是**合成执行者**（synthetic executor）的保留命名空间：这类身份不由真实用户扮演，
 *          也不携带 `internalCall` 语义（即权限检查照常生效），其授权完全由权限系统按
 *          **执行者字符串**逐条授予，因此无需登记。
 *          <p>
 *          核心在此**只声明自身需要的**合成身份（控制台、未知）；**拓展若需要自己的合成身份，
 *          应当在拓展内定义自己的常量**，不要把拓展名写进本枚举 —— 否则本体就会因为一个
 *          可拆卸的拓展而多出一份死常量，破坏「拓展与本体解耦」。
 */
const COMMAND_ENUMS = {
  /** 控制台执行的执行者名 @apiNote 请使用 {@link import('./commandServer.js').NeonaicCommandContext}.internalCall 确认本点，以明确语义和避免恶意攻击。 */
  FROM_CONSOLE: '$console',
  /** 未知执行者，这一般表示当前上下文的某一层出现了不正确指定的执行者 */
  FROM_UNKNOW: '$unknown',
  /** 管理员权限 */
  PERM_ADMIN: 'admin',
  /** 超级管理员权限 */
  PERM_SUPERADMIN: 'superadmin',
};

export const neonaicCommandInterface = {
  COMMAND_ENUMS,
};
