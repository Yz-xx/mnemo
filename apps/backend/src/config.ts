import path from 'node:path';
import process from 'node:process';

/** 对话模型提供方：本地 Ollama 或 OpenAI 兼容的线上服务（DeepSeek） */
export type LlmProvider = 'ollama' | 'deepseek';

/** 向量化提供方：DeepSeek 不提供 embedding 接口，故与对话模型独立配置 */
export type EmbeddingProvider = 'ollama' | 'openai';

export interface AppConfig {
  port: number;
  dataDir: string;
  llm: {
    provider: LlmProvider;
    temperature: number;
  };
  ollama: {
    baseUrl: string;
    chatModel: string;
    embeddingModel: string;
  };
  deepseek: {
    apiKey: string;
    baseUrl: string;
    chatModel: string;
  };
  embedding: {
    provider: EmbeddingProvider;
    apiKey: string;
    baseUrl: string;
    model: string;
  };
  knowledge: {
    chunkSize: number;
    chunkOverlap: number;
    topK: number;
  };
}

function toNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** 读取运行配置：全部来自环境变量（可用 .env 文件提供），保证部署时无需改代码 */
export function loadConfig(): AppConfig {
  return {
    port: toNumber(process.env.PORT, 3000),
    dataDir: process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data'),
    llm: {
      provider: process.env.LLM_PROVIDER === 'deepseek' ? 'deepseek' : 'ollama',
      temperature: toNumber(process.env.LLM_TEMPERATURE, 0.3),
    },
    ollama: {
      baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
      chatModel: process.env.OLLAMA_CHAT_MODEL ?? 'qwen2.5:7b',
      embeddingModel: process.env.OLLAMA_EMBEDDING_MODEL ?? 'nomic-embed-text',
    },
    deepseek: {
      apiKey: process.env.DEEPSEEK_API_KEY ?? '',
      baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
      chatModel: process.env.DEEPSEEK_CHAT_MODEL ?? 'deepseek-chat',
    },
    embedding: {
      provider: process.env.EMBEDDING_PROVIDER === 'openai' ? 'openai' : 'ollama',
      apiKey: process.env.EMBEDDING_API_KEY ?? '',
      baseUrl: process.env.EMBEDDING_BASE_URL ?? 'https://api.openai.com/v1',
      model: process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small',
    },
    knowledge: {
      chunkSize: toNumber(process.env.KNOWLEDGE_CHUNK_SIZE, 500),
      chunkOverlap: toNumber(process.env.KNOWLEDGE_CHUNK_OVERLAP, 80),
      topK: toNumber(process.env.KNOWLEDGE_TOP_K, 4),
    },
  };
}

/** 当前对话模型名称，用于健康检查与界面展示 */
export function describeChatModel(config: AppConfig): string {
  return config.llm.provider === 'deepseek' ? config.deepseek.chatModel : config.ollama.chatModel;
}
