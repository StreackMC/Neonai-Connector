import { getLogger } from "../../../src/logger/Logger.js";
import { neonaicChore, parseString } from "../../../src/utils/chore.js";
import { neonaicMath } from "../../../src/utils/math.js";
import { NeonaicNewable } from "../../../src/utils/NeonaicNewableClass.js";
import { NeonaicIllegalArgumentError, NeonaicIllegalStateError, NeonaicUnsupportedOperationError } from "../../../src/utils/NeonaicNewableError.js";

/** 发牌的最小数字，对应扑克牌 A */
export const POKER_MIN = 1;
/** 发牌的最大数字，对应扑克牌 K */
export const POKER_MAX = 13;
/** 一局需要的数字个数 */
export const POKER_SIZE = 4;
/** 求解目标 */
export const TARGET = 24;
/** 判定算式结果是否为 24 时允许的误差 */
const EPS = 1e-9;

/** {@link TwentyFourSession} 私有构造器 token */
const TwentyFourSession_Private_Constructure_Token = Symbol('twentyfour-private-construtor');

/** 一局的结果 */
export const TwentyFourEnums = Object.freeze({
  /** 算式正确 */
  right: 'right',
  /** 算式合法，但结果不是 24 */
  wrong: 'wrong',
  /** 声明无解，且确实无解 */
  insoluble: 'insoluble',
  /** 声明无解，但其实有解 */
  soluble: 'soluble',
  /** 算式无法使用（不消耗机会） */
  invalid: 'invalid',
});

export class TwentyFourSession extends NeonaicNewable {
  #usable = true; #user = "";
  /** 本局的牌面 @type {number[]} */
  #poker = [];
  /** 本局全部解法，首次求解后缓存 @type {String[]|null} */
  #solutions = null;

  /** 获取 TimeoutId */
  get timeoutId() { return timeouts.get(this.user); }
  /** 获取作答者 */
  get user() { return this.#user; }
  /** 是否允许作答 */
  get usable() { return this.#usable; }
  /** 设置是否允许作答，一经设置即无法恢复 @throws {NeonaicIllegalStateError} 试图把已结束的本局恢复为可作答 */
  set usable(v) {
    if (this.#usable === !!v) return;          // 幂等：状态没变就直接返回
    if (!v) { this.#usable = false; return; }  // 结束本局
    throw new NeonaicIllegalStateError("24 点本局已结束，无法再次恢复");
  }
  /** 获取本局牌面（副本，外部改它不会影响本局） @returns {number[]} */
  get poker() { return [...this.#poker]; }
  /** 获取本局的全部解法（首次访问时求解并缓存） @returns {String[]} */
  get solutions() {
    if (this.#solutions === null) this.#solutions = neonaicMath.solve24(this.#poker);
    return [...this.#solutions];
  }
  /** 获取本局解法的条数 */
  get solutionCount() { return this.solutions.length; }

  constructor(t, user) {
    super();
    if (t !== TwentyFourSession_Private_Constructure_Token) throw new NeonaicUnsupportedOperationError("不支持直接新建 24 点会话");
    this.#user = user;
    // 发牌：1–13 等概率且允许重复，等同于洗一副牌后连抽 4 张，因此不保证有解
    this.#poker = Array.from({ length: POKER_SIZE }, () => neonaicMath.random(POKER_MIN, POKER_MAX));
  }

  /**
   * 提交一次算式。只有 {@link TwentyFourEnums.invalid} 不消耗机会。
   * @param {String} v 算式文本
   * @returns {{status: String, value: number|null, error: Error|null}} 本局结果
   * @throws {NeonaicIllegalStateError} 本局已结束
   */
  guess(v) {
    if (!this.#usable) throw new NeonaicIllegalStateError('本局已经结束，无法继续作答');
    const input = parseString(v).trim();
    if (!input) return invalidWith(new NeonaicIllegalArgumentError('没有收到算式'));

    // 先确认「本局的数字各用一次」：否则 24/1 这类算式会凭空造出数字来
    const usedRaw = (input.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
    const pokerRaw = this.poker;
    const sorted = (arr) => [...arr].sort((x, y) => x - y);
    const used = sorted(usedRaw);
    const poker = sorted(pokerRaw);
    if (used.length !== poker.length || used.some((n, index) => n !== poker[index])) {
      // 提示里保留玩家输入与发牌的原顺序，避免看起来像在改动数字
      return invalidWith(new NeonaicIllegalArgumentError(
        `必须把本局的${pokerRaw.length}个数字各用一次，本次用到了 ${usedRaw.length ? usedRaw.join(' ') : '（没有任何数字）'}，本局牌面是 ${pokerRaw.join(' ')}`
      ));
    }

    let value;
    try {
      // 只开放四则运算：幂、根号、取模都不属于 24 点的规则
      value = neonaicMath.calc(input);
    } catch (error) {
      // 语法错误、除数为零、用到了四则以外的符号
      return invalidWith(error);
    }

    const right = Math.abs(value - TARGET) <= EPS;
    clearSession(this.#user);
    this.#usable = false;
    return { status: right ? TwentyFourEnums.right : TwentyFourEnums.wrong, value, error: null };
  }

  /**
   * 声明本局无解
   * @returns {{status: String, value: null, error: null}} {@link TwentyFourEnums.insoluble} 或 {@link TwentyFourEnums.soluble}
   * @throws {NeonaicIllegalStateError} 本局已结束
   */
  declareInsoluble() {
    if (!this.#usable) throw new NeonaicIllegalStateError('本局已经结束，无法继续作答');
    const status = this.solutionCount === 0 ? TwentyFourEnums.insoluble : TwentyFourEnums.soluble;
    clearSession(this.#user);
    this.#usable = false;
    return { status, value: null, error: null };
  }
}

/** 造一个「算式无法使用」的结果 @param {Error} error 原因 */
function invalidWith(error) {
  return { status: TwentyFourEnums.invalid, value: null, error };
}

/** 缓存会话的 Map @type {Map<String,TwentyFourSession>} */
const sessions = new Map();
/** 缓存会话的过期清理器 @type {Map<String,NodeJS.Timeout>} */
const timeouts = new Map();

/**
 * 获取一个 24 点会话
 * @param {String} user 用户/作答者
 * @param {number} timeout 超时时间，默认 10 分钟，单位秒，当用户没有会话时生效
 */
export function newSession(user, timeout = 10 * 60) {
  const u = parseString(neonaicChore.assertNoNull(user, "24 点会话需要一个用户"));
  if (sessions.has(u)) return sessions.get(u);
  const s = new TwentyFourSession(TwentyFourSession_Private_Constructure_Token, u);
  sessions.set(u, s);
  const t = setTimeout(() => {
    timeouts.delete(u);
    if (!sessions.has(u)) return;
    sessions.get(u).usable = false;
    sessions.delete(u);
    getLogger().ext.info(`${u} 的 24 点会话已过期`);
  }, neonaicMath.assertNoNaNOrElse(neonaicMath.toNumber(timeout), 0.5 * 60 * 60) * 1e3);
  timeouts.set(u, t);
  return s;
}

/**
 * 清除 24 点会话
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
  getLogger().ext.info(`${u} 的 24 点会话已清除`);
}

/** 获取某个用户是否有会话 */
export function hasSession(user) {
  return sessions.has(parseString(user));
}

/** 获取全部有会话的用户 */
export function getAllSessionUser() {
  return [...sessions.keys()];
}
