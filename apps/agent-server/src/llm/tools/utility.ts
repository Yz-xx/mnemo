import { tool } from 'langchain';
import { z } from 'zod';

/** 白名单校验后计算算术表达式，避免执行任意代码 */
function evaluateExpression(expression: string): number {
  if (!/^[\d+\-*/().\s]+$/.test(expression)) {
    throw new Error('表达式包含非法字符');
  }
  const result: unknown = new Function(`return (${expression});`)();
  if (typeof result !== 'number' || !Number.isFinite(result)) {
    throw new Error('计算结果无效');
  }
  return result;
}

/** 通用工具：当前时间与算术计算，两者都不依赖任何注入依赖 */
export function createUtilityTools() {
  const getCurrentTime = tool(
    async () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    {
      name: 'get_current_time',
      description: '获取当前日期与时间。问题涉及“今天”“现在”等时间概念时使用。',
      schema: z.object({}),
    },
  );

  const calculator = tool(
    async ({ expression }) => {
      try {
        return String(evaluateExpression(expression));
      } catch {
        return '表达式无法计算，请检查后重试。';
      }
    },
    {
      name: 'calculator',
      description: '计算只包含数字与 + - * / ( ) 的算术表达式。',
      schema: z.object({
        expression: z.string().describe('算术表达式，例如 (12+8)*3/5'),
      }),
    },
  );

  return [getCurrentTime, calculator];
}
