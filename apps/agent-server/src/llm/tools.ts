import { tool } from 'langchain';
import type { ToolRunnableConfig } from '@langchain/core/tools';
import { z } from 'zod';
import type { Logger } from '@repo/logger';
import type { KnowledgeStore } from '../rag/store.js';

/** 检索词为用户原文，截断后写入日志，避免日志行过长 */
const QUERY_PREVIEW = 80;

/** 从运行时配置中取出当前用户 ID：调用者身份由 Agent 经 configurable 注入 */
function readUserId(config?: ToolRunnableConfig): number {
  const userId = config?.configurable?.userId;
  if (!Number.isInteger(userId)) {
    throw new Error('缺少当前用户身份，无法检索知识库');
  }
  return userId as number;
}

/** 取请求级日志：由 Agent 经 configurable 下传，未注入时静默跳过，工具不强依赖日志 */
function readLogger(config?: ToolRunnableConfig): Logger | undefined {
  const logger = config?.configurable?.logger as Logger | undefined;
  return typeof logger?.debug === 'function' ? logger : undefined;
}

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

/** 组装 Agent 工具集：知识库检索、当前时间、算术计算 */
export function createTools(knowledge: KnowledgeStore) {
  const searchKnowledgeBase = tool(
    async ({ query }, config) => {
      const results = await knowledge.search(query, { userId: readUserId(config) });
      // 检索质量直接决定回答质量：命中数与最高分是排查「答非所问 / 未命中」的关键指标
      readLogger(config)?.debug('检索知识库', {
        query: query.slice(0, QUERY_PREVIEW),
        hits: results.length,
        topScore: results[0] ? Number(results[0].score.toFixed(3)) : undefined,
        // 出参摘要：命中来源文档，用于判断"是没检索到"还是"检索到了但答偏了"
        sources: results.length > 0 ? results.map((item) => item.title).join('、') : undefined,
      });
      if (results.length === 0) return '知识库中没有检索到相关内容。';
      return results
        .map((item, index) => `【片段${index + 1}】来源《${item.title}》\n${item.content}`)
        .join('\n\n');
    },
    {
      name: 'search_knowledge_base',
      description: '在本地知识库中检索资料。问题涉及已上传的文档、内部资料或专有知识时使用。',
      schema: z.object({
        query: z.string().describe('检索用的关键词或问题'),
      }),
    },
  );

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

  return [searchKnowledgeBase, getCurrentTime, calculator];
}
