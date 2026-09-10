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

/** 命令系统的一些枚举名 */
export const COMMAND_ENUMS = {
  /** 控制台执行的执行者名 @apiNote 请使用 {@link CommandContext.internalCall} 确认本点，以明确语义和避免恶意攻击。 */
  FROM_CONSOLE: '$console',
  /** 未知执行者，这一般表示当前上下文的某一层出现了不正确指定的执行者 */
  FROM_UNKNOW: '$unknown',
  /** 管理员权限 */
  PERM_ADMIN: 'admin',
  /** 超级管理员权限 */
  PERM_SUPERADMIN: 'superadmin',
};