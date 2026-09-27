/**
 * 对话流协议：服务端推送的 SSE 事件结构。
 * 放在本包而非各端各写一份，是因为两端手抄的副本必然漂移
 * （桌面端曾多出一个服务端从不下发的 `detail` 字段），而漂移只在运行期
 * 以「客户端把不认识的字段当成了协议的一部分」的形式暴露。
 */

/**
 * 智能体自身产出的增量事件：由 LLM 层逐条 yield，服务端原样转发。
 * 单独拆出是因为服务端只负责转发这一类事件，其余事件由服务端自己产生。
 */
export type AgentStreamEvent =
  { type: 'token'; content: string } | { type: 'tool'; name: string; status: 'start' | 'end' };

/**
 * 一轮对话可能推送的全部事件。
 * `conversation` 在首个 token / tool 之前补推：新建会话只有在本轮有产出时才会保留，
 * 客户端因此在同一时刻拿到会话 ID，不会记住一个随后会被回滚删除的会话。
 */
export type ChatStreamEvent =
  | AgentStreamEvent
  | { type: 'conversation'; conversationId: string }
  | { type: 'done'; conversationId: string; title: string }
  | { type: 'error'; message: string };
