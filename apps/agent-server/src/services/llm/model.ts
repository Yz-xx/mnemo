import type { AppConfig } from '../../configuration/config/index.js';
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
    // 始终显式透传 think：Ollama 对 thinking 模型（如 qwen3）省略该参数等同于开启，
    // 只在打开时传会让「默认关闭」形同虚设——实测不传 think 仍会返回推理内容；
    // 显式传 false 对非 thinking 模型（如 qwen2.5:7b）安全，不会报错
    think: config.llm.thinking,
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
