import type { Pool, ResultSetHeader } from 'mysql2/promise';

/**
 * 保存滚动摘要并推进截断点，返回是否真正写入。
 * 条件更新保证单调：并发或重试下，旧摘要无法覆盖已推进到更晚位置的截断点。
 */
export async function saveConversationSummary(
  pool: Pool,
  userId: number,
  id: string,
  summary: string,
  uptoSeq: number,
): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE conversations SET summary = ?, summary_upto_seq = ?
      WHERE id = ? AND user_id = ?
        AND (summary_upto_seq IS NULL OR summary_upto_seq < ?)`,
    [summary, uptoSeq, id, userId, uptoSeq],
  );
  return result.affectedRows > 0;
}
