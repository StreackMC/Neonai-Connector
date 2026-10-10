/**
 * 权限表达式。
 *
 * 叶子是字符串，可带 `!` 前缀表示「须缺失」；数组是分组，分组语义**按嵌套深度交替**：
 * 第 0 层（最外层）AND → 第 1 层 OR → 第 2 层 AND → 第 3 层 OR → … 以此类推。
 *
 * 例：
 *   'a'                  → a
 *   ['a', 'b']           → a AND b
 *   [['a', 'b']]         → a OR b
 *   [['a', 'b'], 'c']    → (a OR b) AND c
 *   [[['a', 'b'], 'c']]  → (a AND b) OR c
 *
 * 空数组取单位元：AND 层为 true、OR 层为 false；最外层 `[]` 表示「无要求」（恒通过）。
 * @typedef {string|PermissionSpec[]} PermissionSpec
 */

/**
 * @typedef {Object} CommandRegisterOptions
 * @property {string|string[]} [alias=[]] 别名设置
 * @property {PermissionSpec} [permissions=[]] 需求权限（见 {@link PermissionSpec}）；默认 `[]` = 无要求，任何人可执行
 * @property {boolean} [permissionDefault=false] 权限叶子在**未显式设置**时的判定值（等价于 checkPermission 的 fallback）。
 *   默认 false 即「未设置 = 不具备该权限」；设为 true 即「默认授予」，此时 `'!perm'` 会因默认值被取反而不通过
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
 * @property {PermissionSpec} permissions 需求权限
 * @property {boolean} permissionDefault 权限叶子未显式设置时的判定值
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
  /** 匿名：通常按一般用户处理，所以不应为该用户授予任何权限 */
  ANONYMITY: '$anonymous',
};

export const neonaicCommandInterface = {
  COMMAND_ENUMS,
};
