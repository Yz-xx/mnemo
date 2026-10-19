import type { ChatRound } from './round.js';
import type { RoundRegistry } from './roundRegistry.js';
import type { ContextConfig } from '../../configuration/config/index.js';
import type { Conversation } from '../../entities/conversation.js';
import type { ConversationStore } from '../../mappers/conversation/conversations.js';
import type { AgentService } from '../llm/agent.js';
import type { Logger } from '@repo/logger';
import { runChatRoundTask } from './chatRoundTask.js';
import { RoundConflictError } from './roundRegistry.js';

/** 开启一轮对话所需的输入：与原先 streamChatReply 一致，另加轮次 ID 与注册表 */
export interface StartChatRoundInput {
  rounds: RoundRegistry;
  agent: AgentService;
  conversations: ConversationStore;
  logger: Logger;
  userId: number;
  /** 客户端生成的轮次 ID：同时充当本轮幂等键 */
  roundId: string;
  /** 目标会话 ID；留空表示本轮新建会话 */
  conversationId: string | undefined;
  /** 路由层已读入的会话历史（含摘要）；新建会话时为 undefined */
  history: Conversation | undefined;
  content: string;
  /** 本轮附带的文件 ID：已由路由校验归属 */
  fileIds: string[];
  /** 本轮附带的文件名：随提问一起落库，历史回看时还原附件标签 */
  attachmentNames: string[];
  contextConfig: ContextConfig;
}

/** 开启结果：轮次实例 + 整轮完成信号 */
export interface StartedChatRound {
  round: ChatRound;
  /**
   * 整轮任务的完成信号：内部自吞异常，永不 reject。
   * 会话锁与「订阅结束后等待收尾」都靠它，故它若会拒绝就会变成进程级未处理拒绝。
   */
  done: Promise<void>;
}

/**
 * 开启一轮对话：先占轮次号再落库提问，随后把整轮任务脱离请求生命周期在后台跑起来。
 * 先占号是为了让同号并发的 POST 只有一个能建轮次（另一个收到 RoundConflictError 改为订阅），
 * 不会重复落一条用户消息、也不会重复生成。
 */
export async function startChatRound(input: StartChatRoundInput): Promise<StartedChatRound> {
  const { rounds, conversations, logger, userId, roundId } = input;
  const round = rounds.create(userId, roundId);
  let appended;
  try {
    appended = await conversations.append(
      userId,
      input.conversationId,
      'user',
      input.content,
      { attachments: input.attachmentNames.length > 0 ? input.attachmentNames : undefined },
      input.history,
    );
  } catch (error) {
    // 已占号但没落库成功：本轮不会有任何产出了，直接收尾，避免订阅者永久等待
    round.finish();
    throw error;
  }
  const { conversation, message: userMessage } = appended;
  const log = logger.child({ userId, conversationId: conversation.id, roundId });

  const done = runChatRoundTask({
    round,
    agent: input.agent,
    conversations,
    logger,
    userId,
    conversation,
    userMessage,
    history: input.history,
    fileIds: input.fileIds,
    contextConfig: input.contextConfig,
    isNewConversation: input.conversationId === undefined,
  }).catch((error: unknown) => {
    // 后台任务逃逸的异常必须在此吞掉：否则会触发进程级 unhandledRejection 退出
    log.error('轮次任务未捕获异常', { error });
    round.finish();
  });

  return { round, done };
}

/** 本轮冲突时调用方要用的错误类型再导出一次，省得路由层再单独 import 注册表模块 */
export { RoundConflictError };
