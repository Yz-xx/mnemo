import type { DbPool } from '../../infrastructure/db/pool.js';
import { isUuid } from '../../utils/uuid.js';

/**
 * 保存滚动摘要并推进截断点，返回是否真正写入。
 * 条件更新保证单调：并发或重试下，旧摘要无法覆盖已推进到更晚位置的截断点。
 */
export async function saveConversationSummary(
  pool: DbPool,
  userId: number,
  id: string,
  summary: string,
  uptoSeq: number,
): Promise<boolean> {
  // 非法 ID 不可能命中记录，直接判为未写入，也避免 uuid 列比较时抛类型错误
  if (!isUuid(id)) return false;
  const { rowCount } = await pool.query(
    `UPDATE conversations SET summary = $1, summary_upto_seq = $2
      WHERE id = $3 AND user_id = $4
        AND (summary_upto_seq IS NULL OR summary_upto_seq < $5)`,
    [summary, uptoSeq, id, userId, uptoSeq],
  );
  return (rowCount ?? 0) > 0;
}
