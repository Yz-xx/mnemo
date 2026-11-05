import type { AppConfig, LlmProvider } from '../types.js';
import process from 'node:process';
import { toNumber, toRatio } from '../parsers.js';

/** 上下文治理的三个比例：保留比例要与触发比例比对，须在同一处算好 */
export interface ContextRatios {
  triggerRatio: number;
  keepRatio: number;
  toolRatio: number;
}

export function loadContextRatios(): ContextRatios {
  return {
    triggerRatio: toRatio(process.env.CONTEXT_TRIGGER_RATIO, 0.7),
    keepRatio: toRatio(process.env.CONTEXT_KEEP_RATIO, 0.4),
    toolRatio: toRatio(process.env.CONTEXT_TOOL_RATIO, 0.3),
  };
}

/** 对话模型与上下文窗口：窗口预算按提供方取，避免本地小窗口配出估大的预算 */
export function loadLlmConfig(
  provider: LlmProvider,
  { triggerRatio, keepRatio, toolRatio }: ContextRatios,
): AppConfig['llm'] {
  return {
    provider,
    temperature: toNumber(process.env.LLM_TEMPERATURE, 0.3),
    // 显式等于 true 才算开启：留空、拼错、写 1 都保持关闭，避免误开这条主链路变更
    thinking: process.env.LLM_THINKING === 'true',
    context: {
      // 线上 DeepSeek 为 64K；本地 Ollama 保守取 8K，
      // 该值需与 Ollama 的 num_ctx 对齐，配大了估出的窗口会比模型实际能吃下的宽
      windowTokens: toNumber(
        provider === 'deepseek'
          ? process.env.DEEPSEEK_CONTEXT_WINDOW_TOKENS
          : process.env.OLLAMA_CONTEXT_WINDOW_TOKENS,
        provider === 'deepseek' ? 65536 : 8192,
      ),
      triggerRatio,
      // 保留比例不得超过触发比例：否则触发后仍丢不掉任何一轮，等于没裁
      keepRatio: Math.min(keepRatio, triggerRatio),
      toolRatio,
    },
  };
}

export function loadOllamaConfig(): AppConfig['ollama'] {
  return {
    baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
    chatModel: process.env.OLLAMA_CHAT_MODEL ?? 'qwen3',
    embeddingModel: process.env.OLLAMA_EMBEDDING_MODEL ?? 'nomic-embed-text',
    // 默认指向本机已装的视觉模型；置空字符串即关闭图片理解
    visionModel: process.env.OLLAMA_VISION_MODEL ?? 'qwen3-vl:8b',
  };
}

export function loadDeepseekConfig(): AppConfig['deepseek'] {
  return {
    apiKey: process.env.DEEPSEEK_API_KEY ?? '',
    baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    chatModel: process.env.DEEPSEEK_CHAT_MODEL ?? 'deepseek-chat',
  };
}

/** 向量化提供方与对话模型独立：DeepSeek 不提供 embedding 接口 */
export function loadEmbeddingConfig(): AppConfig['embedding'] {
  return {
    provider: process.env.EMBEDDING_PROVIDER === 'openai' ? 'openai' : 'ollama',
    apiKey: process.env.EMBEDDING_API_KEY ?? '',
    baseUrl: process.env.EMBEDDING_BASE_URL ?? 'https://api.openai.com/v1',
    model: process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small',
  };
}

export function loadKnowledgeConfig(): AppConfig['knowledge'] {
  return {
    chunkSize: toNumber(process.env.KNOWLEDGE_CHUNK_SIZE, 500),
    chunkOverlap: toNumber(process.env.KNOWLEDGE_CHUNK_OVERLAP, 80),
    topK: toNumber(process.env.KNOWLEDGE_TOP_K, 4),
    minScore: toNumber(process.env.KNOWLEDGE_MIN_SCORE, 0.6),
    adminToken: process.env.KNOWLEDGE_ADMIN_TOKEN ?? '',
  };
}
