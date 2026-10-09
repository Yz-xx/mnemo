import type { AppConfig } from '../configuration/config/index.js';
import type { MetricsRegistry } from '../observability/index.js';
import type { KnowledgeStore } from '../rag/index.js';
import type { Summarizer } from './context/index.js';
import type { AgentTool, FileSource, GeneratedFileRef, ToolDescriptor } from './tools/index.js';
import type { VisionReader } from './vision.js';
import type { BaseMessage, BaseMessageChunk } from '@langchain/core/messages';
import type { Logger } from '@repo/logger';
import type { AgentStreamEvent } from '@repo/reusable';
import { AIMessageChunk, ToolMessage } from '@langchain/core/messages';
import { createAgent } from 'langchain';
import { describeChatEndpoint, describeChatModel } from '../configuration/config/index.js';
import { describeConnectionError } from '../configuration/errors.js';
import { ParseGovernance } from '../files/parseGovernance.js';
import { METRIC } from '../observability/index.js';
import { appendAttachmentHints } from './attachments.js';
import { createToolBudget } from './context/index.js';
import { extractReasoning, extractText } from './messageContent.js';
import { createChatModel } from './model.js';
import { ModelGovernance } from './modelGovernance.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { createTools, describeTools } from './tools/index.js';
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
  /** 模型侧治理：闸门与熔断的申请 / 归还 / 回报口径都收在它内部（见 docs/adr/0010 决策 9、10、16） */
  private readonly governance: ModelGovernance;
  /** 附件解析治理：解析走独立闸门，过载时读路径降级（见 docs/adr/0010 决策 14） */
  private readonly parse: ParseGovernance;
  /** 对话模型服务描述，用于把底层连接错误翻译成用户能看懂的提示 */
  private readonly modelTarget: string;
  /** 单轮工具结果额度（token）：由窗口预算与 toolRatio 折算，检索与读取共用这一份 */
  private readonly toolBudgetTokens: number;
  /** 指标注册表：记录单轮模型侧耗时；未注入时埋点短路 */
  private readonly metrics?: MetricsRegistry;

  constructor(
    config: AppConfig,
    knowledge: KnowledgeStore,
    files: FileSource,
    vision: VisionReader = createVisionReader(config),
    logger?: Logger,
    metrics?: MetricsRegistry,
  ) {
    this.files = files;
    this.vision = vision;
    this.metrics = metrics;
    // 解析闸门先建：工具与附件预读都要经它约束解析（解析发生在对话轮，不在上传请求内）
    this.parse = new ParseGovernance(config, logger);
    this.tools = createTools(knowledge, files, vision, this.parse);
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
    // 闸门与熔断都是进程内状态，重启即清零；水位与阈值统一由 env.ts 收敛
    this.governance = new ModelGovernance(config, logger);
  }

  /**
   * 生成滚动摘要：复用对话模型实例直接 invoke 一次，不走 agent、不带工具。
   * 摘要只是把一段对话压成短文，走 agent 会额外引入工具调用与多轮往返，反而更易跑偏。
   * 走独立的低优先额度：额度被占时直接拒绝，由 contextGovernance 捕获后退化为丢弃最老历史，
   * 绝不挤占用户可见的首 token 时延（见 docs/adr/0010 决策 10）
   */
  async summarize(prompt: string): Promise<string> {
    const reply = await this.governance.summarize(() => this.model.invoke(prompt));
    return extractText(reply.content);
  }

  /** 工具清单：管理后台只读展示，字段取自注入 Agent 的同一份工具定义 */
  listTools(): ToolDescriptor[] {
    return describeTools(this.tools);
  }

  /**
   * 流式执行一轮对话。传入的 messages 已由调用方经 llm/context 组装完毕，
   * 历史窗口裁剪不落在这一层；本类负责附件预读、创建本轮工具结果额度、把消息交给 agent 与把流桥接成事件。
   *
   * 采用 messages 流模式，可直接拿到模型输出的增量分片与工具调用信息；
   * 用户身份与请求级日志经 configurable 下传：前者供知识库工具做可见性过滤，
   * 后者让工具内部日志自动带上 requestId 等上下文，便于按请求检索；
   * 本轮附件 ID 同样经它下传，供文件工具限定可读范围。
   *
   * 模型额度在进入本轮前申请：排队超时即按过载拒绝，熔断打开即快速失败，
   * 两者都在发起真实调用之前挡下，避免把压力转成一大批并发超时（见 docs/adr/0010 决策 9、16）
   */
  async *stream(
    messages: BaseMessage[],
    options: { userId: number; fileIds: string[]; signal?: AbortSignal; logger?: Logger },
  ): AsyncGenerator<AgentStreamEvent> {
    await this.governance.enterRound(options.signal);
    // 单轮模型侧耗时从入闸成功算起：排队等待另行观测，避免把过载等待算进生成耗时
    const startedAt = Date.now();

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
      await appendAttachmentHints({
        messages: injected,
        files: this.files,
        vision: this.vision,
        parse: this.parse,
        userId: options.userId,
        fileIds: options.fileIds,
        budget: toolBudget,
        logger: options.logger,
      });

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

      // 整轮跑完即视为依赖正常：熔断计数归零，从半开恢复闭合
      this.governance.reportSuccess();
    } catch (error) {
      // 客户端中断 / 单轮超时不算依赖故障，但要归还半开探测名额（见 reportFailure）
      this.governance.reportFailure(options.signal?.aborted === true);
      throw describeConnectionError(error, this.modelTarget, '对话模型服务');
    } finally {
      // 单轮模型侧总耗时：从入闸成功算起（排除排队等待），便于区分慢在过载还是慢在生成
      this.metrics?.observe(METRIC.LLM_ROUND, Date.now() - startedAt);
      this.governance.exitRound();
    }
  }
}
