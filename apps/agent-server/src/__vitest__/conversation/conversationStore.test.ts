import type { ConversationHeader } from '../../entities/conversation.js';
import type { DbPool } from '../../infrastructure/db/pool.js';
import { describe, expect, it } from 'vitest';
import { ConversationStore } from '../../mappers/conversation/conversations.js';

/** 合法 UUID 形态的会话 ID：会话 ID 列是 uuid，非法取值会在 Store 入口被拦下，读不到会话头 */
const CID = '22222222-2222-4222-8222-222222222222';

/** 记录执行过的 SQL，用来断言轻量追加路径的回读次数与回读内容 */
function recordingPool() {
  const sqls: string[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      sqls.push(sql);
      // 追加消息改走 RETURNING seq：PG 没有 insertId，自增列随插入一并取回
      if (sql.startsWith('INSERT INTO messages')) return { rows: [{ seq: 1 }], rowCount: 1 };
      // readHeader 只取会话头四列，命中该分支时给一条可用行即可
      if (sql.startsWith('SELECT')) {
        const now = new Date('2026-01-01T00:00:00.000Z');
        return {
          rows: [{ id: params[0], title: '旧标题', created_at: now, updated_at: now }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    },
  } as unknown as DbPool;
  return { pool, sqls };
}

/** 路由层已读入的会话头：透传给 append 即跳过回读 */
const HEADER: ConversationHeader = {
  id: CID,
  title: '旧标题',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('ConversationStore 轻量追加', () => {
  it('未传会话头时只读会话头，不回读 messages 表', async () => {
    const { pool, sqls } = recordingPool();
    const store = new ConversationStore(pool);

    const result = await store.append(1, CID, 'user', '你好');

    // 单轮成本不随历史长度增长：只查会话头用于判断归属与标题（见 docs/adr/0010 决策 13）
    const selects = sqls.filter((sql) => sql.startsWith('SELECT'));
    expect(selects).toHaveLength(1);
    expect(selects[0]).toContain('FROM conversations');
    // 会话头路径不读摘要列，证明它没有退化成全量 get
    expect(selects[0]).not.toContain('summary');
    expect(sqls.some((sql) => sql.includes('FROM messages'))).toBe(false);
    expect(result.conversation.id).toBe(CID);
    expect(result.message.content).toBe('你好');
  });

  it('传了已读入的会话头时零查询，追加不再回读', async () => {
    const { pool, sqls } = recordingPool();
    const store = new ConversationStore(pool);

    await store.append(1, CID, 'assistant', '回复', {}, HEADER);

    // 路由已读入历史并透传会话头，助手消息落库无需任何回读
    expect(sqls.some((sql) => sql.startsWith('SELECT'))).toBe(false);
    expect(sqls.some((sql) => sql.startsWith('INSERT INTO messages'))).toBe(true);
  });
});
