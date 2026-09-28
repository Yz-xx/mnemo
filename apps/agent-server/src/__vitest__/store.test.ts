import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KnowledgeStore } from '../rag/index.js';
import { FakeEmbeddings, OfflineEmbeddings, TEST_ROOT } from './fakeEmbeddings.js';

const OPTIONS = {
  chunkSize: 60,
  chunkOverlap: 0,
  topK: 2,
  minScore: 0.6,
  embeddingModel: 'fake-embedding',
  embeddingEndpoint: 'http://127.0.0.1:11434',
};

let dataDir: string;
let store: KnowledgeStore;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(TEST_ROOT, 'knowledge-'));
  store = new KnowledgeStore(dataDir, new FakeEmbeddings(), OPTIONS);
});

afterEach(async () => {
  await store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('KnowledgeStore', () => {
  it('空白知识库检索结果为空', async () => {
    await expect(store.search('苹果', { userId: 1 })).resolves.toEqual([]);
    await expect(store.list(1)).resolves.toEqual([]);
  });

  it('低于相似度下限的片段不作为命中返回', async () => {
    await store.add({
      title: '水果手册',
      content: '苹果是一种常见水果。',
      scope: 'global',
      userId: 1,
    });

    // 橘子与苹果的向量正交、相似度为 0，应被下限过滤掉
    await expect(store.search('橘子', { userId: 1 })).resolves.toEqual([]);
  });

  it('文档入库后按片段计数并可按内容检索', async () => {
    const document = await store.add({
      title: '水果手册',
      content: '苹果是一种常见水果。',
      scope: 'global',
      userId: 1,
    });

    expect(document.chunks).toBeGreaterThan(0);
    await expect(store.list(1)).resolves.toEqual([document]);

    const [top] = await store.search('苹果', { userId: 1 });
    expect(top.title).toBe('水果手册');
    expect(top.content).toContain('苹果');
  });

  it('私有文档只对上传者可见，全局文档对所有人生效', async () => {
    const shared = await store.add({
      title: '公共手册',
      content: '苹果和香蕉都是全局共享资料。',
      scope: 'global',
      userId: 1,
    });
    const mine = await store.add({
      title: '我的笔记',
      content: '香蕉是我的私有资料。',
      scope: 'private',
      userId: 1,
    });

    // 上传者自己能看到全部，其他用户只看得到全局文档
    const ownTitles = (await store.list(1)).map((item) => item.title);
    expect(ownTitles).toHaveLength(2);
    expect(ownTitles).toEqual(expect.arrayContaining(['公共手册', '我的笔记']));

    const otherTitles = (await store.list(2)).map((item) => item.title);
    expect(otherTitles).toEqual(['公共手册']);

    // 检索同样按可见性隔离：他人只能命中全局文档，命中的私有文档仅有归属者可见
    const otherHits = await store.search('香蕉', { userId: 2 });
    expect(otherHits.map((item) => item.title)).toEqual([shared.title]);

    const [ownHit] = await store.search('香蕉', { userId: 1 });
    expect(ownHit.title).toBe(mine.title);

    const [otherHit] = await store.search('苹果', { userId: 2 });
    expect(otherHit.title).toBe(shared.title);
  });

  it('删除文档会同时清除其向量片段', async () => {
    const document = await store.add({
      title: '水果手册',
      content: '香蕉是一种常见水果。',
      scope: 'private',
      userId: 1,
    });

    // 非归属者按“不存在”处理，避免泄漏其他用户文档的存在性
    await expect(store.remove(document.id, { userId: 2, isAdmin: false })).resolves.toBe(false);
    await expect(store.remove(document.id, { userId: 1, isAdmin: false })).resolves.toBe(true);

    await expect(store.list(1)).resolves.toEqual([]);
    await expect(store.search('香蕉', { userId: 1 })).resolves.toEqual([]);
  });

  it('全局文档仅管理员可删除', async () => {
    const document = await store.add({
      title: '公共手册',
      content: '苹果是全公司共享资料。',
      scope: 'global',
      userId: 1,
    });

    await expect(store.remove(document.id, { userId: 1, isAdmin: false })).resolves.toBe(false);
    await expect(store.remove(document.id, { userId: 2, isAdmin: true })).resolves.toBe(true);
  });

  it('管理端列表不过滤可见性，私有文档带归属信息一并返回', async () => {
    await store.add({
      title: '公共手册',
      content: '苹果是全公司共享资料。',
      scope: 'global',
      userId: 1,
    });
    const mine = await store.add({
      title: '我的笔记',
      content: '香蕉是我的私有资料。',
      scope: 'private',
      userId: 1,
    });
    const other = await store.add({
      title: '他人笔记',
      content: '橘子是别人的私有资料。',
      scope: 'private',
      userId: 2,
    });

    // 用户 2 的可见列表看不到用户 1 的私有文档，管理端列表则全部可见
    expect((await store.list(2)).map((item) => item.id)).not.toContain(mine.id);
    const all = await store.listAll();
    expect(all.map((item) => item.id)).toEqual(expect.arrayContaining([mine.id, other.id]));
    expect(all.find((item) => item.id === mine.id)?.ownerUserId).toBe(1);
    expect(all.find((item) => item.id === other.id)?.ownerUserId).toBe(2);
  });

  it('管理员可删除他人的私有文档', async () => {
    const document = await store.add({
      title: '我的笔记',
      content: '香蕉是我的私有资料。',
      scope: 'private',
      userId: 1,
    });

    // isAdmin 为真时不再比对归属：后台需要能清理任意用户的文档
    await expect(store.remove(document.id, { userId: 2, isAdmin: true })).resolves.toBe(true);
  });

  it('向量维度变化后拒绝继续写入，避免新旧向量混算', async () => {
    await store.add({
      title: '水果手册',
      content: '苹果是一种常见水果。',
      scope: 'global',
      userId: 1,
    });
    // 另起一个连接模拟更换向量模型：同一目录同一时间只保留一个连接
    await store.close();

    const changed = new KnowledgeStore(dataDir, new FakeEmbeddings(4), OPTIONS);
    await expect(
      changed.add({
        title: '水果手册',
        content: '香蕉是一种常见水果。',
        scope: 'global',
        userId: 1,
      }),
    ).rejects.toThrow(/向量维度不一致/);
    await changed.close();
  });

  it('向量化服务不可用时提示服务地址，便于定位是否启动', async () => {
    const offlineDir = fs.mkdtempSync(path.join(TEST_ROOT, 'knowledge-offline-'));
    const offline = new KnowledgeStore(offlineDir, new OfflineEmbeddings(), OPTIONS);

    // 连接失败只给出 "fetch failed"，提示里必须带上地址才能自查
    await expect(
      offline.add({
        title: '水果手册',
        content: '苹果是一种常见水果。',
        scope: 'private',
        userId: 1,
      }),
    ).rejects.toThrow(/无法连接向量化服务 http:\/\/127\.0\.0\.1:11434/);

    await offline.close();
    fs.rmSync(offlineDir, { recursive: true, force: true });
  });
});
