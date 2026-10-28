import type { ChatRound, RoundAbortReason } from './round.js';
import type { ContextConfig } from '../../configuration/config/index.js';
import type {
  Conversation,
  ConversationHeader,
  StoredMessage,
} from '../../entities/conversation.js';
import type { ConversationStore } from '../../mappers/conversation/conversations.js';
import type { AgentService } from '../llm/agent.js';
import type { Logger } from '@mnemo/logger';
import { preview } from '@mnemo/logger';
import { toErrorMessage } from '@mnemo/shared';
import { ModelOverloadedError } from '../llm/modelGovernance.js';
import { governContext } from './contextGovernance.js';

/** 出参摘要保留的回复开头长度：足以判断回答是否切题，又不至于把整篇回答写进日志 */
const ANSWER_PREVIEW = 200;

/**
 * 中止原因对应的对外文案：中止一律推 error、绝不推 done（见 docs/adr/0015 决策 14）。
 * 只有自然完成才 done —— 客户端据此区分「读完了」与「被中途掐断，可重连补齐」。
 */
const ABORT_MESSAGE: Record<RoundAbortReason, string> = {
  user: '本轮已停止生成',
  timeout: '本轮对话超时，已中断',
  shutdown: '服务正在重启，本轮已中断',
  'detached-limit': '本轮已超出后台续生成上限，已中断',
};

/** 集合转数组：空集合给 undefined 而非空数组（落库写 NULL、日志不出现空串） */
const toOptionalList = (values: Set<string>): string[] | undefined =>
  values.size > 0 ? [...values] : undefined;

/** 轮次任务的输入：会话与提问已由编排层落库，这里只负责生成、落库回复与收尾 */
export interface ChatRoundTaskInput {
  round: ChatRound;
  agent: AgentService;
  conversations: ConversationStore;
  logger: Logger;
  userId: number;
  /** 本轮所属会话头：回填助手消息时透传，助手消息不改标题故无需回读 */
  conversation: ConversationHeader;
  /** 本轮刚落库的提问：并入上下文本次注入模型 */
  userMessage: StoredMessage;
  /** 路由层已读入的历史（含摘要）；新建会话时为 undefined */
  history: Conversation | undefined;
  /** 本轮附带的文件 ID：已由路由校验归属 */
  fileIds: string[];
  contextConfig: ContextConfig;
  /** 本轮是否新建会话：无产出时据此整体回滚 */
  isNewConversation: boolean;
}

/**
 * 跑完一整轮对话并写进轮次事件日志：组装上下文 → 流式发布事件 → 落库回复 → 发布 done。
 * 与请求生命周期彻底解耦：客户端断开不再中断生成，故本轮必须顶层自吞异常——
 * 逃逸的拒绝会触发进程级 unhandledRejection 直接退出（见 infrastructure/lifecycle.ts）。
 */
export async function runChatRoundTask(input: ChatRoundTaskInput): Promise<void> {
  const {
    round,
    agent,
    conversations,
    logger,
    userId,
    conversation,
    userMessage,
    history,
    fileIds,
    contextConfig,
    isNewConversation,
  } = input;
  const log = logger.child({ userId, conversationId: conversation.id, roundId: round.id });
  const startedAt = Date.now();

  let answer = '';
  // 模型是否已开始回应：中途被中止时用户已看到内容，此时不回滚，避免丢掉刚发出的提问
  let responded = false;
  // 本轮是否正常收尾（已发布 done）
  let finished = false;
  // 正文是否已落库：正常收尾与中止路径都会尝试落库，用标志避免写重复
  let answerSaved = false;
  const usedTools = new Set<string>();
  const usedSources = new Set<string>();

  /** 仅在有正文时落库，避免保存空回复；工具轨迹与检索来源一并落库，历史回看时还原标签 */
  const persistAnswer = async (): Promise<void> => {
    if (answerSaved || !answer.trim()) return;
    await conversations.append(
      userId,
      conversation.id,
      'assistant',
      answer,
      { tools: toOptionalList(usedTools), sources: toOptionalList(usedSources) },
      // 透传已知会话头：助手消息不改标题，无需再读一次
      conversation,
    );
    answerSaved = true;
  };

  try {
    const persistSummary = (text: string, uptoSeq: number): Promise<boolean> =>
      conversations.saveSummary(userId, conversation.id, text, uptoSeq);
    // 上下文组装：本轮历史 = 路由层读入的旧消息 + 刚落库的提问（只读一次并逐层透传）。
    // 先把保留窗口之前的未摘要段交给模型摘要，摘要失败才退化为丢弃最老轮次
    const governed = await governContext({
      history: history ? [...history.messages, userMessage] : [userMessage],
      summary: history?.summary ?? null,
      summaryUptoSeq: history?.summaryUptoSeq ?? null,
      config: contextConfig,
      summarizer: agent,
      persistSummary,
      logger: log,
    });

    for await (const event of agent.stream(governed.messages, {
      userId,
      fileIds,
      // 用轮次信号：客户端断开不再触发它，只有停止 / 超时 / 停机 / 超限才会
      signal: round.signal,
      logger: log,
    })) {
      if (!responded) {
        // 首个产出之前补推会话 ID：本轮从此刻起一定会保留（回滚只看有没有产出），
        // 客户端因此在同一时刻知晓会话 ID，不会记住一个稍后会被删掉的会话
        responded = true;
        round.publish({ type: 'conversation', conversationId: conversation.id });
        // 上下文治理痕迹：只在真的裁掉历史时下发，避免每轮都挂一条无意义提示
        if (governed.trimmedMessages > 0) {
          round.publish({
            type: 'context',
            trimmedMessages: governed.trimmedMessages,
            summarized: governed.summarized,
          });
        }
      }
      if (event.type === 'token') answer += event.content;
      if (event.type === 'tool') {
        // 无论 start 还是 end 都记入：某些情况下 start 分片可能丢失，
        // 只在 start 时 add 会让历史回看漏掉该工具标签
        usedTools.add(event.name);
        log.debug('工具调用', { tool: event.name, status: event.status });
      }
      // 检索来源随回复一起落库：切换历史会话时由服务端回读，标签不会凭空消失
      if (event.type === 'source') usedSources.add(event.name);
      // 终局清单覆盖过程中的召回结果：正文实际采用的文档才是这条回复的出处
      if (event.type === 'sources') {
        usedSources.clear();
        for (const name of event.names) usedSources.add(name);
      }
      round.publish(event);
    }

    await persistAnswer();
    log.info('本轮对话完成', {
      durationMs: Date.now() - startedAt,
      answerLength: answer.length,
      // SSE 不走 res.json，出参摘要须在此记录，否则流式接口的回复内容无从追溯
      answerPreview: answer.length > 0 ? preview(answer, ANSWER_PREVIEW) : undefined,
      tools: toOptionalList(usedTools)?.join(','),
      sources: toOptionalList(usedSources)?.join(','),
      // 上下文取舍：估算量与生效预算对照，可判断本轮是否触发裁剪、裁掉了多少条。
      // 字段名避开 token 子串：日志脱敏按字段名子串匹配，含 token 会被整段打成 ***
      estimatedContextSize: governed.estimatedTokens,
      trimmedMessages: governed.trimmedMessages,
      windowBudget: governed.windowBudget,
      summarized: governed.summarized,
      // 轮次侧统计：订阅者峰值大于 1 说明发生过重连，脱离时长可判断后台跑了多久
      ...round.stats(),
    });
    round.publish({ type: 'done', conversationId: conversation.id, title: conversation.title });
    finished = true;
  } catch (error) {
    // 出错与中止都已产出的正文先落库：用户已经看到的内容不能凭空消失。
    // 落库失败只记警告——异常路径无处回推，它也不该盖住下面真正要处理的原始错误
    try {
      await persistAnswer();
    } catch (saveError) {
      log.warn('部分回复落库失败', { error: saveError });
    }
    if (round.abortReason) {
      // 中止原因决定文案：客户端据此知道本轮为什么停（而不是以为读完了）
      log.warn('本轮被中止', {
        reason: round.abortReason,
        durationMs: Date.now() - startedAt,
        answerLength: answer.length,
        ...round.stats(),
      });
      round.publish({ type: 'error', message: ABORT_MESSAGE[round.abortReason] });
    } else if (error instanceof ModelOverloadedError) {
      // 过载拒绝是可重试的临时态：按警告记录，不混进错误率口径（见 docs/adr/0010 决策 17）
      log.warn('模型闸门过载，本轮被拒绝', { durationMs: Date.now() - startedAt });
      round.publish({ type: 'error', message: toErrorMessage(error) });
    } else {
      log.error('本轮对话失败', { durationMs: Date.now() - startedAt, error });
      round.publish({ type: 'error', message: toErrorMessage(error) });
    }
  } finally {
    // 收尾一律走 finish：正常完成与中止都在此关闭轮次，订阅者据此结束重放
    round.finish();
  }

  // 新建的会话若整轮既没正常收尾也没有任何产出（模型服务未启动、刚发出就被停止），就只剩这条提问：
  // 连会话一起删除，否则列表里会留下一条没有回复的记录，下次发送还会再建一条
  if (isNewConversation && !finished && !responded) {
    try {
      if (await conversations.remove(userId, conversation.id)) {
        log.info('本轮无产出，已删除新建会话');
      }
    } catch (error) {
      // 轮次已收尾，这里的异常无处可报；留一条无回复记录比让任务抛出轻
      log.warn('删除无产出会话失败', { error });
    }
  }
}
