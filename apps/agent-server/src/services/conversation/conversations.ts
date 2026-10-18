import type { Conversation, ConversationSummary } from '../../entities/conversation.js';
import type { ConversationStore } from '../../mappers/conversation/conversations.js';

/** 会话读写：按用户与按 ID 两种删除口径并排，调用方不必自己记住用哪个 store 方法 */

/** 按最近更新时间倒序列出该用户的会话摘要 */
export function listOwnConversations(
  store: Pick<ConversationStore, 'list'>,
  userId: number,
): Promise<ConversationSummary[]> {
  return store.list(userId);
}

/** 读取单个会话及全部消息；不属于该用户时返回 null */
export function getOwnConversation(
  store: Pick<ConversationStore, 'get'>,
  userId: number,
  id: string,
): Promise<Conversation | null> {
  return store.get(userId, id);
}

/** 删除该用户的会话；消息由外键级联清理 */
export function removeOwnConversation(
  store: Pick<ConversationStore, 'remove'>,
  userId: number,
  id: string,
): Promise<boolean> {
  return store.remove(userId, id);
}

/** 删除任意会话（不限归属）：管理端清理用 */
export function removeConversationById(
  store: Pick<ConversationStore, 'removeById'>,
  id: string,
): Promise<boolean> {
  return store.removeById(id);
}
