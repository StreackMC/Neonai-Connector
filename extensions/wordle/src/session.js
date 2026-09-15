import { getLogger } from "../../../src/logger/Logger.js";
import { neonaicChore, parseString } from "../../../src/utils/chore.js";
import { neonaicMath } from "../../../src/utils/math.js";
import { NeonaicIllegalArgumentError, NeonaicIllegalStateError, NeonaicUnsupportedOperationError } from "../../../src/utils/NeonaicNewableError.js";
import { ALL_FIVE_LETTER_WORDS, FRIENDLY_FIVE_LETTER_WORDS } from "./word_provider.js";

/** Wordle 最大猜测次数 */
const MAX_TURN = 6;

/** {@link WordleSession}私有构造器 token */
const WordleSession_Private_Constructure_Token = Symbol('wordle-private-construtor');

/** Wordle 难度 */
export const WordleDifficulty = Object.freeze({
  /** 普通：除字典外不额外限制 */
  normal: 'normal',
  /** 困难：绿色字母的位置不可变动，黄色字母必须继续使用 */
  hard: 'hard',
  /** 极限：在困难基础上，黄色字母必须换位置，白色字母不得再出现 */
  uhard: 'uhard',
});

/**
 * 难度的输入别名 → 规范名
 * @apiNote 刻意不收单字母 `h`：它与查询历史的别名冲突，若在此处解释为困难，
 *          「没有对局时输入 /wordle h」就会意外开出一局困难难度的新游戏。
 */
const DIFFICULTY_ALIASES = Object.freeze({
  [WordleDifficulty.normal]: WordleDifficulty.normal, n: WordleDifficulty.normal,
  [WordleDifficulty.hard]: WordleDifficulty.hard,
  [WordleDifficulty.uhard]: WordleDifficulty.uhard, uh: WordleDifficulty.uhard,
  ultrahard: WordleDifficulty.uhard,
});

/**
 * 解析难度文本
 * @param {String} v 难度文本或其别名
 * @returns {String|null} 规范难度名；无法识别时返回 null
 */
export function resolveDifficulty(v) {
  const key = parseString(v ?? '').trim().toLowerCase();
  return DIFFICULTY_ALIASES[key] ?? null;
}

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
  /** 困难/极限：已确定的绿色字母被挪了位置 */
  green_moved: 'green_moved',
  /** 困难/极限：已出现过的黄色字母没有继续使用 */
  yellow_unused: 'yellow_unused',
  /** 极限：黄色字母仍留在原位置 */
  yellow_kept: 'yellow_kept',
  /** 极限：已排除的白色字母再次出现 */
  missing_used: 'missing_used',
});

export class WordleSession {
  #usable = true; #user = "";
  /** 本局难度 @type {String} */
  #difficulty = WordleDifficulty.normal;
  /** 已猜测答案的结果 @type {(('right'|'pos_wrong'|'missing')[]|'right')[]} */
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
    if (this.#usable === !!v) return;          // 幂等：状态没变就直接返回
    if (!v) { this.#usable = false; return; }  // 关闭
    throw new NeonaicIllegalStateError("Wordle 作答已关闭，无法再次恢复");
  }
  /** 获取本局难度 */
  get difficulty() { return this.#difficulty; }
  /** 设置本局难度，接受 {@link resolveDifficulty} 能识别的别名 @throws {NeonaicIllegalArgumentError} 无法识别的难度 */
  set difficulty(v) {
    const resolved = resolveDifficulty(v);
    if (resolved === null) throw new NeonaicIllegalArgumentError(`未知的 Wordle 难度：${parseString(v)}`);
    this.#difficulty = resolved;
  }
  /** 获取历史猜测结果，**不要修改** */
  get historyOfResult() { return this.#triesResult; };
  /** 获取猜测历史，**不要修改** */
  get history() { return this.#tries; };
  /**
   * 获取当前已经排除的字母（历史里出现过白色标记的字母）
   * @returns {String[]} 按字典序排列的小写字母
   */
  get excludedLetters() { return [...this.#constraints().white].sort(); }
  /**
   * 获取当前被锁定的绿色字母位置
   * @returns {Map<number,String>} 位置（从 0 起）→ 必须保持的字母
   */
  get lockedLetters() { return new Map(this.#constraints().green); }
  /** 答案 */
  answer;
  /** 猜测次数上限 */
  maxTries = MAX_TURN;

  constructor(t, user, difficulty = WordleDifficulty.normal) {
    if (t !== WordleSession_Private_Constructure_Token) throw new NeonaicUnsupportedOperationError("不支持直接新建 Wordle 会话");
    this.#user = user;
    this.difficulty = difficulty;
    this.answer = FRIENDLY_FIVE_LETTER_WORDS[neonaicMath.random(0, FRIENDLY_FIVE_LETTER_WORDS.length - 1)];
    if (this.answer?.length != 5) throw new NeonaicIllegalStateError("Wordle 单词提供器返回了意料之外的单词:" + this.answer);
  }

  /**
   * 汇总当前局势下的限制。
   * @implNote 猜中那一行在 `#triesResult` 里存的是 `'right'` 字符串，等价于整行全绿，此处一并展开。
   * @implNote `white` 只保留「能断定不在答案里」的字母。字母判定按份数结算后，一个位置被标白
   *           只代表「这一次出现没被匹配」，字母本身可能就在答案里（份额被别的绿/黄用光了，
   *           例如答案 posse 猜 bokos 的第 4 个 o），因此要把已在绿/黄里出现过的字母剔掉。
   * @returns {{green: Map<number,String>, yellow: {letter: String, index: number}[], white: Set<String>}}
   */
  #constraints() {
    const green = new Map();
    const yellow = [];
    const white = new Set();
    for (let i = 0; i < this.#triesResult.length; i += 1) {
      const word = this.#tries[i];
      if (typeof word !== 'string' || word.length != 5) continue;
      const entry = this.#triesResult[i];
      const result = Array.isArray(entry) ? entry : new Array(5).fill(WordleEnums.right);
      for (let j = 0; j < 5; j += 1) {
        const letter = word[j];
        switch (result[j]) {
          case WordleEnums.right: green.set(j, letter); break;
          case WordleEnums.pos_wrong: yellow.push({ letter, index: j }); break;
          case WordleEnums.missing: white.add(letter); break;
        }
      }
    }
    // 已被证实存在的字母不算「排除」
    for (const letter of green.values()) white.delete(letter);
    for (const { letter } of yellow) white.delete(letter);
    return { green, yellow, white };
  }

  /**
   * 检查一次猜测是否违反当前难度的限制。不消耗轮次、不记入历史。
   * @param {String} v 猜测文本
   * @returns {{reason: String, letter: String, index: number|null}|null} 违规详情；通过（或难度为普通、字母数不为 5）时返回 null
   */
  checkDifficulty(v) {
    const input = parseString(v).toLowerCase();
    if (input.length != 5) return null;
    return this.#findViolation(input);
  }

  /**
   * 找出第一条被违反的难度限制
   * @param {String} input 已归一化的输入
   * @returns {{reason: String, letter: String, index: number|null}|null}
   */
  #findViolation(input) {
    if (this.#difficulty === WordleDifficulty.normal) return null;
    const { green, yellow, white } = this.#constraints();

    // 困难 / 极限：绿色字母的位置不可变动
    for (const [index, letter] of green) {
      if (input[index] !== letter) return { reason: WordleEnums.green_moved, letter, index };
    }
    // 困难 / 极限：黄色字母必须继续使用
    for (const { letter } of yellow) {
      if (!input.includes(letter)) return { reason: WordleEnums.yellow_unused, letter, index: null };
    }
    if (this.#difficulty === WordleDifficulty.uhard) {
      // 极限：黄色字母必须换位置
      for (const { letter, index } of yellow) {
        if (input[index] === letter) return { reason: WordleEnums.yellow_kept, letter, index };
      }
      // 极限：白色字母不得再出现
      for (const letter of white) {
        if (input.includes(letter)) return { reason: WordleEnums.missing_used, letter, index: null };
      }
    }
    return null;
  }

  /**
   * 猜词
   * @param {String} v 输入
   * @returns {'right'|'not_a_word'|'length_wrong'|'failed'|'tried'|'green_moved'|'yellow_unused'|'yellow_kept'|'missing_used'|('right'|'pos_wrong'|'missing')[]} 猜测结果
   */
  guess(v) {
    if (!this.#usable) throw new NeonaicIllegalStateError('答题关闭不可继续作答');
    const input = parseString(v).toLowerCase();
    if (input.length != 5) return WordleEnums.length_wrong;
    if (!ALL_FIVE_LETTER_WORDS.includes(input)) return WordleEnums.not_a_word;
    if (this.answer == input) {
      // 猜中
      clearSession(this.user);
      this.#usable = false;
      this.#triesResult.push(WordleEnums.right);
      this.#tries.push(input);
      return WordleEnums.right;
    } else {
      // 猜错
      // 先看看猜没猜过
      if (this.#tries.includes(input)) return WordleEnums.tried;

      // 再确认没有违反本局难度的限制
      const violation = this.#findViolation(input);
      if (violation) return violation.reason;

      // 开始遍历字母
      // 字母必须按「份数」结算：答案里每个字母只有有限的几份，同一字母被猜多次时
      // 最多只会有「答案里实际有多少份」个非白标记。分成两趟：
      //   第一趟，位置正确的先把份额认领掉；
      //   第二趟，位置不对的按剩余份额判黄，份额用尽就只能是白。
      const rest = new Map();
      for (const letter of this.answer) rest.set(letter, (rest.get(letter) ?? 0) + 1);
      const result = new Array(input.length).fill(WordleEnums.missing);
      for (let index = 0; index < input.length; index++) {
        if (input[index] != this.answer[index]) continue;
        // 位置和字母都对
        result[index] = WordleEnums.right;
        rest.set(input[index], rest.get(input[index]) - 1);
      }
      for (let index = 0; index < input.length; index++) {
        if (result[index] === WordleEnums.right) continue;
        const iletter = input[index];
        const left = rest.get(iletter) ?? 0;
        if (left > 0) {
          // 位置不对，但答案里还有这个字母没被认领
          result[index] = WordleEnums.pos_wrong;
          rest.set(iletter, left - 1);
        }
        // 份额用尽的保持 missing
      }
      this.#triesResult.push(result);
      this.#tries.push(input);

      // 如果是最后一次机会那么会话结束
      if (this.triesLength == this.maxTries) {
        clearSession(this.user);
        this.#usable = false;
        return WordleEnums.failed;
      }
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
 * @param {String} difficulty 本局难度，仅在该用户尚无会话时生效
 */
export function newSession(user, timeout = 0.5 * 60 * 60, difficulty = WordleDifficulty.normal) {
  const u = parseString(neonaicChore.assertNoNull(user, "Wordle会话需要一个用户"));
  if (sessions.has(u)) return sessions.get(u);
  const s = new WordleSession(WordleSession_Private_Constructure_Token, u, difficulty);
  sessions.set(u, s);
  const t = setTimeout(() => {
    timeouts.delete(u);
    if (!sessions.has(u)) return;
    sessions.get(u).usable = false;
    sessions.delete(u);
    getLogger().ext.info(`${u} 的 Wordle 会话已过期`);
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
  getLogger().ext.info(`${u} 的 Wordle 会话已清除`);
}

/** 获取某个用户是否有会话 */
export function hasSession(user) {
  return sessions.has(parseString(user));
}

/** 获取全部有会话的用户 */
export function getAllSessionUser() {
  return [...sessions.keys()];
}