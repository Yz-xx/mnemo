import type { KnowledgeSearchResult } from '../../../entities/knowledge.js';
import type { KnowledgeStore } from '../../knowledge/index.js';
import type { KnowledgeCitation } from '@mnemo/reusable';
import { tool } from 'langchain';
import { z } from 'zod';
import { BUDGET_EXHAUSTED_NOTE } from '../context/index.js';
import { withLabel } from './label.js';
import {
  readCitations,
  readKnowledgeBase,
  readLogger,
  readSources,
  readToolBudget,
  readUserId,
} from './runtime.js';

/** 检索词为用户原文，截断后写入日志，避免日志行过长 */
const QUERY_PREVIEW = 80;

/** 引用卡片的片段摘要上限：过长会撑开抽屉头部，原文另经预览接口取 */
const SNIPPET_MAX_LENGTH = 200;

/** 命中的文档本轮已经回填过：不重复注入，但要让模型知道它已经看过这份资料 */
const DELIVERED_NOTE = '这些文档的内容已在本轮此前的检索结果中给出，未重复注入。';

/** 检索命中 → 引用对象：形状由 @mnemo/reusable 声明，两端共用一份；后端预检索复用同一构造 */
export function toCitation(item: KnowledgeSearchResult): KnowledgeCitation {
  return {
    documentId: item.documentId,
    chunkId: item.chunkId,
    title: item.title,
    page: item.page,
    snippet: item.content.slice(0, SNIPPET_MAX_LENGTH),
    score: item.score,
  };
}

/** 知识库检索工具：入参自校验；命中且真正注入上下文的引用才登记为来源，交回 Agent 推给客户端 */
export function createKnowledgeTool(knowledge: KnowledgeStore) {
  const search = tool(
    async ({ query }, config) => {
      // 检索范围由会话绑定决定而非模型决定：绑定了库就限定在该库，未绑定则按用户全部可见库
      const results = await knowledge.search(query, {
        userId: readUserId(config),
        knowledgeBaseId: readKnowledgeBase(config),
      });
      // 检索质量直接决定回答质量：命中数与最高分是排查「答非所问 / 未命中」的关键指标
      readLogger(config)?.debug('检索知识库', {
        query: query.slice(0, QUERY_PREVIEW),
        hits: results.length,
        topScore: results[0] ? Number(results[0].score.toFixed(3)) : undefined,
        // 出参摘要：命中来源文档，用于判断"是没检索到"还是"检索到了但答偏了"
        sources: results.length > 0 ? results.map((item) => item.title).join('、') : undefined,
      });
      if (results.length === 0) return '知识库中没有检索到相关内容。';

      const budget = readToolBudget(config);
      // 来源只登记真正注入上下文的文档：命中却被额度挡下的不算，界面上不该出现「没用上」的出处
      const citations = readCitations(config);
      // 同轮已回填过的片段不再重复注入：重复只会白占窗口；
      // 长文档的不同片段仍应继续注入，否则「从资料里找十道题」这类请求只能拿到一条
      const fresh = budget
        ? results.filter((item) => !budget.deliveredChunks.has(item.chunkId))
        : results;
      if (fresh.length === 0) return DELIVERED_NOTE;

      const sections: string[] = [];
      for (const [index, item] of fresh.entries()) {
        const section = `【片段${index + 1}】来源《${item.title}》\n${item.content}`;
        // 无治理时（工具被直接调用）原样注入，返回值形状与受理结果一致以免分叉
        const admitted = budget ? budget.admit(section) : { text: section, truncated: false };
        // 额度耗尽：本轮不再注入新内容
        if (admitted === null) break;
        // 只登记真正注入了的片段，被额度挡下的下轮仍有机会拿到
        budget?.deliveredChunks.add(item.chunkId);
        // 注入成功即成为来源候选：答复结束后由 Agent 按正文标注判定是否真的采用；
        // 同一份引用既进判定器也交给客户端，构造一次即可
        const citation = toCitation(item);
        citations?.register(citation);
        // 命中的引用一并交给 Agent 推给客户端：过程中先给出处，终局再由正文判定结果覆盖
        readSources(config)?.push(citation);
        sections.push(admitted.text);
        // 这一段已被截断即说明额度用尽，后面的片段不必再试
        if (admitted.truncated) break;
      }
      return sections.length > 0 ? sections.join('\n\n') : BUDGET_EXHAUSTED_NOTE;
    },
    {
      name: 'search_knowledge_base',
      description:
        '在本地知识库中检索资料。只要用户要求列举、查找或核实资料，或问题可能与已上传文档有关，' +
        '就必须先调用本工具；未调用前不得声称知识库中没有相关内容。',
      schema: z.object({
        query: z.string().describe('检索用的关键词或问题'),
      }),
    },
  );

  return withLabel(search, '检索知识库');
}
