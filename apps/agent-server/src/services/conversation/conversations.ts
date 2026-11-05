import type { Conversation, ConversationSummary } from '../../entities/conversation.js';
import type { ConversationStore } from '../../mappers/conversation/conversations.js';
import { TITLE_MAX_LENGTH } from '../../mappers/conversation/mapper.js';

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

/**
 * 整理重命名入参：标题必填且限长，连续空白压成单空格（与自动标题同口径）。
 * 空标题不回落「新对话」——那是新会话的占位，用户主动清空应视为参数非法。
 */
export function parseConversationTitle(
  body: unknown,
): { ok: true; title: string } | { ok: false; message: string } {
  const raw = (body ?? {}) as { title?: unknown };
  const title = typeof raw.title === 'string' ? raw.title.replace(/\s+/g, ' ').trim() : '';
  if (!title) return { ok: false, message: '会话标题不能为空' };
  if (title.length > TITLE_MAX_LENGTH) {
    return { ok: false, message: `会话标题不能超过 ${TITLE_MAX_LENGTH} 个字符` };
  }
  return { ok: true, title };
}

/** 重命名该用户的会话；不属于该用户时返回 false（与删除同口径，统一按不存在处理） */
export function renameOwnConversation(
  store: Pick<ConversationStore, 'rename'>,
  userId: number,
  id: string,
  title: string,
): Promise<boolean> {
  return store.rename(userId, id, title);
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
