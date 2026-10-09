import type { ConcurrencyConfig, ContextConfig } from '../configuration/config/index.js';
import type { ConversationStore } from '../conversation/store/index.js';
import type { AgentService } from '../llm/agent.js';
import type { Logger } from '@repo/logger';
import type { ChatStreamEvent } from '@repo/reusable';
import type { Response } from 'express';
import { preview } from '@repo/logger';
import { toErrorMessage } from '@repo/shared';
import { governContext } from './contextGovernance.js';

/** 出参摘要保留的回复开头长度：足以判断回答是否切题，又不至于把整篇回答写进日志 */
const ANSWER_PREVIEW = 200;

/** 集合转数组：空集合给 undefined 而非空数组（落库写 NULL、日志不出现空串） */
const toOptionalList = (values: Set<string>): string[] | undefined =>
  values.size > 0 ? [...values] : undefined;

/** SSE 响应头：禁用缓存与缓冲，保证增量内容即时到达客户端 */
function openEventStream(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}

/**
 * 编排一整轮对话：落库提问 → 组装上下文 → 流式写回响应 → 落库回复，并回滚没有产出的新建会话。
 * 客户端断开时同步中断模型调用，避免继续消耗算力。
 * 日志按「一轮对话」聚合耗时、答复长度、用到的工具与上下文取舍，便于事后判断是模型慢、检索慢还是被裁了历史。
 */
export async function streamChatReply(input: {
  res: Response;
  agent: AgentService;
  conversations: ConversationStore;
  logger: Logger;
  userId: number;
  /** 目标会话 ID；留空表示本轮新建会话 */
  conversationId: string | undefined;
  /** 本轮用户提问 */
  content: string;
  /** 本轮附带的文件 ID：已由路由校验归属，工具据此判断可读范围 */
  fileIds: string[];
  /** 本轮附带的文件名：随提问一起落库，历史回看时还原附件标签 */
  attachmentNames: string[];
  /** 上下文治理配置：决定本轮是否裁剪历史以及裁到多少 */
  contextConfig: ContextConfig;
  /** 并发治理配置：决定单轮最长时长与 SSE 背压上限 */
  concurrencyConfig: ConcurrencyConfig;
}): Promise<void> {
  const {
    res,
    agent,
    conversations,
    logger,
    userId,
    conversationId,
    content,
    fileIds,
    attachmentNames,
    contextConfig,
    concurrencyConfig,
  } = input;

  // 先落库提问：新会话在这里创建，本轮若没有产出才好整体回滚。
  // 必须在开启 SSE 之前做，落库失败仍按普通请求返回 500，而不是已 flush 的事件流
  const conversation = await conversations.append(userId, conversationId, 'user', content, {
    attachments: attachmentNames.length > 0 ? attachmentNames : undefined,
  });
  const log = logger.child({ userId, conversationId: conversation.id });
  const startedAt = Date.now();
  openEventStream(res);

  // 注意：req 的 close 在请求体读取完成后即会触发（会误中断流式响应），故监听 res；
  // 排除 res.writableEnded 以跳过正常结束时的回调。
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  // 单轮最长时长：到点中断本轮，防止半死连接永久占住一个在途额度与一份内存
  let roundTimedOut = false;
  const roundTimer = setTimeout(() => {
    roundTimedOut = true;
    controller.abort();
  }, concurrencyConfig.chatMaxDurationMs);
  // 慢客户端：SSE 写缓冲满且等不到 drain，本轮已主动断开
  let slowClient = false;

  /** 直写一帧：写缓冲满时等 drain，等不到则返回 false 交由调用方断开 */
  const writeChunk = (chunk: string): Promise<boolean> => {
    if (res.write(chunk)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let settle: (ok: boolean) => void = () => undefined;
      const onDrain = (): void => settle(true);
      // 定时器先建好、settle 后赋值：既能在此处引用 settle，又不必用可变量持有句柄
      const timer = setTimeout(() => settle(false), concurrencyConfig.sseDrainTimeoutMs);
      settle = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        res.off('drain', onDrain);
        resolve(ok);
      };
      res.once('drain', onDrain);
    });
  };

  /** 推送一个 SSE 事件；背压超时即按慢客户端断开并中断本轮，避免内存继续堆积 */
  const send = async (event: ChatStreamEvent): Promise<void> => {
    if (res.writableEnded) return;
    if (await writeChunk(`data: ${JSON.stringify(event)}\n\n`)) return;
    slowClient = true;
    controller.abort();
  };

  let answer = '';
  // 模型是否已经开始回应：中途被停止时，用户已经看到内容，此时不回滚，避免丢掉刚发出的提问
  let responded = false;
  // 本轮是否正常收尾（已推送 done）
  let finished = false;
  // 本轮正文是否已落库：正常收尾与中断路径都会尝试落库，用标志避免写重复
  let answerSaved = false;
  const usedTools = new Set<string>();
  // 本轮检索命中的知识库文档名：随回复一起落库，历史回看时还原来源标签
  const usedSources = new Set<string>();

  /** 仅在有正文时落库，避免保存空回复；工具轨迹与检索来源一并落库，历史回看时还原标签 */
  const persistAnswer = async (): Promise<void> => {
    if (answerSaved || !answer.trim()) return;
    await conversations.append(userId, conversation.id, 'assistant', answer, {
      tools: toOptionalList(usedTools),
      sources: toOptionalList(usedSources),
    });
    answerSaved = true;
  };

  try {
    // 摘要落库：条件更新保证截断点单调，返回是否真正写入
    const persistSummary = (text: string, uptoSeq: number): Promise<boolean> =>
      conversations.saveSummary(userId, conversation.id, text, uptoSeq);
    // 上下文组装：先把保留窗口之前的未摘要段交给模型摘要，摘要失败才退化为丢弃最老轮次。
    // 模型调用与落库收在 contextGovernance 内，这层只消费结果并观测取舍
    const governed = await governContext({
      history: conversation.messages,
      summary: conversation.summary ?? null,
      summaryUptoSeq: conversation.summaryUptoSeq ?? null,
      config: contextConfig,
      summarizer: agent,
      persistSummary,
      logger: log,
    });

    for await (const event of agent.stream(governed.messages, {
      userId,
      fileIds,
      signal: controller.signal,
      // 下传请求级子日志：工具内部的检索日志会自带 requestId 与 conversationId
      logger: log,
    })) {
      if (!responded) {
        // 首个产出之前补推会话 ID：本轮从此刻起一定会保留（回滚只看有没有产出），
        // 客户端因此在同一时刻知晓会话 ID，不会记住一个稍后会被删掉的会话
        responded = true;
        await send({ type: 'conversation', conversationId: conversation.id });
        // 上下文治理痕迹：只在真的裁掉历史时下发，避免每轮都挂一条无意义提示。
        // 与 conversation 同刻推送：本轮确认有产出、会话会保留，这条提示才不会挂在随后被回滚的消息上
        if (governed.trimmedMessages > 0) {
          await send({
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
      await send(event);
    }
    await persistAnswer();
    const latest = await conversations.get(userId, conversation.id);
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
      // 本轮是否产出新的滚动摘要：与上两项对照，判断治理走的是摘要还是丢弃
      summarized: governed.summarized,
    });
    await send({
      type: 'done',
      conversationId: conversation.id,
      title: latest?.title ?? conversation.title,
    });
    finished = true;
  } catch (error) {
    // 出错与中断都已产出的正文先落库：用户已经看到的内容不能凭空消失，
    // 否则重开会话时界面上那段回复会不见。落库失败只记警告——
    // 异常路径无处回推，而它也不该盖住下面真正要处理的原始错误
    try {
      await persistAnswer();
    } catch (saveError) {
      log.warn('部分回复落库失败', { error: saveError });
    }
    if (roundTimedOut) {
      // 单轮超时：已产出的正文已落库，再推一条 error 让客户端知道本轮被截断
      log.warn('单轮对话超时已中断', {
        durationMs: Date.now() - startedAt,
        answerLength: answer.length,
      });
      await send({ type: 'error', message: '本轮对话超时，已中断' });
    } else if (controller.signal.aborted) {
      // 客户端中断与慢客户端断开都不算错误，无需回推
      log.info(slowClient ? '慢客户端，已断开' : '客户端中断，已停止生成', {
        durationMs: Date.now() - startedAt,
        answerLength: answer.length,
      });
    } else {
      log.error('本轮对话失败', { durationMs: Date.now() - startedAt, error });
      await send({ type: 'error', message: toErrorMessage(error) });
    }
  } finally {
    clearTimeout(roundTimer);
    res.end();
  }

  // 新建的会话若整轮既没正常收尾也没有任何产出（模型服务未启动、刚发出就被停止），就只剩这条提问：
  // 连会话一起删除，否则列表里会留下一条没有回复的记录，下次发送还会再建一条
  if (!conversationId && !finished && !responded) {
    try {
      if (await conversations.remove(userId, conversation.id)) {
        log.info('本轮无产出，已删除新建会话');
      }
    } catch (error) {
      // 响应已结束，这里的异常无处可报；留一条无回复记录比中断请求轻
      log.warn('删除无产出会话失败', { error });
    }
  }
}
