import type { AgentTool } from '../../services/llm/tools/index.js';
import type { AgentStreamEvent, KnowledgeCitation } from '@mnemo/reusable';
import { AIMessageChunk } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { createCitations } from '../../services/llm/citations.js';
import { createToolBudget } from '../../services/llm/context/index.js';
import { bridgeAgentStream } from '../../services/llm/streamBridge.js';

/** 构造一条测试引用：本组只关心标题匹配，其余字段取固定值 */
function cite(documentId: string, title: string): KnowledgeCitation {
  return { documentId, chunkId: `${documentId}-c1`, title, page: null, snippet: '', score: 0.9 };
}

/** 构造一条只吐正文的模型分片：分片间可切开，模拟逐 token 到达 */
function textChunk(content: string): unknown {
  return [new AIMessageChunk({ content }), {}];
}

/** 跑一次桥接并收集全部事件；injected 模拟检索工具已经注入上下文的文档 */
async function runBridge(parts: string[], injected: string[]): Promise<AgentStreamEvent[]> {
  const citations = createCitations();
  const sources = injected.map((title, index) => cite(`d${index}`, title));
  sources.forEach((citation) => citations.register(citation));

  const stream = (async function* () {
    for (const part of parts) yield textChunk(part);
  })();

  const events: AgentStreamEvent[] = [];
  for await (const event of bridgeAgentStream({
    stream,
    tools: [] as AgentTool[],
    exported: [],
    sources,
    citations,
    toolBudget: createToolBudget(1000),
    toolBudgetTokens: 1000,
  })) {
    events.push(event);
  }
  return events;
}

/** 取终局来源事件：一轮只应有一条，用于断言最终展示给用户的来源 */
function finalSources(events: AgentStreamEvent[]) {
  return events.filter((event) => event.type === 'sources');
}

/** 取终局清单里的文档标题 */
function finalTitles(events: AgentStreamEvent[]): string[] {
  return finalSources(events).flatMap((event) =>
    event.type === 'sources' ? event.citations.map((item) => item.title) : [],
  );
}

describe('streamBridge 终局来源', () => {
  it('正文标注了来源时，终局来源只保留被引用的文档', async () => {
    const events = await runBridge(
      ['据《公共手册》', '，苹果属于水果。'],
      ['公共手册', '我的笔记'],
    );

    expect(finalTitles(events)).toEqual(['公共手册']);
    // 终局清单必须是完整的引用对象：客户端据此渲染角标与预览入口
    const [event] = finalSources(events);
    expect(event?.type === 'sources' ? event.citations[0] : undefined).toMatchObject({
      documentId: 'd0',
      title: '公共手册',
    });
  });

  it('正文没有标注来源时，终局清单为空，清掉过程中的增量标签', async () => {
    const events = await runBridge(['苹果属于水果。'], ['公共手册', '我的笔记']);

    expect(finalTitles(events)).toEqual([]);
    expect(finalSources(events)).toHaveLength(1);
  });

  it('没有任何检索文档时不推终局来源，避免每轮都挂一条空事件', async () => {
    const events = await runBridge(['苹果属于水果。'], []);

    expect(finalSources(events)).toEqual([]);
  });
});
