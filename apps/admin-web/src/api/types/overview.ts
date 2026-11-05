import type { UserStats } from './users.js';

/** 消息趋势的一个数据点：date 为 YYYY-MM-DD */
export interface MessageTrendPoint {
  date: string;
  count: number;
}

/** 总览统计：用户规模、会话与消息量、近 7 天趋势、知识库文档数 */
export interface AdminStats {
  users: UserStats;
  conversations: {
    total: number;
    messages: number;
    messagesToday: number;
  };
  messageTrend: MessageTrendPoint[];
  knowledge: { documents: number };
  generatedAt: string;
}

/** 运行状态：健康检查六项 + 运行时长与数据库目标 */
export interface AdminHealth {
  status: string;
  service: string;
  provider: string;
  model: string;
  knowledgeEnabled: boolean;
  timestamp: string;
  uptimeSeconds: number;
  postgres: string;
}
