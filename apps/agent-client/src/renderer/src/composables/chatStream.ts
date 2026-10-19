// 聊天流的协议层：把带序号的 SSE 帧合并进助手消息。
// 不持有任何响应式状态、不感知会话层的字段，只吃流与消息、把副作用经回调交回调用方。
import type { ChatStreamFrame } from '../api/client';
import type { ChatMessage } from '../types';

/** 新建一条消息：id 与时间戳在此生成 */
export function createMessage(
  role: ChatMessage['role'],
  content: string,
  attachments?: string[],
): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString(),
    // 无附件的消息不落该字段，省得每条消息都挂一个恒空的属性
    ...(attachments?.length ? { attachments } : {}),
  };
}

/** 消费流式帧时需要回传给会话层的副作用 */
interface ChatStreamHandlers {
  /** 每消费一帧回报其序号：断线重连时据此上报断点，服务端只重放之后的帧 */
  onSeq: (seq: number) => void;
  /** 本轮开始有产出，后端确认该会话会被保留，携带会话 ID */
  onConversation: (conversationId: string) => void;
  /** 本轮结束，携带后端确认的会话 ID */
  onDone: (conversationId: string) => Promise<void>;
  /** 后端返回的可读错误信息 */
  onError: (message: string) => void;
}

/**
 * 逐帧消费 SSE 帧并合并进助手消息：token 累加正文，tool 追加为执行轨迹；
 * 会话级副作用（记住会话 ID、切换会话、报错提示）通过回调交回调用方，保持此处逻辑纯粹。
 * 帧序号经 onSeq 回报调用方，续传时才接得上——这是「已消费到哪」的唯一来源。
 */
export async function consumeChatStream(
  stream: AsyncIterable<ChatStreamFrame>,
  message: ChatMessage,
  handlers: ChatStreamHandlers,
): Promise<void> {
  for await (const frame of stream) {
    handlers.onSeq(frame.seq);
    const event = frame.event;
    if (event.type === 'token') {
      message.content += event.content;
    } else if (event.type === 'thinking') {
      // 推理链增量累加到消息上：只作过程展示，不落库、也不进正文
      message.thinking = (message.thinking ?? '') + event.content;
    } else if (event.type === 'tool') {
      const steps = message.steps ?? [];
      if (event.status === 'start') {
        // 先落一条进行中的标签：读文件这类慢工具要立刻给出可见反馈。
        // detail 是后端攒齐参数后下发的阶段描述；缺省时（历史回看）界面退回只显示工具名
        message.steps = [
          ...steps,
          { name: event.name, running: true, ...(event.detail ? { detail: event.detail } : {}) },
        ];
      } else {
        // 执行结束，把进行中的标签就地定格；后端对同名工具的 start 只推一次，
        // 配不上时补一条已完成记录，这次调用才不会从前端凭空消失
        const index = steps.findIndex((step) => step.running && step.name === event.name);
        message.steps =
          index === -1
            ? [...steps, { name: event.name, running: false }]
            : steps.map((step, i) => (i === index ? { ...step, running: false } : step));
      }
    } else if (event.type === 'file') {
      // 生成的文件挂在助手消息上：客户端据此渲染下载入口，文件本体不随流传输
      message.files = [
        ...(message.files ?? []),
        { fileId: event.fileId, name: event.name, size: event.size },
      ];
    } else if (event.type === 'source') {
      // 检索来源挂在助手消息上：同一份文档被多次命中时只留一个标签
      const sources = message.sources ?? [];
      if (!sources.includes(event.name)) message.sources = [...sources, event.name];
    } else if (event.type === 'context') {
      // 治理痕迹挂在消息上：界面据此提示「这轮回答没看到完整历史」，
      // 与 thinking 一样只作过程展示，不落库、不进正文
      message.context = {
        trimmedMessages: event.trimmedMessages,
        summarized: event.summarized,
      };
    } else if (event.type === 'conversation') {
      handlers.onConversation(event.conversationId);
    } else if (event.type === 'done') {
      await handlers.onDone(event.conversationId);
    } else {
      // 联合类型已把其余分支排除，走到这里只剩 error
      handlers.onError(event.message);
    }
  }
}
