import type { AppDependencies } from '../../configuration/dependencies.js';
import type { KnowledgeActor } from '../../entities/knowledge.js';
import type { Request, Response } from 'express';
import { currentUserId } from '../../middleware/auth.js';

/** 知识库路由用到的依赖：只取实际需要的几项，便于单独编排与测试 */
export type KnowledgeDependencies = Pick<
  AppDependencies,
  'knowledge' | 'knowledgeBases' | 'knowledgeIngest' | 'config'
>;

/** 管理令牌是否放行：未配置即视为不开放全局写入（沿现状，global 库仅管理令牌维护） */
export function isAdminRequest(config: AppDependencies['config'], req: Request): boolean {
  const adminToken = config.knowledge.adminToken;
  return adminToken !== '' && req.get('x-admin-token') === adminToken;
}

/** Express 5 的 params 值类型为 string | string[]，路径参数实际只有单值，统一在此收窄 */
export function readParam(req: Request, key: string): string {
  return typeof req.params[key] === 'string' ? (req.params[key] as string) : '';
}

/** 操作者身份：普通用户按库归属判定，管理令牌可跨库维护 */
export function actorOf(config: AppDependencies['config'], res: Response): KnowledgeActor {
  // 管理令牌读请求头：Response 上挂着对应的 req，调用处不必再多传一个参数
  return { userId: currentUserId(res), isAdmin: isAdminRequest(config, res.req) };
}
