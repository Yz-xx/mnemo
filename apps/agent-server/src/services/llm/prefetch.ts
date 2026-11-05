import type { Citations } from './citations.js';
import type { KnowledgeStore } from '../knowledge/index.js';
import type { ToolBudget } from './context/index.js';
import type { BaseMessage } from '@langchain/core/messages';
import type { Logger } from '@mnemo/logger';
import type { KnowledgeCitation } from '@mnemo/reusable';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { extractText } from './messageContent.js';
import { toCitation } from './tools/knowledge.js';

/** 预检索输入：本轮最后一条用户消息、可见范围、共享额度与来源登记器 */
export interface KnowledgePrefetchInput {
  messages: BaseMessage[];
  userId: number;
  knowledgeBaseId?: string;
  budget: ToolBudget;
  citations: Citations;
  sources: KnowledgeCitation[];
  logger?: Logger;
}

/**
 * 后端预检索：本地模型不一定遵守「先检索再回答」的系统提示，可能在未调用工具时
 * 直接声称知识库没有相关内容。这里在模型调用前先检一次，把命中片段作为系统补充注入，
 * 保证库里有资料时回答能读到；工具仍保留供模型追加检索，已交付文档由本轮额度去重。
 * 预检索只是增强路径，失败或额度耗尽都不阻断本轮回答。
 */
export async function prefetchKnowledge(
  knowledge: KnowledgeStore,
  input: KnowledgePrefetchInput,
): Promise<void> {
  const last = input.messages[input.messages.length - 1];
  // 本轮最后一条应当是用户消息：历史里的旧问题不参与本轮检索
  if (!(last instanceof HumanMessage)) return;
  const query = extractText(last.content).trim();
  if (!query) return;

  try {
    const results = await knowledge.search(query, {
      userId: input.userId,
      knowledgeBaseId: input.knowledgeBaseId,
    });
    // 与工具检索同一组指标：预检索是否命中、最高分多少，是排查「有资料却答未找到」的入口
    input.logger?.debug('知识库预检索', {
      query: query.slice(0, 80),
      hits: results.length,
      topScore: results[0] ? Number(results[0].score.toFixed(3)) : undefined,
      sources: results.length > 0 ? results.map((item) => item.title).join('、') : undefined,
    });
    if (results.length === 0) return;

    const sections: string[] = [];
    for (const [index, item] of results.entries()) {
      // 按片段去重：同一文档的多个相关片段都应注入，直到额度耗尽
      if (input.budget.deliveredChunks.has(item.chunkId)) continue;
      const admitted = input.budget.admit(
        `【片段${index + 1}】来源《${item.title}》\n${item.content}`,
      );
      if (admitted === null) break;
      input.budget.deliveredChunks.add(item.chunkId);
      // 与工具路径同口径：真正注入的片段才登记为来源候选，终局仍由正文标注判定
      const citation = toCitation(item);
      input.citations.register(citation);
      input.sources.push(citation);
      sections.push(admitted.text);
      if (admitted.truncated) break;
    }
    if (sections.length === 0) return;
    input.messages.push(
      new SystemMessage(
        [
          '以下是本轮知识库检索结果。回答必须优先使用这些资料，并在引用句末用《文档标题》标注来源；',
          '资料未覆盖的部分可以补充，但不要把知识库中没有的内容说成来自知识库。',
          '',
          sections.join('\n\n'),
        ].join('\n'),
      ),
    );
  } catch (error) {
    // 知识库不可用不该拖垮对话：记录后让模型走工具或常识回答
    input.logger?.warn('知识库预检索失败', { message: String(error) });
  }
}
