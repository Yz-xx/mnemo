/**
 * 对话流协议：服务端推送的 SSE 事件结构。
 * 放在本包而非各端各写一份，是因为两端手抄的副本必然漂移
 * （桌面端曾多出一个服务端从不下发的 `detail` 字段），而漂移只在运行期
 * 以「客户端把不认识的字段当成了协议的一部分」的形式暴露。
 */

/**
 * 检索命中的可定位引用：回答里的角标与预览抽屉都靠它。
 * page 只对带页标记的原文（PDF）有值；snippet 是片段截断版，原文另经预览接口取。
 */
export interface KnowledgeCitation {
  /** 所属文档 ID：预览接口按它取原文 */
  documentId: string;
  /** 片段 ID：文本预览据此定位高亮 */
  chunkId: string;
  title: string;
  /** 片段所在原始文件页码；文本来源或旧数据无定位信息时为 null */
  page: number | null;
  /** 片段摘要：引用卡片展示用，不保证覆盖全文 */
  snippet: string;
  score: number;
}

/** SSE error 事件的机器可读分类：文案仍中文，客户端按 code 分支提示 */
export const CHAT_ERROR_CODE = {
  KB_NOT_READY: 'KB_NOT_READY',
  CONTEXT_TOO_LONG: 'CONTEXT_TOO_LONG',
  MODEL_TIMEOUT: 'MODEL_TIMEOUT',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ChatErrorCode = (typeof CHAT_ERROR_CODE)[keyof typeof CHAT_ERROR_CODE];

/**
 * 智能体自身产出的增量事件：由 LLM 层逐条 yield，服务端原样转发。
 * 单独拆出是因为服务端只负责转发这一类事件，其余事件由服务端自己产生。
 * `file` 承载工具生成的导出文件：客户端据此提供下载入口，文件内容本身不进对话流。
 * `source` 承载本轮真正注入上下文的引用对象：工具结束时增量推送，
 * 保证中途停止也不会丢掉已检索到的出处。
 * `sources` 是流末尾的终局清单：只保留正文实际标注过的文档，一处都没标注就是空清单；
 * 客户端据此覆盖此前累积的 `source`，检索到但没采用的文档不再显示。
 * `tool` 的 `detail` 是人类可读的阶段描述（如「检索知识库：人工智能」）：入参攒到能解析时
 * 才随 start 下发，客户端据此把「调用工具 x」换成人话；它不落库，历史回看时缺省并降级为工具名。
 * `thinking` 承载模型推理链的增量：仅在开启 thinking 的模型上出现，体积大且含模型噪声，
 * 因此不落库、不进历史、不计入上下文预算，客户端只把它当作可折叠的过程展示。
 */
export type AgentStreamEvent =
  | { type: 'token'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool'; name: string; status: 'start' | 'end'; detail?: string }
  | { type: 'file'; fileId: string; name: string; size: number }
  | { type: 'source'; citation: KnowledgeCitation }
  | { type: 'sources'; citations: KnowledgeCitation[] };

/**
 * 一轮对话可能推送的全部事件。
 * `conversation` 在首个 token / tool 之前补推：新建会话只有在本轮有产出时才会保留，
 * 客户端因此在同一时刻拿到会话 ID，不会记住一个随后会被回滚删除的会话。
 * `context` 承载本轮上下文治理的痕迹：服务端只在真的裁掉历史时才下发，
 * 让用户知道这轮回答并未看到完整历史（那段历史是被压成摘要还是被直接丢弃，由 `summarized` 区分）；
 * 它同样不落库，历史回看时不还原，客户端以「无此信息」的形态自然降级。
 * `error` 的 code 是机器可读分类（见 CHAT_ERROR_CODE），retryable 表示客户端是否值得重试。
 */
export type ChatStreamEvent =
  | AgentStreamEvent
  | { type: 'conversation'; conversationId: string }
  | { type: 'context'; trimmedMessages: number; summarized: boolean }
  | { type: 'done'; conversationId: string; title: string }
  | { type: 'error'; message: string; code?: ChatErrorCode; retryable?: boolean };

/**
 * 一帧对话流：事件本体 + 服务端分配的单调递增序号（从 1 开始）。
 * 序号是断点续传的定位锚：客户端重连时上报已消费到的最大序号，服务端据此只重放其后的帧，
 * 既不漏也不重。单独包一层而非给每个事件加字段，是因为序号属传输层——它由服务端按输出
 * 顺序分配、与事件语义无关，拼进事件里会让落库、日志等处凭空多出一个无意义的字段。
 */
export interface ChatStreamFrame {
  /** 单调递增序号，从 1 开始 */
  seq: number;
  event: ChatStreamEvent;
}
