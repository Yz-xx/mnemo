import { Router } from 'express';
import { SERVICE_NAME, describeChatModel } from '../config.js';
import type { AppConfig } from '../config.js';

/** 健康检查响应体：字段与 backend-design 第 3 章的约定一一对应 */
export interface HealthPayload {
  status: string;
  service: string;
  provider: string;
  model: string;
  knowledgeEnabled: boolean;
  timestamp: string;
}

/**
 * 组装健康检查响应：服务名与包名同源，改名时不会漏改此处。
 * @param now 时间源，便于测试断言时间戳格式
 */
export function describeHealth(config: AppConfig, now: Date = new Date()): HealthPayload {
  return {
    status: 'ok',
    service: SERVICE_NAME,
    provider: config.llm.provider,
    model: describeChatModel(config),
    knowledgeEnabled: true,
    timestamp: now.toISOString(),
  };
}

/** 健康检查：同时返回当前对话模型与知识库状态，供客户端展示 */
export function createHealthRouter(config: AppConfig): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(describeHealth(config));
  });

  return router;
}
