import express from 'express';
import type { Express } from 'express';
import type { AppDependencies } from './dependencies.js';
import { allowCors } from './middleware/cors.js';
import { errorHandler } from './middleware/errorHandler.js';
import { registerRoutes } from './routes/index.js';

/**
 * 组装 Express 应用，仅保留三段式骨架：通用中间件 → 注册路由 → 错误兜底。
 * 具体接口与依赖装配分别见 routes/index.ts 与 index.ts，便于后续接入 supertest 做接口测试。
 */
export function createApp(deps: AppDependencies): Express {
  const app = express();

  app.use(allowCors);
  app.use(express.json({ limit: '2mb' }));
  registerRoutes(app, deps);
  app.use(errorHandler);

  return app;
}
