import { NeonaicCommandContext, neonaicCommandServer } from '../../../src/command/commandServer.js';
import { parseString } from '../../../src/utils/chore.js';
import { neonaicMath } from '../../../src/utils/math.js';
import { clearSession, getAllSessionUser, hasSession, newSession as getSession, POKER_MAX, POKER_MIN, POKER_SIZE, TARGET, TwentyFourEnums, TwentyFourSession } from './session.js';

/** 会话超时时间，默认半小时，单位秒 */
const SESSION_TIMEOUT = 0.5 * 60 * 60;

/** 显示帮助的别名 */
const HELP_ALIASES = ['help', 'ver', 'version', '帮助'];
/** 重新发牌的别名 */
const NEW_ALIASES = ['new', 'restart', 'deal', '开局', '重开'];
/** 直接求全部解的别名 */
const SOLVE_ALIASES = ['solve', 'solution', 'solutions', 'all', '求解', '全部解'];
/** 声明无解的别名 */
const INSOLUBLE_ALIASES = ['?', '？', '无解', '无答案', 'insoluble', 'unsolvable', 'nosolution', 'none'];
/** 放弃本局的别名 */
const GIVEUP_ALIASES = ['stop', 'giveup', 'abandon', 'quit', 'exit', '放弃', '认输'];

/** 帮助文本 */
const HELP_TEXT = `24 Points Game for Neonaic By @kdxiaoyi

/24 help 显示本信息
/24 重新发牌
/24 <算式> 提交算式，例如 /24 (13-9)*7-4
/24 无解 或 /24 ?   认为这组牌无解
/24 stop 放弃本局
/24 solve 1 2 3 4   直接求出这 4 个数字的全部解（不会开局）

规则：用发到的 ${POKER_SIZE} 个数字各用一次，通过 + - × ÷ 与括号算出 ${TARGET}。
数字范围是 ${POKER_MIN}–${POKER_MAX}（对应扑克牌的 A–K），允许重复，且**不保证有解**。
每局只有一次机会：算式正确即通关，否则本局结束并公布全部解法。
算式无法使用时不计入机会（例如数字没用对、除数为零、用到了幂或根号）。`;

/**
 * 对局结束时最多列出多少条解法。
 * @apiNote 最极端的一手牌（1 4 8 12）有 98 条解法，全部列出会让消息很长；
 *          需要截断时把它改成一个正整数即可，`/24 solve` 永远列全。
 */
const MAX_LISTED_IN_GAME = Infinity;

/**
 * @this {import('../../../src/extension/extLoader.js').NeonaicExtItem}
 * @param {{ manifest: Object, pwd: String, ext_item_id: String, ext_item_timestamp: Number }} [ctx] 拓展上下文
 */
export function onEnable(ctx) {
  neonaicCommandServer.registerCommand('twentyfourpoints', '24', function (...v) {
    /** @type {NeonaicCommandContext} */
    const ctx = this;
    const user = ctx.executor[0];
    // 算式里是数字、运算符与括号，不能像 wordle 那样过滤掉非字母字符，这里原样保留
    const args = v.map((item) => parseString(item));
    const head = (args[0] ?? '').trim().toLowerCase();
    const joined = args.join('').trim();
    /** 子命令可能被空格拆开，因此原名与拼回后的整串都算命中 */
    const hit = (list) => list.includes(head) || list.includes(joined.toLowerCase());

    if (hit(HELP_ALIASES)) return HELP_TEXT;
    if (hit(SOLVE_ALIASES)) return solveFrom(args.slice(1));
    if (hit(NEW_ALIASES)) return buildIntro(startSession(user));

    // 其余操作都需要一局牌：没有就现场发一局，再把本次输入当作本局的操作（对齐 wordle 的语法糖）
    const fresh = !hasSession(user);
    const session = fresh ? startSession(user) : getSession(user, SESSION_TIMEOUT);

    // 裸命令（没有给任何参数）只报告牌面，不算一次作答
    if (!joined) return fresh ? buildIntro(session) : buildCurrent(session);

    if (hit(INSOLUBLE_ALIASES)) return buildInsoluble(session, session.declareInsoluble());

    if (hit(GIVEUP_ALIASES)) {
      // 刚刚才开始的一局没有可放弃的对象，改为给出牌面说明
      if (fresh) return buildIntro(session);
      clearSession(user);
      return buildGiveUp(session);
    }

    return buildGuess(session, joined, session.guess(joined));
  }, {
    description: "进行 24 点小游戏",
    usage: '24 <算式> 或 24 <help|new|无解|stop|solve 1 2 3 4>',
    alias: ['tf', 'tfp', 'twentyfour'],
  });
}

/**
 * @this {import('../../../src/extension/extLoader.js').NeonaicExtItem}
 */
export function onDisable() {
  getAllSessionUser().map(clearSession);
}

/** 结束旧的一局并开一局新的 @param {String} user */
function startSession(user) {
  clearSession(user);
  return getSession(user, SESSION_TIMEOUT);
}

/** 牌面的展示文本 @param {TwentyFourSession} session */
function pokerLine(session) {
  return session.poker.join('  ');
}

/** 把算式换成好看的乘除号 @param {String} expr */
function prettify(expr) {
  return parseString(expr).replaceAll('*', '×').replaceAll('/', '÷');
}

/**
 * 渲染解法的列表
 * @param {String[]} solutions 全部解法
 * @param {number} [limit] 最多列出多少条，默认不限
 * @returns {String}
 */
function renderSolutions(solutions, limit = Infinity) {
  if (!solutions.length) return '（这组牌无解）';
  const shown = solutions.slice(0, limit);
  let text = shown.map((expr, index) => `  ${String(index + 1).padStart(2, ' ')}. ${prettify(expr)} = ${TARGET}`).join('\n');
  if (solutions.length > shown.length) text += `\n  ……以及其余 ${solutions.length - shown.length} 条`;
  return text;
}

/** 开始新一局时的说明 @param {TwentyFourSession} session */
function buildIntro(session) {
  return [
    `🎴 新的 24 点牌局：${pokerLine(session)}`,
    '',
    `请把这 ${POKER_SIZE} 个数字各用一次，通过 + - × ÷ 与括号算出 ${TARGET}。`,
    `直接发送算式即可，例如 /24 (13-9)*7-4。如果你认为这组牌无解，发送 /24 无解。`,
    `每局只有一次机会，算式无法使用时不计入。`,
  ].join('\n');
}

/** 已有牌局、玩家只敲了裸命令时的回顾 @param {TwentyFourSession} session */
function buildCurrent(session) {
  return [
    `🎴 当前牌局：${pokerLine(session)}`,
    `请把这 ${POKER_SIZE} 个数字各用一次，通过 + - × ÷ 与括号算出 ${TARGET}。`,
    `直接发送算式即可；如果你认为这组牌无解，发送 /24 无解。`,
  ].join('\n');
}

/**
 * 提交算式后的回复
 * @param {TwentyFourSession} session
 * @param {String} expr 玩家提交的算式
 * @param {{status: String, value: number|null, error: Error|null}} result
 * @returns {String}
 */
function buildGuess(session, expr, result) {
  const hand = pokerLine(session);
  switch (result.status) {
    case TwentyFourEnums.invalid:
      return [
        `⚠️ 这个算式没能用上：${result.error?.message ?? '未知原因'}`,
        `本局牌面：${hand}`,
        `本次输入不计入机会，你仍然只有一次机会。`,
      ].join('\n');
    case TwentyFourEnums.right:
      return [
        `🎉 答对了！`,
        `  ${prettify(expr)} = ${TARGET}`,
        `本局牌面：${hand}`,
        `本题共有 ${session.solutionCount} 种解法。`,
      ].join('\n');
    case TwentyFourEnums.wrong:
      return [
        `❌ ${prettify(expr)} = ${result.value}，不是 ${TARGET}。`,
        `本局牌面：${hand}`,
        session.solutionCount === 0
          ? `而且这组牌其实是无解的 —— 下次可以试试直接用 /24 无解 判定。`
          : `全部解法（共 ${session.solutionCount} 条）：\n${renderSolutions(session.solutions, MAX_LISTED_IN_GAME)}`,
      ].join('\n');
    default:
      return `⚠️ 意料之外的结果：${parseString(result.status)}`;
  }
}

/**
 * 声明无解后的回复
 * @param {TwentyFourSession} session
 * @param {{status: String}} result
 * @returns {String}
 */
function buildInsoluble(session, result) {
  const hand = pokerLine(session);
  if (result.status === TwentyFourEnums.insoluble) {
    return `✅ 判断正确：${hand} 确实无解 —— 求解器枚举了全部括号结构与运算符组合，没有任何一条能算出 ${TARGET}。`;
  }
  return [
    `❌ ${hand} 其实有 ${session.solutionCount} 种解法，判定错误。`,
    renderSolutions(session.solutions, MAX_LISTED_IN_GAME),
  ].join('\n');
}

/** 放弃本局后的回复 @param {TwentyFourSession} session */
function buildGiveUp(session) {
  const hand = pokerLine(session);
  if (session.solutionCount === 0) {
    return `🏳️ 已放弃本局。本局牌面：${hand}\n这组牌无解 —— 下次可以试试直接用 /24 无解 判定。`;
  }
  return [
    `🏳️ 已放弃本局。本局牌面：${hand}`,
    `全部解法（共 ${session.solutionCount} 条）：`,
    renderSolutions(session.solutions, MAX_LISTED_IN_GAME),
  ].join('\n');
}

/**
 * 直接求解传入的 4 个数字，不会开局、也不消耗机会
 * @param {String[]} list 参数中的数字
 * @returns {String}
 */
function solveFrom(list) {
  const tokens = list.map((item) => parseString(item).trim()).filter((token) => token.length);
  if (tokens.length !== POKER_SIZE) {
    return `❓ solve 需要正好 ${POKER_SIZE} 个数字，例如 /24 solve 1 2 3 4（本次收到了 ${tokens.length} 个）`;
  }
  const numbers = [];
  for (const token of tokens) {
    if (!/^\d+$/.test(token)) return `❓ “${token}”不是正整数。（solve 只接受普通整数，不解析算式）`;
    const n = Number(token);
    if (!Number.isSafeInteger(n)) return `❓ “${token}”太大了。`;
    if (n < 1) return `❓ “${token}”无法参与求解：每个数字至少为 1。`;
    numbers.push(n);
  }
  const solutions = neonaicMath.solve24(numbers);
  if (!solutions.length) return `🧮 ${numbers.join(' ')} 无解（求解器枚举了全部括号结构与运算符组合）。`;
  return [
    `🧮 ${numbers.join(' ')} 的全部解法（共 ${solutions.length} 条）：`,
    renderSolutions(solutions),
  ].join('\n');
}
