import type { AppConfig } from '../configuration/config/index.js';
import type { Embeddings } from '@langchain/core/embeddings';
import { ChatOllama, OllamaEmbeddings } from '@langchain/ollama';
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';

/** 对话模型工厂：通过 LLM_PROVIDER 在本地 Ollama 与线上 DeepSeek 之间切换 */
export function createChatModel(config: AppConfig): ChatOllama | ChatOpenAI {
  if (config.llm.provider === 'deepseek') {
    return new ChatOpenAI({
      model: config.deepseek.chatModel,
      apiKey: config.deepseek.apiKey,
      temperature: config.llm.temperature,
      // DeepSeek 兼容 OpenAI 协议，仅需替换 baseURL
      configuration: { baseURL: config.deepseek.baseUrl },
    });
  }
  return new ChatOllama({
    model: config.ollama.chatModel,
    baseUrl: config.ollama.baseUrl,
    temperature: config.llm.temperature,
  });
}

/** 向量化模型工厂：DeepSeek 不提供 embedding 接口，故独立配置 */
export function createEmbeddings(config: AppConfig): Embeddings {
  if (config.embedding.provider === 'openai') {
    return new OpenAIEmbeddings({
      model: config.embedding.model,
      apiKey: config.embedding.apiKey,
      configuration: { baseURL: config.embedding.baseUrl },
    });
  }
  return new OllamaEmbeddings({
    model: config.ollama.embeddingModel,
    baseUrl: config.ollama.baseUrl,
  });
}
