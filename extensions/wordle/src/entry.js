import { NeonaicCommandContext, neonaicCommandServer } from '../../../src/command/commandServer.js';
import { parseString } from '../../../src/utils/chore.js';
import { NeonaicIllegalArgumentError, NeonaicIllegalStateError } from '../../../src/utils/NeonaicNewableError.js';
import { clearSession, hasSession, newSession as getSession, WordleEnums, WordleSession } from './session.js';
import { toFullLetter } from './word_provider.js';

/** 会话超时时间，默认半小时，单位秒 */
const SESSION_TIMEOUT = 0.5 * 60 * 60;

/**
 * @this {import('../../../src/extension/extLoader.js').NeonaicExtItem}
 * @param {{ manifest: Object, pwd: String, ext_item_id: String, ext_item_timestamp: Number }} [ctx] 拓展上下文
 */
export function onEnable(ctx) {
  neonaicCommandServer.registerCommand('wordle', 'wordle', function (v) {
    /** @type {NeonaicCommandContext} */
    const ctx = this;
    const user = ctx.executor[0];
    const param = parseString(v || "").replace(/[^a-zA-Z]/gi, '').toLowerCase();
    if (['help', 'ver', 'version'].includes(param)) {
      return `Wordle Game for Neonaic By @kdxiaoyi\n\n/wordle help 显示本信息\n/wordle new 开始新游戏\n开始后:\n/wordle stop 放弃游戏\n/wordle <word> 提交猜测\n/wordle history 或 /wordle h 查看猜测历史`;
    } else if (['new'].includes(param)) {
      clearSession(user);
      // 不新建，后续统一处理
    }

    // 根据会话状态进行处理
    if (hasSession(user)) {
      // 有会话
      const session = getSession(user, SESSION_TIMEOUT);
      // 处理查询请求
      if (['h', 'history', 'tries', 'try'].includes(param)) return buildHistory(getSession(user, SESSION_TIMEOUT));

      // 放弃游戏，等同失败
      if (['abandon', 'givenup', 'quit', 'exit', 'stop'].includes(param)) {
        clearSession(user);
        return `抱歉，你未能在${session.maxTries}轮内猜出“${session.answer}”。\n${buildHistory(session)}\n在“牛津英语词典”中查看：https://www.oed.com/search/dictionary/?q=${session.answer}`;
      }

      if (param.length == 5) {
        // 字母数量对
        const result = session.guess(param);
        if (Array.isArray(result)) {
          // 是单词但不是答案
          return buildHistory(session);
        } else {
          switch (result) {
            case WordleEnums.length_wrong:
              // unreachable code，但表明意图
              throw new NeonaicIllegalStateError("Unreachable code");
            case WordleEnums.not_a_word:
              // 不是一个单词
              return `“${param}”不是一个单词`;
            case WordleEnums.tried:
              // 猜过了
              return `你已经尝试过“${param}”，本次不消耗轮次。\n${buildHistory(session)}`;
            case WordleEnums.failed:
              // 输掉了
              return `抱歉，你未能在${session.maxTries}轮内猜出“${session.answer}”。\n${buildHistory(session)}\n在“牛津英语词典”中查看：https://www.oed.com/search/dictionary/?q=${session.answer}`;
            case WordleEnums.right:
              // 答案正确
              return `恭喜，你在${session.triesLength}轮内猜出了“${session.answer}”。\n${buildHistory(session)}\n在“牛津英语词典”中查看：https://www.oed.com/search/dictionary/?q=${session.answer}”`;
            default:
              throw new NeonaicIllegalStateError("Unreachable code");
          }
        }
      } else {
        // 字母数量不对
        return `“${param}”的字母数量不对`;
        // 子命令在前面已经处理，这里就不用解析
      }
    } else {
      // 没有会话
      const session = getSession(user, SESSION_TIMEOUT);
      return `开始新一局 Wordle，你需要在${session.maxTries}轮内猜出给定的5个字母所组成的单词。\n你可以使用命令 /wordle <word> 提交你的猜测，并得知本轮猜测是否正确。\n如果猜测不正确，每个字母都将分为“不在答案里出现”、“出现但位置错误”和“位置正确”三种，并分别标记为⬜、🟨和🟩。`;
    }
  }, {
    description: "开始和进行 Wordle 游戏",
    usage: 'wordle <word> 或 wordle <help|new|history>',
    alias: ['wd', 'wl'],
  });
}

/**
 * @this {import('../../../src/extension/extLoader.js').NeonaicExtItem}
 */
export function onDisable() {
}

/** @param {WordleSession} session */
function buildHistory(session) {
  if (!(session instanceof WordleSession)) throw new NeonaicIllegalArgumentError("期待传入 WordleSession，但发现了:" + parseString(session), session);

  let msg = `<第${session.triesLength}轮>\n`;
  session.historyOfResult.forEach((tryResult, index) => {
    const word = session.history[index];
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
    msg += `\n${toFullLetter(word)}\n`;
  });
  return msg;
}