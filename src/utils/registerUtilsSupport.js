import z from "zod";
import { neonaicCommandServer } from "../command/commandServer.js";
import { neonaicAI } from "../message/ai.js";
import { parseString } from "./chore.js";
import { neonaicNetwork } from "./io.js";
import { neonaicMath, NeonaicMatrix } from "./math.js";
import { NeonaicNetworkError } from "./NeonaicNewableError.js";
import { NeonaicUriMeta } from "./NeonaicUriMeta.js";
const [registerAITool, registerCommand] = [neonaicAI.registerAITool, neonaicCommandServer.registerCommand];

const ai = () => {
  registerAITool('neonaic', 'webfetch', {
    description: "从指定地址获取Web内容",
    inputSchema: z.object({
      address: z.string().describe("目标 URI，协议头缺失时视作http。"),
      timeout: z.int().describe("可接受的超时时间，不得超过5000ms，默认5000ms。"),
    }),
    execute: async ({ address, timeout }) => {
      try {
        // 请求
        const result = await neonaicNetwork.fetch(
          await NeonaicUriMeta.resolve(address, {}),
          neonaicMath.clamp(neonaicMath.assertNoNaNOrElse(neonaicMath.toNumber(timeout), 5000), 1, 5000),
          { allow_lan: false }
        );

        // 判断内置阻止
        const neonaicTag = result.headers.get("x-neonaic-status");
        if (neonaicTag == 'aborted:intranet') throw new NeonaicNetworkError("试图访问内网", result);
        if (neonaicTag == 'aborted:filter') throw new NeonaicNetworkError("安全原因不得访问该地址", result);

        // 处理结果
        if (result.ok) {
          return `<${result.type.toString()}>${await result.text()}</>`;
        } else {
          throw new NeonaicNetworkError(`远程返回HTTP代码${result.status}`, result);
        }
      } catch (error) {
        return `未能获取目标地址内容：${error?.message || "未知原因"}`;
      }
    },
  });

  registerAITool('neonaic', 'time', {
    description: "获取指定时区的时间信息",
    inputSchema: z.object({
      country: z.string().describe("目标时区的ISO国家代码，用于文本格式化；传空值为默认，可以假定与用户时区相同"),
      tz: z.string().describe("目标时区的偏移量，如\"+8\"和\"-4\"；传空值为默认，可以假定与用户时区相同；无偏移需传\"UTC\""),
    }),
    execute: async ({ country, tz }) => {
      const d = new Date();
      return d.toLocaleString([parseString(country), "zh-CN"], { timeZone: (tz || "+8") });
    },
  });

  registerAITool('neonaic', 'stringlength', {
    description: "获取输入文本的长度",
    inputSchema: z.object({
      text: z.string().describe("待判断文本"),
    }),
    execute: async ({ text }) => parseString(text).length,
  });

  registerAITool('neonaic', 'calc', {
    description: '计算指定的算式',
    inputSchema: z.object({
      expression: z.string().describe('一个算式，例如 "1+2*3-4"。可以使用+-*/^%()√∛这些运算符。^n√表示 n 次方根。'),
    }).describe('要计算的算式'),
    execute: ({ expression }) => {
      try {
        return neonaicMath.calc(expression, {
          mod: true,
          power: true,
          root: true,
        });
      } catch (error) {
        return "无法计算。可能存在算数错误，例如 0 作分母、对负数开偶次方根……";
      }
    },
  });

  registerAITool('neonaic', 'matrix', {
    description: '评估指定的矩阵，返回矩阵的秩、行列式结果等信息',
    inputSchema: z.object({
      data: z.string().describe('以 CSV 格式表达的矩阵：同一行元素用英文逗号分隔，行之间用换行分隔'),
      cols: z.int().describe('矩阵列数'),
      rows: z.int().describe('矩阵行数'),
    }).describe('矩阵参数与数据来源'),
    outputSchema: z.object({
      rank: z.number().optional().describe('矩阵的秩'),
      fullrank: z.boolean().optional().describe('是否为满秩矩阵'),
      squared: z.boolean().optional().describe('是否为方阵'),
      determinant: z.number().optional().describe('矩阵的行列式值（仅方阵有）'),
      inverse: z.string().optional().describe('矩阵的逆矩阵（仅方阵且可逆时有，CSV 格式）'),
      singular: z.boolean().optional().describe('是否奇异（仅方阵有；奇异矩阵没有逆）'),
      info: z.string().optional().describe('评估失败时的提示信息'),
    }).describe('矩阵评估结果'),
    execute: ({ data, cols, rows }) => {
      try {
        // 行分隔符容忍换行与分号（表格软件常导出分号作行分隔）
        const text = parseString(data).replace(/[;；]/g, '\n');
        const rowCount = neonaicMath.toNumber(rows, false);
        const colCount = neonaicMath.toNumber(cols, false);

        // 先核对形状。NeonaicTable 对不齐的数据是「截断 / 补空」，不核对的话
        // 缺列会被补成 0 后照常算出一个看起来正常的错答案。
        const lines = text.split('\n').filter((line) => line.trim() !== '');
        const widths = lines.map((line) => line.split(',').length);
        if (lines.length !== rowCount || widths.some((w) => w !== colCount)) {
          return {
            info: `数据形状与声明不符：声明 ${rowCount} 行 ${colCount} 列，实际 ${lines.length} 行`
              + `（各行列数：${widths.join(' / ') || '空'}）。请用英文逗号分隔同一行的元素、换行分隔各行。`,
          };
        }

        // 单元格必须是数字。toNumber 会把无法解析的内容静默变成 0，
        // 那样会算出一个「看起来正常」的错答案，宁可在这里明确拒绝。
        const cells = lines.flatMap((line) => line.split(','));
        const badCell = cells.find((cell) => cell.trim() === '' || Number.isNaN(Number(cell)));
        if (badCell !== undefined) {
          return { info: `存在无法解析为数字的单元格：${JSON.stringify(badCell)}` };
        }

        const matrix = new NeonaicMatrix(lines.map((line) => line.split(',').map(Number)), 'array[]');
        const result = {
          squared: matrix.squared,
          rank: matrix.rank,
          fullrank: matrix.fullrank,
        };
        // 非方阵没有行列式与逆
        if (!matrix.squared) return result;

        const determinant = matrix.det();
        const inverse = matrix.inverse();
        return {
          ...result,
          determinant,
          singular: determinant === 0,
          // 奇异矩阵没有逆。inverse() 此时返回 NaN，塞进输出会污染结果，直接省掉该字段
          ...(Number.isNaN(inverse) ? {} : { inverse: inverse.toCsv() }),
        };
      } catch (error) {
        return {
          info: `无法评估矩阵：${error?.message || "未知原因"}`,
        };
      }
    },
  });
};

const cmd = () => {

};

export const neonaicUtilsSupport = {
  register: () => {
    ai();
    cmd();
  },
};