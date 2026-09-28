import type { ConversationStats } from './mapper.js';
import type { Pool, RowDataPacket } from 'mysql2/promise';

interface SummaryRow extends RowDataPacket {
  total: number;
  messages: number;
  messages_today: number;
}

interface DayCountRow extends RowDataPacket {
  day: string;
  count: number;
}

/** 当天零点：今日消息量与趋势起点都以本地零点为界，不按 24 小时滑动 */
function startOfToday(): Date {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

/** 本地日期字符串：用本地字段拼装而不走 toISOString，后者会按时区偏移到前一天 */
function formatDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 近 N 天（含起点当天）的日期序列：库里没有消息的日期补 0，折线图才不会断档 */
function dateRange(start: Date, days: number): string[] {
  return Array.from({ length: days }, (_unused, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return formatDate(date);
  });
}

/**
 * 总览统计：会话数、消息数与近 days 天的消息趋势。
 * 只做全库聚合、不按 user_id 过滤——管理后台看的是整体规模，不涉及具体用户内容。
 * 独立成模块：这是管理端唯一一处跨用户聚合，与 ConversationStore 按 user_id 隔离的读写不属于同一关注点。
 */
export async function readStats(pool: Pool, days: number): Promise<ConversationStats> {
  const since = startOfToday();
  since.setDate(since.getDate() - (days - 1));

  // 三个计数合成一条查询：总览每次刷新都会调用它，少两次往返
  const [summaryRows] = await pool.execute<SummaryRow[]>(
    `SELECT (SELECT COUNT(*) FROM conversations) AS total,
            (SELECT COUNT(*) FROM messages) AS messages,
            (SELECT COUNT(*) FROM messages WHERE created_at >= ?) AS messages_today`,
    [startOfToday()],
  );
  const [trendRows] = await pool.execute<DayCountRow[]>(
    // DATE_FORMAT 直接产出 YYYY-MM-DD 字符串；DATE() 返回 Date 对象，转字符串时会受时区影响跨天
    `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS day, COUNT(*) AS count
       FROM messages
      WHERE created_at >= ?
      GROUP BY day`,
    [since],
  );

  const counts = new Map(trendRows.map((row) => [row.day, Number(row.count)]));
  const row = summaryRows[0];
  return {
    total: Number(row?.total ?? 0),
    messages: Number(row?.messages ?? 0),
    messagesToday: Number(row?.messages_today ?? 0),
    trend: dateRange(since, days).map((date) => ({ date, count: counts.get(date) ?? 0 })),
  };
}
