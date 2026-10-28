import type { AppConfig } from '../../configuration/config/index.js';
import type { MetricsRegistry } from '../../infrastructure/observability/index.js';
import type { KnowledgeStore } from '../knowledge/index.js';
import type { Summarizer } from './context/index.js';
import type { AgentTool, FileSource, GeneratedFileRef, ToolDescriptor } from './tools/index.js';
import type { VisionReader } from './vision.js';
import type { BaseMessage } from '@langchain/core/messages';
import type { Logger } from '@mnemo/logger';
import type { AgentStreamEvent } from '@mnemo/reusable';
import { createAgent } from 'langchain';
import { describeConnectionError } from '../../common/errors.js';
import { describeChatEndpoint, describeChatModel } from '../../configuration/config/index.js';
import { ParseGovernance } from '../../infrastructure/files/parseGovernance.js';
import { METRIC } from '../../infrastructure/observability/index.js';
import { appendAttachmentHints } from './attachments.js';
import { createCitations } from './citations.js';
import { createToolBudget } from './context/index.js';
import { extractText } from './messageContent.js';
import { createChatModel } from './model.js';
import { ModelGovernance } from './modelGovernance.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { bridgeAgentStream } from './streamBridge.js';
import { createTools, describeTools } from './tools/index.js';
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
   * 流式执行一轮对话。传入的 messages 已由调用方经 services/llm/context 组装完毕，
   * 历史窗口裁剪不落在这一层；本类负责附件预读、创建本轮工具结果额度、把消息交给 agent，
   * 再由 streamBridge 把模型流桥接成事件（见 services/llm/streamBridge.ts）。
   *
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

    // 本轮生成的导出文件：工具负责产出，推给客户端要等流读完再统一做
    const exported: GeneratedFileRef[] = [];
    // 本轮检索命中的文档名：工具负责追加，每次工具结束就推增量
    const sources: string[] = [];
    // 本轮工具结果额度：检索与读取共用，跨同轮多次调用累计（阶段 2 的上下文治理）
    const toolBudget = createToolBudget(this.toolBudgetTokens);
    // 本轮来源登记器：检索工具注入片段时登记，流结束后据此从正文判定实际采用
    const citations = createCitations();

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
            citations,
            // 本轮工具结果额度：检索与读取工具据它做去重与截断
            toolBudget,
          },
        },
      );

      // 模型流的消费、工具轨迹翻译与导出文件推送都收在 streamBridge 内
      yield* bridgeAgentStream({
        stream: stream as AsyncIterable<unknown>,
        tools: this.tools,
        exported,
        sources,
        citations,
        toolBudget,
        toolBudgetTokens: this.toolBudgetTokens,
        logger: options.logger,
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
