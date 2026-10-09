import z from "zod";
import { neonaicAI } from "../../../src/message/ai.js";
import { neonaicMath } from "../../../src/utils/math.js";
import { neonaicCommandServer } from "../../../src/command/commandServer.js";

export function registerMathSupportForAI() {
  // ai tool
  neonaicAI.registerAITool('twentyfourpoints', '24solver', {
    description: '求解指定的 24 点游戏',
    inputSchema: z.object({
      poker: z.array(z.number().int().min(1).max(13)).length(4).describe('四张牌的点数，范围 1~13'),
      target: z.number().int().min(1).max(100).optional().default(24).describe('目标点数，默认 24'),
    }).describe('四张牌的点数和目标点数'),
    execute: ({poker, target}) => {
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
  });
}