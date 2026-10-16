import type { AppDependencies } from '../../configuration/dependencies.js';
import type { Request, Response } from 'express';
import process from 'node:process';
import { Router } from 'express';
import { describeHealth } from '../../services/health.js';

/** 总览趋势的天数：与前端折线图默认区间一致 */
const TREND_DAYS = 7;

/**
 * 管理端总览：整体规模统计与运行状态，均为只读。
 * 挂在 /api/admin（末位登记，避免前缀匹配到其余管理端模块）。
 */
export function createAdminOverviewRouter({
  users,
  conversations,
  knowledge,
  config,
}: Pick<AppDependencies, 'users' | 'conversations' | 'knowledge' | 'config'>): Router {
  const router = Router();

  /** 总览：用户规模、会话与消息量、近 7 天消息趋势、知识库文档数 */
  router.get('/stats', async (_req: Request, res: Response) => {
    const [userStats, conversationStats, documents] = await Promise.all([
      users.stats(),
      conversations.stats(TREND_DAYS),
      knowledge.count(),
    ]);
    res.json({
      users: userStats,
      conversations: {
        total: conversationStats.total,
        messages: conversationStats.messages,
        messagesToday: conversationStats.messagesToday,
      },
      messageTrend: conversationStats.trend,
      knowledge: { documents },
      generatedAt: new Date().toISOString(),
    });
  });

  /** 运行状态：健康检查六项 + 运行时长与数据库目标，供后台顶栏展示 */
  router.get('/health', (_req: Request, res: Response) => {
    res.json({
      ...describeHealth(config),
      uptimeSeconds: Math.floor(process.uptime()),
      postgres: `${config.postgres.host}:${config.postgres.port}/${config.postgres.database}`,
    });
  });

  return router;
}
