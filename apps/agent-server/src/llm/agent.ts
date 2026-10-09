import type { AppConfig } from '../configuration/config/index.js';
import type { KnowledgeStore } from '../rag/index.js';
import type { Summarizer, ToolBudget } from './context/index.js';
import type { AgentTool, FileSource, GeneratedFileRef, ToolDescriptor } from './tools/index.js';
import type { VisionReader } from './vision.js';
import type { BaseMessage, BaseMessageChunk } from '@langchain/core/messages';
import type { Logger } from '@repo/logger';
import type { AgentStreamEvent } from '@repo/reusable';
import { AIMessageChunk, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { createAgent } from 'langchain';
import { toErrorMessage } from '@repo/shared';
import { describeChatEndpoint, describeChatModel } from '../configuration/config/index.js';
import { describeConnectionError } from '../configuration/errors.js';
import { BUDGET_EXHAUSTED_NOTE, createToolBudget } from './context/index.js';
import { extractReasoning, extractText } from './messageContent.js';
import { createChatModel } from './model.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { createTools, describeTools, readAttachmentText } from './tools/index.js';
import { ToolTrace } from './toolTrace.js';
import { createVisionReader } from './vision.js';

/** 智能体服务：封装 ReAct Agent 的构建与流式调用 */
export class AgentService implements Summarizer {
  /** 对话模型实例：既交给 agent 做推理，也直接用于滚动摘要（见 summarize） */
  private readonly model: ReturnType<typeof createChatModel>;
  private readonly agent: ReturnType<typeof createAgent>;
  /** 注入 Agent 的工具：保留一份引用，管理后台的工具清单据此生成而不是另存一份 */
  private readonly tools: AgentTool[];
  /** 附件存储：预读本轮附件时需要按 ID 取回元数据与字节 */
  private readonly files: FileSource;
  /** 视觉读取器：图片附件由它转述成文字；经构造参数注入，便于测试用替身隔离模型服务 */
  private readonly vision: VisionReader;
  /** 对话模型服务描述，用于把底层连接错误翻译成用户能看懂的提示 */
  private readonly modelTarget: string;
  /** 单轮工具结果额度（token）：由窗口预算与 toolRatio 折算，检索与读取共用这一份 */
  private readonly toolBudgetTokens: number;

  constructor(
    config: AppConfig,
    knowledge: KnowledgeStore,
    files: FileSource,
    vision: VisionReader = createVisionReader(config),
  ) {
    this.files = files;
    this.vision = vision;
    this.tools = createTools(knowledge, files, vision);
    this.model = createChatModel(config);
    this.agent = createAgent({
      model: this.model,
      tools: this.tools,
      systemPrompt: SYSTEM_PROMPT,
      name: 'agent',
    });

    this.modelTarget = `${config.llm.provider}（${describeChatEndpoint(config)}，模型 ${describeChatModel(config)}）`;
    // 额度按窗口折算而非另配绝对数：本地与线上模型的窗口差一个数量级，绝对数会顾此失彼
    this.toolBudgetTokens = Math.round(
      config.llm.context.windowTokens * config.llm.context.toolRatio,
    );
  }

  /**
   * 生成滚动摘要：复用对话模型实例直接 invoke 一次，不走 agent、不带工具。
   * 摘要只是把一段对话压成短文，走 agent 会额外引入工具调用与多轮往返，反而更易跑偏。
   */
  async summarize(prompt: string): Promise<string> {
    const reply = await this.model.invoke(prompt);
    return extractText(reply.content);
  }

  /** 工具清单：管理后台只读展示，字段取自注入 Agent 的同一份工具定义 */
  listTools(): ToolDescriptor[] {
    return describeTools(this.tools);
  }

  /**
   * 本轮附件在模型作答前预读成文本并注入对话。
   * 不依赖模型自行调用 read_file：实测同一张图在「我上传了一张图片…」这类强措辞下能触发读取，
   * 换成「图片里是什么」则 6 轮一次都不读、直接编造答案——小模型对工具调用指令的遵循率撑不起主链路。
   * 预读把「附件有没有被读到」从模型决策变成确定行为，内容直接摆在提问旁边。
   * 单个附件读不到（文件失效、视觉模型不可用）只如实注明，不因此中断整轮对话；
   * 预读正文与检索 / 读取共用本轮的上下文额度，超额度即截断或只留抬头行。
   */
  private async appendAttachments(
    messages: BaseMessage[],
    userId: number,
    fileIds: string[],
    budget: ToolBudget,
    logger?: Logger,
  ) {
    if (fileIds.length === 0) return;
    const attachments = await this.files.list(userId, fileIds);
    if (attachments.length === 0) return;

    // 逐个读取而非并发：本机视觉模型同时处理多张图会明显拖慢，且并发日志难以归因
    const sections: string[] = [];
    for (const file of attachments) {
      const heading = `【${file.name}｜${file.id}】`;
      try {
        const text = await readAttachmentText(this.files, this.vision, userId, file.id, logger);
        // 读不到要让模型知道原因并如实转达，不因此中断整轮对话
        if (text === null) {
          sections.push(`${heading}读取失败：文件不存在或已失效，请如实告知用户。`);
          continue;
        }
        // 预读正文与工具结果共用同一份额度：一份超长附件不能把窗口挤爆
        const admitted = budget.admit(text);
        // 额度耗尽时仍保留抬头行：模型至少知道有这份附件，只是内容没进来
        sections.push(
          admitted ? `${heading}\n${admitted.text}` : `${heading}${BUDGET_EXHAUSTED_NOTE}`,
        );
      } catch (error) {
        sections.push(`${heading}读取失败：${toErrorMessage(error)}`);
      }
    }

    messages.push(
      new SystemMessage(
        [
          '本轮用户附带了以下附件，其内容已由系统预先读取，请直接据此回答，不要编造内容：',
          ...sections,
        ].join('\n\n'),
      ),
    );
  }

  /**
   * 流式执行一轮对话。传入的 messages 已由调用方经 llm/context 组装完毕，
   * 历史窗口裁剪不落在这一层；本类负责附件预读、创建本轮工具结果额度、把消息交给 agent 与把流桥接成事件。
   *
   * 采用 messages 流模式，可直接拿到模型输出的增量分片与工具调用信息；
   * 用户身份与请求级日志经 configurable 下传：前者供知识库工具做可见性过滤，
   * 后者让工具内部日志自动带上 requestId 等上下文，便于按请求检索；
   * 本轮附件 ID 同样经它下传，供文件工具限定可读范围。
   */
  async *stream(
    messages: BaseMessage[],
    options: { userId: number; fileIds: string[]; signal?: AbortSignal; logger?: Logger },
  ): AsyncGenerator<AgentStreamEvent> {
    // 一次工具调用分散在多个分片中：参数攒到能解析时才推 start，
    // 「按调用去重」与「翻译成人话」都收在 ToolTrace 内，这里只负责把结果转发出去
    const toolTrace = new ToolTrace(this.tools);
    // 本轮生成的导出文件：工具负责产出，推给客户端要等流读完再统一做
    const exported: GeneratedFileRef[] = [];
    // 本轮检索命中的文档名：工具负责追加，每次工具结束就推增量
    const sources: string[] = [];
    // 已推给客户端的来源：同一文档被多次检索命中时只出一个标签
    const pushedSources = new Set<string>();
    // 本轮工具结果额度：检索与读取共用，跨同轮多次调用累计（阶段 2 的上下文治理）
    const toolBudget = createToolBudget(this.toolBudgetTokens);

    try {
      // 复制一份再追加附件提示：不改动调用方持有的那份组装结果
      const injected = [...messages];
      await this.appendAttachments(
        injected,
        options.userId,
        options.fileIds,
        toolBudget,
        options.logger,
      );

      const stream = await this.agent.stream(
        { messages: injected },
        {
          streamMode: 'messages',
          signal: options.signal,
          configurable: {
            userId: options.userId,
            fileIds: options.fileIds,
            logger: options.logger,
            exported,
            sources,
            // 本轮工具结果额度：检索与读取工具据它做去重与截断
            toolBudget,
          },
        },
      );

      for await (const item of stream as AsyncIterable<unknown>) {
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
            if (start)
              yield { type: 'tool', name: start.name, status: 'start', detail: start.detail };
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
      options.logger?.debug('本轮工具结果额度', {
        // 字段名避开 token 子串：日志脱敏按字段名子串匹配，含 token 会被整段打成 ***
        usedBudget: toolBudget.usedTokens,
        budgetLimit: this.toolBudgetTokens,
        deliveredDocuments: toolBudget.deliveredDocuments.size,
      });
    } catch (error) {
      throw describeConnectionError(error, this.modelTarget, '对话模型服务');
    }
  }
}
