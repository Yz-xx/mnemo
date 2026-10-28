// 渲染进程与服务端共享的数据契约

export type MessageRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  /**
   * 模型推理链（thinking）：流式对话中由 SSE thinking 事件累积，仅作过程展示。
   * 服务端不落库，历史回看时该字段缺省，折叠面板整块不渲染。
   */
  thinking?: string;
  /**
   * 本轮上下文治理痕迹：服务端在真的裁掉历史时经 SSE context 事件下发，仅作过程展示。
   * 服务端不落库，历史回看时该字段缺省，提示整块不渲染。
   */
  context?: ChatContext;
  /**
   * 仅前端展示：本轮回复过程中触发的工具调用轨迹。
   * 流式对话中由 SSE tool 事件累积（带 running 状态）；
   * 切换历史会话时由服务端返回的 tools 字段还原为已完成状态。
   */
  steps?: ChatStep[];
  /**
   * 服务端持久化的工具调用轨迹：随助手回复一起落库，
   * 历史回看时由会话层转成 steps 渲染，标签才不会在切换后消失。
   */
  tools?: string[];
  /**
   * 用户提问附带的文件名：随提问一起落库，
   * 切换历史会话时从服务端返回，回看这条消息能看出回答基于哪些文件。
   * 流式对话中由前端在发送时本地填入，落库后以服务端值为准。
   */
  attachments?: string[];
  /**
   * 助手本轮实际采用的来源文档名：流式对话中先由 SSE source 事件累积「已注入上下文」的文档，
   * 流末尾再由 sources 事件按正文标注覆盖；随回复落库，回看时从服务端返回。
   * 正文一处都没标注时终局清单为空，检索到但没采用的文档不显示出处。
   */
  sources?: string[];
  /** 智能体本轮生成的导出文件，随 `file` 流事件下发，点击即可保存到本地 */
  files?: GeneratedFileInfo[];
}

/** 本轮上下文治理痕迹：仅在服务端真的裁掉历史时才有值 */
export interface ChatContext {
  /** 被挤出保留窗口、未注入模型的历史消息条数 */
  trimmedMessages: number;
  /** 本轮是否生成并落库了滚动摘要：为假表示那段历史被直接丢弃，未留摘要 */
  summarized: boolean;
}

/** 助手回复过程中的一次工具调用：执行中与已完成共用同一条记录 */
export interface ChatStep {
  /** 工具名，与后端 tool 事件的 name 一致 */
  name: string;
  /**
   * 人类可读的阶段描述（如「检索知识库：人工智能」）：后端在参数攒齐后随 start 事件下发。
   * 服务端不落库，历史回看时缺省，界面据此降级为只显示工具名。
   */
  detail?: string;
  /** 是否仍在执行：为真时标签渲染加载指示 */
  running: boolean;
}

/** 智能体生成的导出文件：只有引用信息，内容由客户端按需从后端取回 */
export interface GeneratedFileInfo {
  fileId: string;
  name: string;
  size: number;
}

/** 会话列表项（不含完整消息体，减少传输量） */
export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

export interface Conversation extends ConversationSummary {
  createdAt: string;
  messages: ChatMessage[];
}

/** 登录用户（服务端不会返回密码字段） */
export interface AuthUser {
  id: number;
  username: string;
}

/** 登录/注册成功后的会话信息：令牌用于后续请求鉴权 */
export interface AuthSession {
  token: string;
  user: AuthUser;
}

/** 知识库文档摘要 */
export interface KnowledgeDocument {
  id: string;
  title: string;
  chunks: number;
  createdAt: string;
}

/** 待发送的附件：选中后立即上传，拿到服务端 ID 才能在发送消息时引用 */
export interface ChatAttachment {
  /** 本地临时 ID：上传失败或未完成时服务端 ID 尚不存在，列表渲染与移除都靠它 */
  key: string;
  name: string;
  size: number;
  /** 服务端文件 ID；为空表示仍在上传中或上传已失败 */
  fileId?: string;
  /** 上传失败原因；为空表示一切正常 */
  error?: string;
}
