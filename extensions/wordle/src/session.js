import { getLogger } from "../../../src/logger/Logger.js";
import { neonaicChore, parseString } from "../../../src/utils/chore.js";
import { neonaicMath } from "../../../src/utils/math.js";
import { NeonaicIllegalStateError, NeonaicUnsupportedOperationError } from "../../../src/utils/NeonaicNewableError.js";
import { ALL_FIVE_LETTER_WORDS, FRIENDLY_FIVE_LETTER_WORDS } from "./word_provider.js";

/** Wordle 最大猜测次数 */
const MAX_TURN = 5;

/** {@link WordleSession}私有构造器 token */
const WordleSession_Private_Constructure_Token = Symbol('wordle-private-construtor');

export const WordleEnums = Object.freeze({
  /** 单词/字母正确 */
  right: 'right',
  /** 输入不是一个单词 */
  not_a_word: 'not_a_word',
  /** 输入的字母数量不对 */
  length_wrong: 'length_wrong',
  /** 字母存在但位置不对 */
  pos_wrong: 'pos_wrong',
  /** 字母不存在 */
  missing: 'missing',
  /** 输掉了 */
  failed: 'failed',
  /** 输入已尝试过 */
  tried: 'tried',
});

export class WordleSession {
  #usable = true; #user = "";
  /** 已猜测答案的结果 @type {('right'|'pos_wrong'|'missing')[][]} */
  #triesResult = [];
  /** 已猜测答案 @type {string[]} */
  #tries = [];
  /** 获取 TimeoutId */
  get timeoutId() { return timeouts.get(this.user); }
  /** 获取作答者 */
  get user() { return this.#user; }
  /** 获取已作答次数 */
  get triesLength() { return this.historyOfResult.length; }
  /** 是否允许作答 */
  get usable() { return this.#usable; }
  /** 设置是否允许作答，一经设置即无法操作 */
  set usable(v) {
    if (!this.#usable && !v) throw NeonaicIllegalStateError("Wordle 作答已关闭，无法再次恢复");
    this.#usable = !!v;
  }
  /** 获取历史猜测结果 */
  get historyOfResult() { return this.#triesResult; };
  /** 获取猜测历史 */
  get history() { return this.#tries; };
  /** 答案 */
  answer;
  /** 猜测次数上限 */
  maxTries = MAX_TURN;

  constructor(t, user) {
    if (t !== WordleSession_Private_Constructure_Token) throw NeonaicUnsupportedOperationError("不支持直接新建 Wordle 会话");
    this.#user = user;
    this.answer = FRIENDLY_FIVE_LETTER_WORDS[neonaicMath.random(0, FRIENDLY_FIVE_LETTER_WORDS.length - 1)];
    if (this.answer?.length != 5) throw new NeonaicIllegalStateError("Wordle 单词提供器返回了意料之外的单词:" + this.answer);
  }

  /**
   * 猜词
   * @param {String} v 输入
   * @returns {'right'|'not_a_word'|'length_wrong'|'failed'|('right'|'pos_wrong'|'missing')[]} 猜测结果
   */
  guess(v) {
    const input = parseString(v).toLowerCase();
    if (v.length != 5) return WordleEnums.length_wrong;
    if (!ALL_FIVE_LETTER_WORDS.includes(input)) return WordleEnums.not_a_word;
    if (this.answer == input) {
      // 猜中
      clearSession(this.user);
      this.#usable = false;
      return WordleEnums.right;
    } else {
      // 猜错
      // 先看看猜没猜过
      if (this.#tries.includes(input)) return WordleEnums.tried;

      // 如果是最后一次机会那么会话结束
      if (this.triesLength == this.maxTries) {
        clearSession(this.user);
        this.#usable = false;
        return WordleEnums.failed;
      }

      // 开始遍历字母
      let result = [];
      for (let index = 0; index < input.length; index++) {
        const iletter = input[index];
        const oletter = this.answer[index];
        if (iletter == oletter) {
          // 位置和字母都对
          result.push(WordleEnums.right);
        } else if (this.answer.includes(iletter)) {
          // 位置不对，但是字母对了
          result.push(WordleEnums.pos_wrong);
        } else {
          // 位置字母都不对
          result.push(WordleEnums.missing);
        }
      }
      this.#triesResult.push(result);
      this.#tries.push(input);
      return result;
    }
  }
}

/** 缓存会话的 Map @type {Map<String,WordleSession>} */
const sessions = new Map();
/** 缓存会话的过期清理器 @type {Map<String,NodeJS.Timeout>} */
const timeouts = new Map();

/**
 * 获取一个 Wordle 会话
 * @param {String} user 用户/作答者
 * @param {number} timeout 超时时间，默认半小时，单位秒，当用户没有会话时生效
 */
export function newSession(user, timeout = 0.5 * 60 * 60) {
  const u = parseString(neonaicChore.assertNoNull(user, "Wordle会话需要一个用户"));
  if (sessions.has(u)) return sessions.get(u);
  const s = new WordleSession(WordleSession_Private_Constructure_Token, u);
  sessions.set(u, s);
  const t = setTimeout(() => {
    if (!sessions.has(u)) return;
    sessions.get(u).usable = false;
    sessions.delete(u);
    getLogger().tool.info(`${u} 的 Wordle 会话已过期`);
  }, neonaicMath.assertNoNaNOrElse(neonaicMath.toNumber(timeout), 0.5 * 60 * 60) * 1e3);
  timeouts.set(u, t);
  return s;
}

/**
 * 清除 Wordle 对话
 * @param {String} user 用户/作答者
 */
export function clearSession(user) {
  const u = parseString(user);
  if (sessions.has(u)) {
    sessions.get(u).usable = false;
    sessions.delete(u);
  }
  if (timeouts.has(u)) {
    clearTimeout(timeouts.get(u));
    timeouts.delete(u);
  }
  getLogger().tool.info(`${u} 的 Wordle 会话已清除`);
}

/** 获取某个用户是否有会话 */
export function hasSession(user) {
  return sessions.has(parseString(user));
}