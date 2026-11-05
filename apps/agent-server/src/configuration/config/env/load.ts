import type { AppConfig, LlmProvider } from './types.js';
import path from 'node:path';
import process from 'node:process';
import { toNumber } from './parsers.js';
import {
  loadContextRatios,
  loadDeepseekConfig,
  loadEmbeddingConfig,
  loadKnowledgeConfig,
  loadLlmConfig,
  loadOllamaConfig,
} from './sections/ai.js';
import { loadConcurrencyConfig } from './sections/concurrency.js';
import {
  loadApiLogConfig,
  loadAuthConfig,
  loadHttpConfig,
  loadLogConfig,
  loadObservabilityConfig,
  loadPostgresConfig,
} from './sections/runtime.js';
import { loadInitialAdminConfig, loadUploadConfig } from './sections/storage.js';

/** 对话模型提供方：只认 deepseek，其余一律按本地 Ollama 处理 */
function readProvider(): LlmProvider {
  return process.env.LLM_PROVIDER === 'deepseek' ? 'deepseek' : 'ollama';
}

/**
 * 读取运行配置：全部来自环境变量（可用 .env 文件提供），保证部署时无需改代码。
 * 各配置段按关注点拆在 sections/ 下，本函数只负责取共用基准（数据目录、提供方、上下文比例）再组装，
 * 避免一段改配把整块结构读成上百行。
 */
export function loadConfig(): AppConfig {
  // 数据目录先解析出来，供知识库、日志与上传目录共用同一基准
  const dataDir = process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data');
  // 提供方先解析出来：上下文窗口预算与模型闸门水位都按它区分
  const provider = readProvider();
  const ratios = loadContextRatios();

  return {
    port: toNumber(process.env.PORT, 3000),
    dataDir,
    log: loadLogConfig(dataDir),
    postgres: loadPostgresConfig(),
    http: loadHttpConfig(),
    concurrency: loadConcurrencyConfig(provider),
    apiLog: loadApiLogConfig(),
    auth: loadAuthConfig(),
    observability: loadObservabilityConfig(),
    llm: loadLlmConfig(provider, ratios),
    ollama: loadOllamaConfig(),
    deepseek: loadDeepseekConfig(),
    embedding: loadEmbeddingConfig(),
    knowledge: loadKnowledgeConfig(),
    upload: loadUploadConfig(dataDir),
    initialAdmin: loadInitialAdminConfig(),
  };
}
