import type { ConversationStats } from '../../entities/conversation.js';
import type { DbPool } from '../../infrastructure/db/pool.js';
import type { QueryResultRow } from 'pg';
import { formatDate } from '@repo/shared';

/** 业务时区：趋势按本地日切分，与 get_current_time 工具保持同一口径 */
const BUSINESS_TIME_ZONE = 'Asia/Shanghai';

interface SummaryRow extends QueryResultRow {
  total: number;
  messages: number;
  messages_today: number;
}

interface DayCountRow extends QueryResultRow {
  day: string;
  count: number;
}

/** 当天零点：今日消息量与趋势起点都以本地零点为界，不按 24 小时滑动 */
function startOfToday(): Date {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
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
export async function readStats(pool: DbPool, days: number): Promise<ConversationStats> {
  const since = startOfToday();
  since.setDate(since.getDate() - (days - 1));

  // 三个计数合成一条查询：总览每次刷新都会调用它，少两次往返
  const { rows: summaryRows } = await pool.query<SummaryRow>(
    `SELECT (SELECT COUNT(*) FROM conversations) AS total,
            (SELECT COUNT(*) FROM messages) AS messages,
            (SELECT COUNT(*) FROM messages WHERE created_at >= $1) AS messages_today`,
    [startOfToday()],
  );
  // timestamptz 先按业务时区落成墙上时间再取日期：直接 to_char 会跟随库的会话时区，
  // 一旦会话时区与业务时区不同，日期就会跨天而与 dateRange 产出的键对不上
  const { rows: trendRows } = await pool.query<DayCountRow>(
    `SELECT to_char(created_at AT TIME ZONE '${BUSINESS_TIME_ZONE}', 'YYYY-MM-DD') AS day,
            COUNT(*) AS count
       FROM messages
      WHERE created_at >= $1
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
