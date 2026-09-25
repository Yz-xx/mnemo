import fs from 'node:fs';
import path from 'node:path';
import { AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { fakeModel } from '@langchain/core/testing';
import { createAgent } from 'langchain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTools } from '../llm/tools.js';
import { KnowledgeStore } from '../rag/store.js';
import { FakeEmbeddings, TEST_ROOT } from './fakeEmbeddings.js';

const OPTIONS = {
  chunkSize: 60,
  chunkOverlap: 0,
  topK: 4,
  minScore: 0.6,
  embeddingModel: 'fake-embedding',
  embeddingEndpoint: 'http://127.0.0.1:11434',
};

let dataDir: string;
let store: KnowledgeStore;

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(TEST_ROOT, 'tools-'));
  store = new KnowledgeStore(dataDir, new FakeEmbeddings(), OPTIONS);
  await store.add({
    title: '公共手册',
    content: '苹果和香蕉都是全局共享资料。',
    scope: 'global',
    userId: 1,
  });
  await store.add({
    title: '我的笔记',
    content: '香蕉是我的私有资料。',
    scope: 'private',
    userId: 1,
  });
});

afterEach(async () => {
  await store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** 组装只检索一次的智能体：把工具输出回显为最终回答，便于断言工具拿到的检索结果 */
function buildAgent() {
  const model = fakeModel()
    .respondWithTools([{ name: 'search_knowledge_base', args: { query: '香蕉' } }])
    .respond((messages: BaseMessage[]) => new AIMessage(String(messages.at(-1)?.content ?? '')));

  return createAgent({
    model,
    tools: createTools(store),
    systemPrompt: '测试用智能体',
    name: 'agent',
  });
}

describe('search_knowledge_base 工具', () => {
  it('检索结果按调用者身份过滤，不包含他人私有文档', async () => {
    const result = await buildAgent().invoke(
      { messages: [{ role: 'user', content: '香蕉在哪个文档里？' }] },
      { configurable: { userId: 2 } },
    );

    const reply = String(result.messages.at(-1)?.content ?? '');
    expect(reply).toContain('公共手册');
    expect(reply).not.toContain('我的笔记');
  });
});
