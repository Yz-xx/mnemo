import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AppDependencies } from '../app.js';

type ChatStreamEvent =
  | { type: 'token'; content: string }
  | { type: 'tool'; name: string; status: 'start' | 'end' }
  | { type: 'done'; conversationId: string; title: string }
  | { type: 'error'; message: string };

/** 对话接口：以 SSE 方式返回流式回复 */
export function createChatRouter({ agent, conversations }: AppDependencies): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response) => {
    const body = req.body as { conversationId?: string; message?: string };
    const content = typeof body.message === 'string' ? body.message.trim() : '';
    if (!content) {
      res.status(400).json({ message: '消息内容不能为空' });
      return;
    }
    // 指定了不存在的会话时直接报错，避免静默新建导致混淆
    if (body.conversationId && !conversations.get(body.conversationId)) {
      res.status(404).json({ message: '会话不存在' });
      return;
    }

    const conversation = conversations.append(body.conversationId, 'user', content);

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (event: ChatStreamEvent): void => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // 客户端断开时同步中断模型调用，避免继续消耗算力。
    // 注意：req 的 close 在请求体读取完成后即会触发（会误中断流式响应），故监听 res；
    // 排除 res.writableEnded 以跳过正常结束时的回调。
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    let answer = '';
    try {
      for await (const event of agent.stream(conversation.messages, controller.signal)) {
        if (event.type === 'token') answer += event.content;
        send(event);
      }
      // 仅在有正文时落库，避免保存空回复
      if (answer.trim()) conversations.append(conversation.id, 'assistant', answer);
      const latest = conversations.get(conversation.id);
      send({
        type: 'done',
        conversationId: conversation.id,
        title: latest?.title ?? conversation.title,
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      res.end();
    }
  });

  return router;
}
