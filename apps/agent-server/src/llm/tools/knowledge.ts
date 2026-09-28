import type { KnowledgeStore } from '../../rag/index.js';
import { tool } from 'langchain';
import { z } from 'zod';
import { readLogger, readSources, readUserId } from './runtime.js';

/** 检索词为用户原文，截断后写入日志，避免日志行过长 */
const QUERY_PREVIEW = 80;

/** 知识库检索工具：入参自校验，命中来源经收集器交回 Agent 推给客户端 */
export function createKnowledgeTool(knowledge: KnowledgeStore) {
  return tool(
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
      // 命中的文档名一并交给 Agent 推给客户端，来源标签因此由服务端确定地给出，
      // 不指望模型在正文里照抄出处（提示词已要求，但小模型遵循率撑不起主链路）
      readSources(config)?.push(...results.map((item) => item.title));
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
}
