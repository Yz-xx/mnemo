import type { Response } from 'express';
import { toErrorMessage } from '../errors.js';
import type { Conversation } from '../conversation/types.js';
import type { ConversationStore } from '../conversation/store.js';
import type { AgentService } from '../llm/agent.js';
import { preview } from '@repo/logger';
import type { Logger } from '@repo/logger';

/** 出参摘要保留的回复开头长度：足以判断回答是否切题，又不至于把整篇回答写进日志 */
const ANSWER_PREVIEW = 200;

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
 * 日志按「一轮对话」聚合耗时、答复长度与用到的工具，便于事后判断是模型慢还是检索慢。
 */
export async function streamChatReply(input: {
  res: Response;
  agent: AgentService;
  conversations: ConversationStore;
  logger: Logger;
  userId: number;
  conversation: Conversation;
}): Promise<void> {
  const { res, agent, conversations, logger, userId, conversation } = input;
  const log = logger.child({ userId, conversationId: conversation.id });
  const startedAt = Date.now();
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
  const usedTools = new Set<string>();
  try {
    for await (const event of agent.stream(conversation.messages, {
      userId,
      signal: controller.signal,
      // 下传请求级子日志：工具内部的检索日志会自带 requestId 与 conversationId
      logger: log,
    })) {
      if (event.type === 'token') answer += event.content;
      if (event.type === 'tool') {
        if (event.status === 'start') usedTools.add(event.name);
        log.debug('工具调用', { tool: event.name, status: event.status });
      }
      send(event);
    }
    // 仅在有正文时落库，避免保存空回复
    if (answer.trim()) await conversations.append(userId, conversation.id, 'assistant', answer);
    const latest = await conversations.get(userId, conversation.id);
    log.info('本轮对话完成', {
      durationMs: Date.now() - startedAt,
      answerLength: answer.length,
      // SSE 不走 res.json，出参摘要须在此记录，否则流式接口的回复内容无从追溯
      answerPreview: answer.length > 0 ? preview(answer, ANSWER_PREVIEW) : undefined,
      tools: usedTools.size > 0 ? [...usedTools].join(',') : undefined,
    });
    send({
      type: 'done',
      conversationId: conversation.id,
      title: latest?.title ?? conversation.title,
    });
  } catch (error) {
    // 客户端主动中断不算错误，无需回推
    if (controller.signal.aborted) {
      log.info('客户端中断，已停止生成', {
        durationMs: Date.now() - startedAt,
        answerLength: answer.length,
      });
    } else {
      log.error('本轮对话失败', { durationMs: Date.now() - startedAt, error });
      send({ type: 'error', message: toErrorMessage(error) });
    }
  } finally {
    res.end();
  }
}
