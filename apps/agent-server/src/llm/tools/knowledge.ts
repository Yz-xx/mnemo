import type { KnowledgeStore } from '../../rag/index.js';
import { tool } from 'langchain';
import { z } from 'zod';
import { BUDGET_EXHAUSTED_NOTE } from '../context/index.js';
import { withLabel } from './label.js';
import { readLogger, readSources, readToolBudget, readUserId } from './runtime.js';

/** 检索词为用户原文，截断后写入日志，避免日志行过长 */
const QUERY_PREVIEW = 80;

/** 命中的文档本轮已经回填过：不重复注入，但要让模型知道它已经看过这份资料 */
const DELIVERED_NOTE = '这些文档的内容已在本轮此前的检索结果中给出，未重复注入。';

/** 知识库检索工具：入参自校验，命中来源经收集器交回 Agent 推给客户端 */
export function createKnowledgeTool(knowledge: KnowledgeStore) {
  const search = tool(
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

      const budget = readToolBudget(config);
      // 同轮已回填过的文档不再重复注入：模型手上已有它的片段，重复只会白占窗口
      const fresh = budget
        ? results.filter((item) => !budget.deliveredDocuments.has(item.documentId))
        : results;
      if (fresh.length === 0) return DELIVERED_NOTE;

      const sections: string[] = [];
      for (const [index, item] of fresh.entries()) {
        const section = `【片段${index + 1}】来源《${item.title}》\n${item.content}`;
        // 无治理时（工具被直接调用）原样注入，返回值形状与受理结果一致以免分叉
        const admitted = budget ? budget.admit(section) : { text: section, truncated: false };
        // 额度耗尽：本轮不再注入新内容
        if (admitted === null) break;
        // 只登记真正注入了的文档，被额度挡下的下轮仍有机会拿到
        budget?.deliveredDocuments.add(item.documentId);
        sections.push(admitted.text);
        // 这一段已被截断即说明额度用尽，后面的片段不必再试
        if (admitted.truncated) break;
      }
      return sections.length > 0 ? sections.join('\n\n') : BUDGET_EXHAUSTED_NOTE;
    },
    {
      name: 'search_knowledge_base',
      description: '在本地知识库中检索资料。问题涉及已上传的文档、内部资料或专有知识时使用。',
      schema: z.object({
        query: z.string().describe('检索用的关键词或问题'),
      }),
    },
  );

  return withLabel(search, '检索知识库');
}
