import type { ConversationStore } from '../../mappers/conversation/conversations.js';
import type { UserStore } from '../../mappers/user/store.js';
import type { KnowledgeStore } from '../knowledge/index.js';

/** 管理端总览统计：用户规模、会话与消息量、近 N 天消息趋势、知识库文档数 */

export interface AdminOverviewDeps {
  users: Pick<UserStore, 'stats'>;
  conversations: Pick<ConversationStore, 'stats'>;
  knowledge: Pick<KnowledgeStore, 'count'>;
}

/** 总览响应：规模统计与生成时刻，供前端一次性渲染 */
export interface AdminOverviewStats {
  users: Awaited<ReturnType<AdminOverviewDeps['users']['stats']>>;
  conversations: {
    total: number;
    messages: number;
    messagesToday: number;
  };
  messageTrend: Awaited<ReturnType<AdminOverviewDeps['conversations']['stats']>>['trend'];
  knowledge: { documents: number };
  generatedAt: string;
}

/** 三处计数互不依赖，一次并发取回，避免总览串行等三趟 */
export async function readOverviewStats(
  deps: AdminOverviewDeps,
  trendDays: number,
): Promise<AdminOverviewStats> {
  const [userStats, conversationStats, documents] = await Promise.all([
    deps.users.stats(),
    deps.conversations.stats(trendDays),
    deps.knowledge.count(),
  ]);
  return {
    users: userStats,
    conversations: {
      total: conversationStats.total,
      messages: conversationStats.messages,
      messagesToday: conversationStats.messagesToday,
    },
    messageTrend: conversationStats.trend,
    knowledge: { documents },
    generatedAt: new Date().toISOString(),
  };
}
