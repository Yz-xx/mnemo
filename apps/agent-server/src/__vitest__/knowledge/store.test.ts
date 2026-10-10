import type { Connection } from '@lancedb/lancedb';
import fs from 'node:fs';
import path from 'node:path';
import { connect } from '@lancedb/lancedb';
import { Field, Float64, Schema, Utf8 } from 'apache-arrow';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KnowledgeStore } from '../../rag/index.js';
import { FakeEmbeddings, OfflineEmbeddings, TEST_ROOT } from '../helpers/fakeEmbeddings.js';

const OPTIONS = {
  chunkSize: 60,
  chunkOverlap: 0,
  topK: 2,
  minScore: 0.6,
  embeddingModel: 'fake-embedding',
  embeddingEndpoint: 'http://127.0.0.1:11434',
};

/** 旧库示例文档的固定 ID：迁移与新增两条用例共用同一份旧表 */
const LEGACY_DOCUMENT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

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

  it('getContent 返回库内原文与元数据', async () => {
    const document = await store.add({
      title: '水果手册',
      content: '苹果是一种常见水果。',
      scope: 'global',
      userId: 1,
    });

    const content = await store.getContent(document.id, { userId: 1, isAdmin: false });
    expect(content).toMatchObject({
      document,
      content: '苹果是一种常见水果。',
      source: 'raw',
      updatedAt: null,
    });
  });

  it('查看权限与删除一致：非归属者按不存在处理，管理员可查任意文档', async () => {
    const document = await store.add({
      title: '我的笔记',
      content: '香蕉是我的私有资料。',
      scope: 'private',
      userId: 1,
    });

    await expect(store.getContent(document.id, { userId: 2, isAdmin: false })).resolves.toBe(null);
    const admin = await store.getContent(document.id, { userId: 2, isAdmin: true });
    expect(admin?.content).toBe('香蕉是我的私有资料。');
  });

  it('旧文档无原文时按分片顺序拼接近似还原', async () => {
    const document = await store.add({
      title: '水果手册',
      content: '苹果是一种常见水果。',
      scope: 'global',
      userId: 1,
    });

    // 旧库的文档行没有原文：清空 content 列模拟迁移后的旧行，读取应回退按分片拼接
    await store.close();
    const connection = await connect(path.join(dataDir, 'knowledge', 'lancedb'));
    const table = await connection.openTable('documents');
    await table.update({ where: `id = '${document.id}'`, valuesSql: { content: 'NULL' } });
    await connection.close();
    store = new KnowledgeStore(dataDir, new FakeEmbeddings(), OPTIONS);

    const content = await store.getContent(document.id, { userId: 1, isAdmin: false });
    expect(content?.source).toBe('stitched');
    expect(content?.content).toBe('苹果是一种常见水果。');
  });

  it('编辑整体替换内容：id 与入库时间不变，检索命中新分片并留存新原文', async () => {
    const document = await store.add({
      title: '水果手册',
      content: '苹果是一种常见水果。',
      scope: 'global',
      userId: 1,
    });

    const updated = await store.replace(
      document.id,
      { title: '热带手册', content: '香蕉是热带水果。' },
      { userId: 2, isAdmin: true },
    );
    expect(updated?.id).toBe(document.id);
    expect(updated?.title).toBe('热带手册');
    expect(updated?.createdAt).toBe(document.createdAt);

    const content = await store.getContent(document.id, { userId: 1, isAdmin: false });
    expect(content?.source).toBe('raw');
    expect(content?.content).toBe('香蕉是热带水果。');
    expect(content?.updatedAt).not.toBe(null);

    // 检索只命中新分片：旧内容（苹果）不再出现
    await expect(store.search('苹果', { userId: 1 })).resolves.toEqual([]);
    const [hit] = await store.search('香蕉', { userId: 1 });
    expect(hit.title).toBe('热带手册');
    expect(hit.content).toContain('香蕉');
  });

  it('编辑时向量化失败不改动库内数据，重试即可恢复', async () => {
    const document = await store.add({
      title: '水果手册',
      content: '苹果是一种常见水果。',
      scope: 'global',
      userId: 1,
    });

    // 同一目录同一时间只保留一个连接：关掉原连接再模拟向量化服务掉线
    await store.close();
    const offline = new KnowledgeStore(dataDir, new OfflineEmbeddings(), OPTIONS);
    await expect(
      offline.replace(
        document.id,
        { title: '热带手册', content: '香蕉是热带水果。' },
        { userId: 1, isAdmin: true },
      ),
    ).rejects.toThrow(/无法连接向量化服务/);
    await offline.close();

    store = new KnowledgeStore(dataDir, new FakeEmbeddings(), OPTIONS);
    const content = await store.getContent(document.id, { userId: 1, isAdmin: false });
    expect(content?.content).toBe('苹果是一种常见水果。');
    const [hit] = await store.search('苹果', { userId: 1 });
    expect(hit.content).toContain('苹果');
  });

  it('编辑不存在的文档或他人私有文档按不存在处理', async () => {
    const document = await store.add({
      title: '我的笔记',
      content: '香蕉是我的私有资料。',
      scope: 'private',
      userId: 1,
    });

    await expect(
      store.replace(
        document.id,
        { title: '改名', content: '橘子是我的资料。' },
        { userId: 2, isAdmin: false },
      ),
    ).resolves.toBe(null);
    await expect(
      store.replace(
        '00000000-0000-0000-0000-000000000000',
        { title: '改名', content: '橘子是我的资料。' },
        { userId: 1, isAdmin: true },
      ),
    ).resolves.toBe(null);
  });

  /** 模拟功能上线前的旧库：documents 表按旧 schema 建出（无 content/updated_at 后补列）并写入一行 */
  async function createLegacyDocumentsTable(): Promise<void> {
    const connection: Connection = await connect(path.join(dataDir, 'knowledge', 'lancedb'));
    await connection.createEmptyTable(
      'documents',
      new Schema([
        new Field('id', new Utf8(), false),
        new Field('title', new Utf8(), false),
        new Field('scope', new Utf8(), false),
        new Field('owner_user_id', new Float64(), true),
        new Field('chunks', new Float64(), false),
        new Field('embedding_model', new Utf8(), false),
        new Field('dim', new Float64(), false),
        new Field('created_at', new Utf8(), false),
      ]),
    );
    const documents = await connection.openTable('documents');
    await documents.add([
      {
        id: LEGACY_DOCUMENT_ID,
        title: '旧手册',
        scope: 'global',
        owner_user_id: null,
        chunks: 1,
        embedding_model: 'fake-embedding',
        dim: 3,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]);
    await connection.close();
  }

  it('旧表缺列时编辑触发补列迁移，迁移后留存原文可读', async () => {
    await store.close();
    await createLegacyDocumentsTable();
    store = new KnowledgeStore(dataDir, new FakeEmbeddings(), OPTIONS);

    // 编辑走写入路径：旧表缺列时迁移补列必须在动库前正常完成
    const updated = await store.replace(
      LEGACY_DOCUMENT_ID,
      { title: '新手册', content: '香蕉是热带水果。' },
      { userId: 2, isAdmin: true },
    );
    expect(updated?.title).toBe('新手册');

    const content = await store.getContent(LEGACY_DOCUMENT_ID, { userId: 1, isAdmin: false });
    expect(content?.source).toBe('raw');
    expect(content?.content).toBe('香蕉是热带水果。');
  });

  it('旧表补列后新增文档仍可入库：未编辑的 updated_at 落空串而非 null', async () => {
    await store.close();
    await createLegacyDocumentsTable();
    store = new KnowledgeStore(dataDir, new FakeEmbeddings(), OPTIONS);

    // 新增走 add：updated_at 语义为「从未编辑」，而补列由 addColumns 生成、被 Lance 记为
    // non-nullable，写 null 会让整批写入失败，因此必须落成空串哨兵
    const document = await store.add({
      title: '浏览器渲染原理',
      content: '浏览器渲染分为解析、布局、绘制等阶段。',
      scope: 'global',
      userId: 7,
    });

    const content = await store.getContent(document.id, { userId: 7, isAdmin: false });
    expect(content?.source).toBe('raw');
    expect(content?.updatedAt).toBe(null);
    await expect(store.list(7)).resolves.toHaveLength(2);
  });
});
