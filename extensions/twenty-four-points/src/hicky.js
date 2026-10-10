import z from "zod";
import { clearSession, getAllSessionUser, hasSession, newSession as getSession, POKER_MAX, POKER_MIN, POKER_SIZE, TARGET, TwentyFourEnums, TwentyFourSession } from './session.js';
import { neonaicAI } from "../../../src/message/ai.js";
import { neonaicPermissionServer } from "../../../src/command/permissionServer.js";
import { neonaicCommandInterface } from "../../../src/command/commandInterface.js";
import { NeonaicCommandContext, neonaicCommandServer } from '../../../src/command/commandServer.js';
import { parseString } from '../../../src/utils/chore.js';
import { neonaicMath } from '../../../src/utils/math.js';

/** 会话超时时间，单位秒 */
const SESSION_TIMEOUT = 10 * 60;

/** 作弊的别名 */
const CHEAT_ALIASES = ['win', 'cheat'];
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

“/24 help” 显示本信息
“/24” 重新发牌
“/24 <算式>” 提交算式，例如 /24 (13-9)*7-4
“/24 无解” 或 “/24 ?”   认为这组牌无解
“/24 stop” 放弃本局
“/24 solve 1 2 3 4 [target=24]”   直接求出这 4 个数字的全部解（不会开局）

规则：用发到的 ${POKER_SIZE} 个数字各用一次，通过 + - × ÷ 与括号算出 ${TARGET}。
数字范围是 ${POKER_MIN}–${POKER_MAX}，允许重复，并不保证有解。
算式无法使用时不计入机会（例如数字没用对、除数为零、用到了幂或根号）。`;

/**
 * 对局结束时最多列出多少条解法。
 * @apiNote 最极端的一手牌（1 4 8 12）有 98 条解法，全部列出会让消息很长；
 *          需要截断时把它改成一个正整数即可，`/24 solve` 永远列全。
 */
const MAX_LISTED_IN_GAME = 5;

export function registerMathSupportForAI() {
  // ai tool
  neonaicAI.registerAITool('twentyfourpoints', '24solver', {
    description: '求解指定的 24 点游戏',
    inputSchema: z.object({
      poker: z.array(z.number().int().min(1).max(13)).length(4).describe('四张牌的点数，范围 1~13'),
      target: z.number().int().min(1).max(100).optional().default(24).describe('目标点数，默认 24'),
    }).describe('四张牌的点数和目标点数'),
    execute: ({ poker, target }) => {
      return neonaicMath.solve24(poker, target);
    },
  });

  // cmd
  neonaicCommandServer.registerCommand('twentyfourpoints', '24', function (...v) {
    /** @type {NeonaicCommandContext} */
    const ctx = this;
    const user = ctx.executor[0];
    // 算式里是数字、运算符与括号，不能像 wordle 那样过滤掉非字母字符，这里原样保留
    const args = v.map((item) => parseString(item));
    const head = (args[0] ?? '').trim().toLowerCase();
    const joined = args.join('').trim();
    const unavailable_game = !hasSession(user);
    /** 子命令可能被空格拆开，因此原名与拼回后的整串都算命中 */
    const hit = (list) => list.includes(head) || list.includes(joined.toLowerCase());

    if (hit(HELP_ALIASES)) return HELP_TEXT;
    if (hit(SOLVE_ALIASES)) {
      if (!unavailable_game) {
        // 有游戏时用求解器直接拒绝
        return `你正处在一局 24 点游戏中，暂时无法使用求解器。使用“/24 stop”放弃游戏。`;
      }
      return solveFrom(args.slice(1));
    };
    if (hit(NEW_ALIASES)) return buildIntro(startSession(user));

    // 其余操作都需要一局牌：没有就现场发一局，再把本次输入当作本局的操作（对齐 wordle 的语法糖）
    const session = unavailable_game ? startSession(user) : getSession(user, SESSION_TIMEOUT);

    // 作弊模式，将参数替换成解
    if (hit(CHEAT_ALIASES) && !unavailable_game) {
      if (!neonaicPermissionServer.checkPermissionFromContext(
        ctx,
        [[neonaicCommandInterface.COMMAND_ENUMS.PERM_ADMIN, neonaicCommandInterface.COMMAND_ENUMS.PERM_SUPERADMIN, 'twtwentyfourpoints.command.cheat']]
      )) return `你没有权限使用该命令。`;
      const solutions = neonaicMath.solve24(session.poker, 24);
      if (solutions.length == 0) {
        return buildGuess(session, '$cheat', session.declareInsoluble());
      } else {
        return buildGuess(session, '$cheat', session.guess(solutions[0]));
      }
    };

    // 裸命令（没有给任何参数）只报告牌面，不算一次作答
    if (!joined) return unavailable_game ? buildIntro(session) : buildCurrent(session);

    if (hit(INSOLUBLE_ALIASES)) return buildInsoluble(session, session.declareInsoluble());

    if (hit(GIVEUP_ALIASES)) {
      // 刚刚才开始的一局没有可放弃的对象，改为给出牌面说明
      if (unavailable_game) return buildIntro(session);
      clearSession(user);
      return buildGiveUp(session);
    }

    return buildGuess(session, joined, session.guess(joined));
  }, {
    description: "进行 24 点小游戏",
    usage: '/24 <算式> 或 /24 <help|new|无解|stop|solve 1 2 3 4 [target]>',
    alias: ['tf', 'tfp', 'twentyfour'],
    permissions: ['twentyfourpoints.commands.tf'],
    permissionDefault: true,
  });
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
    `→ ${pokerLine(session)} ←`,
    `请把这 ${POKER_SIZE} 个数字各用一次，通过 + - × ÷ 与括号算出 ${TARGET}。`,
    `直接发送算式即可，例如“/24 (13-9)*7-4”。如果你认为这组牌无解，发送“/24 ?”。`,
  ].join('\n');
}

/** 已有牌局、玩家只敲了裸命令时的回顾 @param {TwentyFourSession} session */
function buildCurrent(session) {
  return [
    `→ ${pokerLine(session)} ←`,
    `请把这 ${POKER_SIZE} 个数字各用一次，通过 + - × ÷ 与括号算出 ${TARGET}。`,
    `直接发送算式即可，例如“/24 (13-9)*7-4”。如果你认为这组牌无解，发送“/24 ?”。`,
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
        `⚠ 这个算式没能用上：${result.error?.message ?? '未知原因'}`,
        '',
        `→ ${hand} ←`,
        `请把这 ${POKER_SIZE} 个数字各用一次，在 10 分钟内通过 + - × ÷ 与括号算出 ${TARGET}。`,
        `直接发送算式即可，例如“/24 (13-9)*7-4”。如果你认为这组牌无解，发送“/24 ?”。`,
      ].join('\n');
    case TwentyFourEnums.right:
      return [
        `✓ 答对了！`,
        `  ${prettify(expr)} = ${TARGET}`,
        `→ ${hand} ←`,
        `本题共有 ${session.solutionCount} 种解法。`,
      ].join('\n');
    case TwentyFourEnums.wrong:
      return [
        `× ${prettify(expr)} = ${result.value}，不是 ${TARGET}。`,
        `→ ${hand} ←`,
        session.solutionCount === 0
          ? `这些数字是无解的。`
          : `全部 ${session.solutionCount} 条解法：\n${renderSolutions(session.solutions, MAX_LISTED_IN_GAME)}`,
      ].join('\n');
    default:
      return `⚠ 意料之外的结果：${parseString(result.status)}`;
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
    return `✓ 恭喜，${hand} 确实无解。`;
  }
  return [
    `× ${hand} 其实有以下 ${session.solutionCount} 种解法：`,
    renderSolutions(session.solutions, MAX_LISTED_IN_GAME),
  ].join('\n');
}

/** 放弃本局后的回复 @param {TwentyFourSession} session */
function buildGiveUp(session) {
  const hand = pokerLine(session);
  if (session.solutionCount === 0) {
    return `× 已放弃本局。\n→ ${hand} ←\n这些数字是无解的。`;
  }
  return [
    `× 已放弃本局。`,
    `→ ${hand} ←`,
    `全部 ${session.solutionCount} 条解法：`,
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
  if (tokens.length === POKER_SIZE) {
    return solveFrom([...tokens, 24]);
  } else if (tokens.length === POKER_SIZE + 1) {
    const numbers = [];
    for (const token of tokens) {
      if (!/^\d+$/.test(token)) return `❓ “${token}”不是正整数`;
      const n = Number(token);
      if (!Number.isSafeInteger(n)) return `❓ “${token}”太大了。`;
      if (n < 1) return `❓ “${token}”无法参与求解：每个数字至少为 1。`;
      numbers.push(n);
    }
    const target = numbers.pop();
    const solutions = neonaicMath.solve24(numbers, target);
    if (!solutions.length) return `${numbers.join(' ')} 无法通过任何组合得到 ${target} ，因此无解。`;
    return [
      `${numbers.join(' ')} 算出 ${target} 的全部解法有 ${solutions.length} 条：`,
      renderSolutions(solutions),
    ].join('\n');
  } else {
    return `求解器接收到不对的参数数量`;
  }
}