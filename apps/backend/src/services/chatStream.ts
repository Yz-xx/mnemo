import type { Response } from 'express';
import type { Conversation } from '../conversation/types.js';
import type { ConversationStore } from '../conversation/store.js';
import type { AgentService } from '../llm/agent.js';

/** 流式推送的事件：与桌面端消费的事件结构保持一致 */
export type ChatStreamEvent =
  | { type: 'token'; content: string }
  | { type: 'tool'; name: string; status: 'start' | 'end' }
  | { type: 'done'; conversationId: string; title: string }
  | { type: 'error'; message: string };

/** SSE 响应头：禁用缓存与缓冲，保证增量内容即时到达客户端 */
function openEventStream(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}

/**
 * 把一轮智能体输出以 SSE 写回响应，并在结束后把回复落库。
 * 客户端断开时同步中断模型调用，避免继续消耗算力。
 */
export async function streamChatReply(input: {
  res: Response;
  agent: AgentService;
  conversations: ConversationStore;
  userId: number;
  conversation: Conversation;
}): Promise<void> {
  const { res, agent, conversations, userId, conversation } = input;
  openEventStream(res);

  const send = (event: ChatStreamEvent): void => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // 注意：req 的 close 在请求体读取完成后即会触发（会误中断流式响应），故监听 res；
  // 排除 res.writableEnded 以跳过正常结束时的回调。
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  let answer = '';
  try {
    for await (const event of agent.stream(conversation.messages, {
      userId,
      signal: controller.signal,
    })) {
      if (event.type === 'token') answer += event.content;
      send(event);
    }
    // 仅在有正文时落库，避免保存空回复
    if (answer.trim()) await conversations.append(userId, conversation.id, 'assistant', answer);
    const latest = await conversations.get(userId, conversation.id);
    send({
      type: 'done',
      conversationId: conversation.id,
      title: latest?.title ?? conversation.title,
    });
  } catch (error) {
    // 客户端主动中断不算错误，无需回推
    if (!controller.signal.aborted) {
      send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  } finally {
    res.end();
  }
}
