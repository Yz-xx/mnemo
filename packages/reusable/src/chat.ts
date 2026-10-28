/**
 * 对话流协议：服务端推送的 SSE 事件结构。
 * 放在本包而非各端各写一份，是因为两端手抄的副本必然漂移
 * （桌面端曾多出一个服务端从不下发的 `detail` 字段），而漂移只在运行期
 * 以「客户端把不认识的字段当成了协议的一部分」的形式暴露。
 */

/**
 * 智能体自身产出的增量事件：由 LLM 层逐条 yield，服务端原样转发。
 * 单独拆出是因为服务端只负责转发这一类事件，其余事件由服务端自己产生。
 * `file` 承载工具生成的导出文件：客户端据此提供下载入口，文件内容本身不进对话流。
 * `source` 承载本轮真正注入上下文的文档名：服务端从检索结果里直接取，
 * 工具结束时增量推送，保证中途停止也不会丢掉已检索到的出处。
 * `sources` 是流末尾的终局清单：只保留正文实际标注过的文档，一处都没标注就是空清单；
 * 客户端据此覆盖此前累积的 `source` 标签，检索到但没采用的文档不再显示。
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
  | { type: 'source'; name: string }
  | { type: 'sources'; names: string[] };

/**
 * 一轮对话可能推送的全部事件。
 * `conversation` 在首个 token / tool 之前补推：新建会话只有在本轮有产出时才会保留，
 * 客户端因此在同一时刻拿到会话 ID，不会记住一个随后会被回滚删除的会话。
 * `context` 承载本轮上下文治理的痕迹：服务端只在真的裁掉历史时才下发，
 * 让用户知道这轮回答并未看到完整历史（那段历史是被压成摘要还是被直接丢弃，由 `summarized` 区分）；
 * 它同样不落库，历史回看时不还原，客户端以「无此信息」的形态自然降级。
 */
export type ChatStreamEvent =
  | AgentStreamEvent
  | { type: 'conversation'; conversationId: string }
  | { type: 'context'; trimmedMessages: number; summarized: boolean }
  | { type: 'done'; conversationId: string; title: string }
  | { type: 'error'; message: string };

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
