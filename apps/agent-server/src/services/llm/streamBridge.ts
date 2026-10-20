import type { ToolBudget } from './context/index.js';
import type { AgentTool, GeneratedFileRef } from './tools/index.js';
import type { BaseMessageChunk } from '@langchain/core/messages';
import type { Logger } from '@mnemo/logger';
import type { AgentStreamEvent } from '@mnemo/reusable';
import { AIMessageChunk, ToolMessage } from '@langchain/core/messages';
import { extractReasoning, extractText } from './messageContent.js';
import { ToolTrace } from './toolTrace.js';

/**
 * 把 agent 的 messages 流桥接成推送事件流：翻译工具分片为过程提示、
 * 把推理链与正文分片转成 thinking / token、工具结束时补推来源，最后统一推送导出文件。
 *
 * 采用 messages 流模式，可直接拿到模型输出的增量分片与工具调用信息；
 * 一次工具调用分散在多个分片中，参数攒到能解析时才推 start，
 * 「按调用去重」与「翻译成人话」都收在 ToolTrace 内，本模块只负责把结果转发出去。
 */
export async function* bridgeAgentStream(input: {
  stream: AsyncIterable<unknown>;
  tools: AgentTool[];
  /** 本轮生成的导出文件：工具负责产出，推给客户端要等流读完再统一做 */
  exported: GeneratedFileRef[];
  /** 本轮检索命中的文档名：工具负责追加，每次工具结束就推增量 */
  sources: string[];
  /** 本轮工具结果额度：检索与读取共用，跨同轮多次调用累计 */
  toolBudget: ToolBudget;
  /** 额度上限（token）：仅用于末尾记录用量，便于判断是否被挤占或触发过去重 */
  toolBudgetTokens: number;
  logger?: Logger;
}): AsyncGenerator<AgentStreamEvent> {
  const { stream, tools, exported, sources, toolBudget, toolBudgetTokens, logger } = input;
  const toolTrace = new ToolTrace(tools);
  // 已推给客户端的来源：同一文档被多次检索命中时只出一个标签
  const pushedSources = new Set<string>();

  for await (const item of stream) {
    const [message] = item as [BaseMessageChunk, Record<string, unknown>];

    if (message instanceof ToolMessage) {
      // 参数始终没拼完整时在这里补一次 start：过程提示不该因模型的分片方式而缺席
      const toolName = message.name ?? 'tool';
      const late = toolTrace.flushPendingStart(toolName);
      if (late) yield { type: 'tool', name: late.name, status: 'start', detail: late.detail };
      yield { type: 'tool', name: toolName, status: 'end' };
      // 工具刚结束就推出新增来源，与工具标签前后脚出现；
      // 本轮随后被停止也不会丢掉已经检索到的出处
      for (const name of sources) {
        if (pushedSources.has(name)) continue;
        pushedSources.add(name);
        yield { type: 'source', name };
      }
      continue;
    }

    if (message instanceof AIMessageChunk) {
      for (const call of message.tool_call_chunks ?? []) {
        // 不带工具名的参数分片同样要消费：参数攒齐才推 start，
        // 否则用户看到「正在检索」却说不出在检索什么
        const start = toolTrace.push(call);
        if (start) yield { type: 'tool', name: start.name, status: 'start', detail: start.detail };
      }
      // 推理链先于正文到达：只作过程展示，不落库、不进历史、不计入上下文预算
      const reasoning = extractReasoning(message);
      if (reasoning) yield { type: 'thinking', content: reasoning };
      const text = extractText(message.content);
      if (text) yield { type: 'token', content: text };
    }
  }

  // 导出文件在流末尾统一推送：正文的增量渲染不受影响，客户端收到即可给出下载入口
  for (const file of exported) {
    yield { type: 'file', fileId: file.fileId, name: file.name, size: file.size };
  }

  // 工具结果额度用量：判断本轮是否被检索 / 读取挤占，以及是否触发过去重
  logger?.debug('本轮工具结果额度', {
    // 字段名避开 token 子串：日志脱敏按字段名子串匹配，含 token 会被整段打成 ***
    usedBudget: toolBudget.usedTokens,
    budgetLimit: toolBudgetTokens,
    deliveredDocuments: toolBudget.deliveredDocuments.size,
  });
}
