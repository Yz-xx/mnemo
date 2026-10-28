import type { AgentTool } from '../../services/llm/tools/index.js';
import type { AgentStreamEvent } from '@mnemo/reusable';
import { AIMessageChunk } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { createCitations } from '../../services/llm/citations.js';
import { createToolBudget } from '../../services/llm/context/index.js';
import { bridgeAgentStream } from '../../services/llm/streamBridge.js';

/** 构造一条只吐正文的模型分片：分片间可切开，模拟逐 token 到达 */
function textChunk(content: string): unknown {
  return [new AIMessageChunk({ content }), {}];
}

/** 跑一次桥接并收集全部事件；injected 模拟检索工具已经注入上下文的文档 */
async function runBridge(parts: string[], injected: string[]): Promise<AgentStreamEvent[]> {
  const citations = createCitations();
  injected.forEach((title, index) => citations.register(`d${index}`, title));

  const stream = (async function* () {
    for (const part of parts) yield textChunk(part);
  })();

  const events: AgentStreamEvent[] = [];
  for await (const event of bridgeAgentStream({
    stream,
    tools: [] as AgentTool[],
    exported: [],
    sources: injected,
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

describe('streamBridge 终局来源', () => {
  it('正文标注了来源时，终局来源只保留被引用的文档', async () => {
    const events = await runBridge(
      ['据《公共手册》', '，苹果属于水果。'],
      ['公共手册', '我的笔记'],
    );

    expect(finalSources(events)).toEqual([{ type: 'sources', names: ['公共手册'] }]);
  });

  it('正文没有标注来源时，终局清单为空，清掉过程中的增量标签', async () => {
    const events = await runBridge(['苹果属于水果。'], ['公共手册', '我的笔记']);

    expect(finalSources(events)).toEqual([{ type: 'sources', names: [] }]);
  });

  it('没有任何检索文档时不推终局来源，避免每轮都挂一条空事件', async () => {
    const events = await runBridge(['苹果属于水果。'], []);

    expect(finalSources(events)).toEqual([]);
  });
});
