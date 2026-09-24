import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { truncate } from '@repo/shared';
import type { Conversation, ConversationSummary, MessageRole, StoredMessage } from './types.js';

/** UUID 格式校验：会话 ID 同时用作文件名，需防止路径穿越 */
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TITLE_MAX_LENGTH = 24;

export function createStoredMessage(role: MessageRole, content: string): StoredMessage {
  return { id: randomUUID(), role, content, createdAt: new Date().toISOString() };
}

/** 复用公共库的截断能力，把首条用户消息转为会话标题 */
function buildTitle(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  return normalized ? truncate(normalized, TITLE_MAX_LENGTH) : '新对话';
}

/** 会话持久化：一个会话对应 data/conversations 下的一个 JSON 文件 */
export class ConversationStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'conversations');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private filePath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private persist(conversation: Conversation): void {
    fs.writeFileSync(
      this.filePath(conversation.id),
      JSON.stringify(conversation, null, 2),
      'utf-8',
    );
  }

  /** 按最近更新时间倒序列出全部会话摘要 */
  list(): ConversationSummary[] {
    return fs
      .readdirSync(this.dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => this.get(name.replace(/\.json$/, '')))
      .filter((item): item is Conversation => item !== null)
      .map((item) => ({
        id: item.id,
        title: item.title,
        updatedAt: item.updatedAt,
        messageCount: item.messages.length,
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): Conversation | null {
    if (!ID_PATTERN.test(id)) return null;
    try {
      const raw = fs.readFileSync(this.filePath(id), 'utf-8');
      return JSON.parse(raw) as Conversation;
    } catch {
      return null;
    }
  }

  create(): Conversation {
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id: randomUUID(),
      title: '新对话',
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.persist(conversation);
    return conversation;
  }

  /** 追加一条消息；未指定或找不到会话时自动新建 */
  append(id: string | undefined, role: MessageRole, content: string): Conversation {
    const conversation = (id ? this.get(id) : null) ?? this.create();
    conversation.messages.push(createStoredMessage(role, content));
    conversation.updatedAt = new Date().toISOString();
    // 首条用户消息用于生成会话标题
    if (conversation.title === '新对话' && role === 'user') {
      conversation.title = buildTitle(content);
    }
    this.persist(conversation);
    return conversation;
  }

  remove(id: string): boolean {
    if (!this.get(id)) return false;
    fs.rmSync(this.filePath(id));
    return true;
  }
}
