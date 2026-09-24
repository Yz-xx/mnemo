import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Embeddings } from '@langchain/core/embeddings';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';

export interface KnowledgeDocument {
  id: string;
  title: string;
  chunks: number;
  createdAt: string;
}

export interface KnowledgeSearchResult {
  title: string;
  content: string;
  score: number;
}

interface KnowledgeChunk {
  id: string;
  documentId: string;
  title: string;
  content: string;
  vector: number[];
}

interface KnowledgeState {
  documents: KnowledgeDocument[];
  chunks: KnowledgeChunk[];
}

/** 余弦相似度，用于在无外部向量库时完成内存级检索 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA > 0 && normB > 0 ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
}

/**
 * 轻量知识库：文档切分后向量化并落盘为 JSON，
 * 检索时在内存中按余弦相似度排序，避免引入外部向量数据库
 */
export class KnowledgeStore {
  private readonly file: string;
  private state: KnowledgeState;

  constructor(
    dataDir: string,
    private readonly embeddings: Embeddings,
    private readonly options: { chunkSize: number; chunkOverlap: number; topK: number },
  ) {
    this.file = path.join(dataDir, 'knowledge', 'store.json');
    this.state = this.load();
  }

  private load(): KnowledgeState {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf-8')) as KnowledgeState;
    } catch {
      return { documents: [], chunks: [] };
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.state), 'utf-8');
  }

  list(): KnowledgeDocument[] {
    return [...this.state.documents];
  }

  /** 写入文档：切分 → 批量向量化 → 持久化 */
  async add(input: { title: string; content: string }): Promise<KnowledgeDocument> {
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: this.options.chunkSize,
      chunkOverlap: this.options.chunkOverlap,
    });
    const pieces = await splitter.splitText(input.content);
    const vectors = await this.embeddings.embedDocuments(pieces);

    const document: KnowledgeDocument = {
      id: randomUUID(),
      title: input.title,
      chunks: pieces.length,
      createdAt: new Date().toISOString(),
    };

    this.state.documents.push(document);
    pieces.forEach((content, index) => {
      this.state.chunks.push({
        id: randomUUID(),
        documentId: document.id,
        title: document.title,
        content,
        vector: vectors[index] ?? [],
      });
    });
    this.persist();
    return document;
  }

  remove(id: string): boolean {
    if (!this.state.documents.some((item) => item.id === id)) return false;
    this.state.documents = this.state.documents.filter((item) => item.id !== id);
    this.state.chunks = this.state.chunks.filter((item) => item.documentId !== id);
    this.persist();
    return true;
  }

  async search(query: string, topK = this.options.topK): Promise<KnowledgeSearchResult[]> {
    if (this.state.chunks.length === 0) return [];
    const queryVector = await this.embeddings.embedQuery(query);
    return this.state.chunks
      .map((chunk) => ({
        title: chunk.title,
        content: chunk.content,
        score: cosineSimilarity(queryVector, chunk.vector),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}
