import { neonaicCommandInterface } from '../../../src/command/commandInterface.js';
import { NeonaicCommandContext, neonaicCommandServer } from '../../../src/command/commandServer.js';
import { neonaicPermissionServer } from '../../../src/command/permissionServer.js';
import { parseString } from '../../../src/utils/chore.js';
import { NeonaicIllegalArgumentError, NeonaicIllegalStateError } from '../../../src/utils/NeonaicNewableError.js';
import { clearSession, hasSession, newSession as getSession, resolveDifficulty, WordleDifficulty, WordleEnums, WordleSession } from './session.js';
import { toFullLetter } from './word_provider.js';

/** 会话超时时间，默认半小时，单位秒 */
const SESSION_TIMEOUT = 0.5 * 60 * 60;

/** 难度 → 中文名 */
const DIFFICULTY_LABELS = Object.freeze({
  [WordleDifficulty.normal]: '普通',
  [WordleDifficulty.hard]: '困难',
  [WordleDifficulty.uhard]: '极限',
});

/** 难度 → 开始游戏时追加的规则说明 */
const DIFFICULTY_RULES = Object.freeze({
  [WordleDifficulty.normal]: '',
  [WordleDifficulty.hard]: '\n本局难度为困难：猜中过的绿色字母不能挪位置，出现过的黄色字母必须继续使用。',
  [WordleDifficulty.uhard]: '\n本局难度为极限：在困难的基础上，黄色字母还必须换一个位置，已经排除的白色字母也不能再出现。',
});

/** 查询历史的别名 */
const HISTORY_ALIASES = ['h', 'history', 'tries', 'try'];
/** 放弃对局的别名 */
const ABANDON_ALIASES = ['abandon', 'givenup', 'quit', 'exit', 'stop'];
/** 开始新游戏的别名 */
const NEW_ALIASES = ['new', 'restart'];
/** 显示帮助的别名 */
const HELP_ALIASES = ['help', 'ver', 'version'];
/** 作弊指令别名 */
const CHEAT_ALIASES = ['win'];
/** 作弊所需权限 */
const CHEAT_PERMISSIONS = [[neonaicCommandInterface.COMMAND_ENUMS.PERM_SUPERADMIN, neonaicCommandInterface.COMMAND_ENUMS.PERM_ADMIN, 'wordle.cheat']];

/** 帮助文本 */
const HELP_TEXT = `Wordle Game for Neonaic By @kdxiaoyi

/wordle help 显示本信息
/wordle new [难度] [首个猜测] 开始新游戏
  难度：normal 普通（默认） / hard 困难 / uhard 极限
  困难：绿色字母的位置不能变动，黄色字母必须继续使用
  极限：在困难的基础上，黄色字母必须换位置，白色字母不得再出现
开始后:
/wordle stop 放弃游戏
/wordle <word> 提交猜测
/wordle history 或 /wordle h 查看猜测历史与已排除字母

没有进行中的对局时，直接给出 5 个字母会当作本局的第一次猜测，给出 hard / uhard 会以该难度开局。`;

/**
 * @this {import('../../../src/extension/extLoader.js').NeonaicExtItem}
 * @param {{ manifest: Object, pwd: String, ext_item_id: String, ext_item_timestamp: Number }} [ctx] 拓展上下文
 */
export function onEnable(ctx) {
  neonaicCommandServer.registerCommand('wordle', 'wordle', function (...v) {
    /** @type {NeonaicCommandContext} */
    const ctx = this;
    const user = ctx.executor[0];
    /** 逐个参数归一化（去掉非字母并转小写） */
    const args = v.map((item) => parseString(item).replace(/[^a-zA-Z]/gi, '').toLowerCase());
    /** 子命令只看第一个参数 */
    const sub = args[0] ?? '';
    /** 猜测则把所有参数拼起来，容忍“/wordle cr ane”这样的手滑 */
    let param = args.join('');

    if (HELP_ALIASES.includes(sub)) return HELP_TEXT;

    // ---- 开始新游戏：new [难度] [首个猜测] ----
    if (NEW_ALIASES.includes(sub)) {
      const asked = args[1] ?? '';
      // 第一个参数不是难度时，把它当作首个猜测
      const difficulty = resolveDifficulty(asked);
      const first = difficulty === null ? asked : (args[2] ?? '');
      clearSession(user);
      const session = getSession(user, SESSION_TIMEOUT, difficulty ?? WordleDifficulty.normal);
      return first.length == 5 ? play(session, first) : buildIntro(session);
    }

    // 根据会话状态进行处理
    if (hasSession(user)) {
      // 有会话
      const session = getSession(user, SESSION_TIMEOUT);
      // 处理查询请求（附带排除字母提示）
      if (HISTORY_ALIASES.includes(param)) return buildHistory(session, true);

      // 处理作弊请求
      if (CHEAT_ALIASES.includes(param) && neonaicPermissionServer.checkPermissionFromContext(ctx, CHEAT_PERMISSIONS)) {
        param = session.answer;
      };

      // 放弃游戏，等同失败
      if (ABANDON_ALIASES.includes(param)) {
        clearSession(user);
        return buildLose(session);
      }

      if (param.length == 5) return play(session, param);
      // 字母数量不对，子命令在前面已经处理，这里就不用解析
      return `“${param}”的字母数量不对`;
    }

    // ---- 没有会话：把参数当作开局的语法糖 ----
    const difficulty = resolveDifficulty(param);
    const session = getSession(user, SESSION_TIMEOUT, difficulty ?? WordleDifficulty.normal);
    if (difficulty !== null) return buildIntro(session);
    if (param.length == 5) return play(session, param);
    return buildIntro(session);
  }, {
    description: "开始和进行 Wordle 游戏",
    usage: 'wordle <word> 或 wordle <help|new [难度] [首个猜测]|history|stop>',
    alias: ['wd', 'wl'],
  });
}

/**
 * @this {import('../../../src/extension/extLoader.js').NeonaicExtItem}
 */
export function onDisable() {
}

/**
 * 提交一次猜测并生成回复
 * @param {WordleSession} session
 * @param {String} word 已归一化的 5 字母猜测
 * @returns {String}
 */
function play(session, word) {
  const result = session.guess(word);
  if (Array.isArray(result)) {
    // 是单词但不是答案
    return buildHistory(session);
  }
  switch (result) {
    case WordleEnums.length_wrong:
      // unreachable code，但表明意图
      throw new NeonaicIllegalStateError("Unreachable code");
    case WordleEnums.not_a_word:
      // 不是一个单词
      return `“${word}”不是一个单词`;
    case WordleEnums.tried:
      // 猜过了
      return `你已经尝试过“${word}”，本次不消耗轮次。\n${buildHistory(session)}`;
    case WordleEnums.failed:
      // 输掉了
      return buildLose(session);
    case WordleEnums.right:
      // 答案正确
      return buildWin(session);
    case WordleEnums.green_moved:
    case WordleEnums.yellow_unused:
    case WordleEnums.yellow_kept:
    case WordleEnums.missing_used:
      // 突破了当前难度的限制
      return buildViolation(session, word, result);
    default:
      throw new NeonaicIllegalStateError(`Unreachable code: ${parseString(result)}`);
  }
}

/** 开始新一局时的说明 @param {WordleSession} session */
function buildIntro(session) {
  return `开始新一局 Wordle（${DIFFICULTY_LABELS[session.difficulty] ?? session.difficulty}），你需要在${session.maxTries}轮和30分钟内猜出给定的5个字母所组成的单词。\n你可以使用命令 /wordle <word> 提交你的猜测，并得知本轮猜测是否正确。\n如果猜测不正确，每个字母都将分为“不在答案里出现”、“出现但位置错误”和“位置正确”三种，并分别标记为⬜、🟨和🟩。${DIFFICULTY_RULES[session.difficulty] ?? ''}`;
}

/** 猜中 @param {WordleSession} session */
function buildWin(session) {
  return `恭喜，你在${session.triesLength}轮内猜出了“${session.answer}”。\n${buildHistory(session)}\n在“牛津英语词典”中查看：https://www.oed.com/search/dictionary/?q=${session.answer}`;
}

/** 失败 / 放弃 @param {WordleSession} session */
function buildLose(session) {
  return `抱歉，你未能在${session.maxTries}轮内猜出“${session.answer}”。\n${buildHistory(session)}\n在“牛津英语词典”中查看：https://www.oed.com/search/dictionary/?q=${session.answer}`;
}

/**
 * 猜测突破了当前难度的限制
 * @param {WordleSession} session
 * @param {String} word 本次猜测
 * @param {String} reason WordleEnums 里的违规原因
 * @returns {String}
 */
function buildViolation(session, word, reason) {
  const detail = session.checkDifficulty(word);
  const letter = detail?.letter ? `${toFullLetter(detail.letter)}（${detail.letter}）` : '该字母';
  const at = (detail?.index ?? null) === null ? '' : `第 ${detail.index + 1} 位`;
  // 极限模式沿用困难规则，所以前缀取本局实际难度，不写死成“困难”
  const label = `${DIFFICULTY_LABELS[session.difficulty] ?? session.difficulty}模式`;
  let why;
  switch (reason) {
    case WordleEnums.green_moved:
      why = `${label}：${at}已经确定为“${letter}”，绿色字母的位置不能变动。`;
      break;
    case WordleEnums.yellow_unused:
      why = `${label}：已经出现过的黄色字母“${letter}”必须继续使用。`;
      break;
    case WordleEnums.yellow_kept:
      why = `${label}：黄色字母“${letter}”必须换一个位置，不能留在${at}。`;
      break;
    case WordleEnums.missing_used:
      why = `${label}：已经排除的字母“${letter}”不能再出现。`;
      break;
    default:
      why = `本次猜测不符合当前难度“${DIFFICULTY_LABELS[session.difficulty] ?? session.difficulty}”的限制。`;
      break;
  }
  return `${why}\n本次猜测不计入轮次。\n${buildHistory(session)}`;
}

/**
 * 渲染猜测历史
 * @param {WordleSession} session
 * @param {boolean} [withHint=false] 是否附加已排除字母提示
 */
function buildHistory(session, withHint = false) {
  if (!(session instanceof WordleSession)) throw new NeonaicIllegalArgumentError("期待传入 WordleSession，但发现了:" + parseString(session), session);

  let msg = `◎ 第${session.triesLength}轮\n`;
  session.historyOfResult.forEach((tryResult, index) => {
    const word = session.history[index];
    if (Array.isArray(tryResult)) {
      tryResult.forEach((status) => {
        switch (status) {
          case 'missing':
            msg += "⬜";
            break;
          case 'pos_wrong':
            msg += "🟨";
            break;
          case 'right':
            msg += "🟩";
            break;
        }
      });
    } else {
      msg += "🟩".repeat(5);
    }
    msg += `\n${toFullLetter(word)}\n`;
  });

  if (withHint) {
    const excluded = session.excludedLetters;
    msg += `\n已排除字母：${excluded.length ? excluded.map((letter) => toFullLetter(letter)).join(' ') : '暂无'}\n`;
  }
  return msg;
}
