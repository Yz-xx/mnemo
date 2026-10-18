import type { AppConfig } from '../../configuration/config/index.js';
import { describeChatModel, SERVICE_NAME } from '../../configuration/config/index.js';

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
 * 放服务层而非路由层：管理端的 /api/admin/health 复用同一份，
 * 路由之间不得互相 import（backend-design 第 1 章的依赖方向）。
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
