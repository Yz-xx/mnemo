import type { KnowledgeBase } from '../../entities/knowledge.js';
import type { KnowledgeBaseStore } from '../../mappers/knowledge/bases.js';
import type { KnowledgeIngest, KnowledgeStore } from '../../services/knowledge/index.js';
import type { Logger } from '@mnemo/logger';
import { describe, expect, it } from 'vitest';
import {
  findManageableBase,
  findVisibleBase,
  listBases,
  parseBaseInput,
  parseBasePatch,
  removeBase,
  updateBase,
} from '../../services/knowledge/bases.js';

/** 静默日志：服务层用例只关心编排结果，日志内容另有审计用例覆盖 */
const silentLogger = { info: () => undefined } as unknown as Logger;

/** 库记录：私有库归属 7，另有同用户的另一座私有库与共享库 */
const BASE: KnowledgeBase = {
  id: 'kb-mine',
  name: '我的知识库',
  description: null,
  visibility: 'private',
  ownerUserId: 7,
  createdAt: '2026-11-05T08:00:00.000Z',
  updatedAt: '2026-11-05T08:00:00.000Z',
};

const SHARED: KnowledgeBase = {
  ...BASE,
  id: 'kb-shared',
  name: '共享知识库',
  visibility: 'global',
  ownerUserId: null,
};

/** 删库只验证权限与动作：文档清单与文件清理在专门用例里注入替身 */
const noDocuments = { list: async () => [] } as unknown as KnowledgeStore;
const noDiscard = { discard: async () => undefined } as unknown as KnowledgeIngest;

/** 替身库存储：按 id 返回预置记录，并记录写操作调用 */
function createFakeStore(bases: KnowledgeBase[]): {
  store: KnowledgeBaseStore;
  updates: Array<{ id: string; input: unknown }>;
  removes: string[];
} {
  const updates: Array<{ id: string; input: unknown }> = [];
  const removes: string[] = [];
  const store = {
    async list(userId: number) {
      return bases.map((base) => ({ ...base, documentCount: 0, userId }));
    },
    async find(id: string) {
      return bases.find((base) => base.id === id) ?? null;
    },
    async update(id: string, input: unknown) {
      updates.push({ id, input });
      return bases.find((base) => base.id === id) ?? null;
    },
    async remove(id: string) {
      removes.push(id);
      return bases.some((base) => base.id === id);
    },
  } as unknown as KnowledgeBaseStore;
  return { store, updates, removes };
}

describe('知识库服务入参', () => {
  it('创建入参：名称必填限长，描述空串归一为 null', () => {
    expect(parseBaseInput({ name: '  产品手册  ', description: '   ' })).toEqual({
      ok: true,
      value: { name: '产品手册', description: null },
    });
    expect(parseBaseInput({ name: '   ' })).toEqual({ ok: false, message: '知识库名称不能为空' });
    expect(parseBaseInput({ name: 'x'.repeat(129) }).ok).toBe(false);
  });

  it('编辑入参：只收出现过的字段，只改描述不清空名称，只改名不清空描述', () => {
    // 只改描述：结果里没有 name，服务层据此不写名称列
    expect(parseBasePatch({ description: '新描述' })).toEqual({
      ok: true,
      value: { description: '新描述' },
    });
    // 只改名：结果里没有 description，避免把原描述静默写成 null
    expect(parseBasePatch({ name: '  新名字  ' })).toEqual({
      ok: true,
      value: { name: '新名字' },
    });
    // 显式清空描述是合法 PATCH
    expect(parseBasePatch({ description: '' })).toEqual({
      ok: true,
      value: { description: null },
    });
    expect(parseBasePatch({}).ok).toBe(false);
    expect(parseBasePatch({ name: '' })).toEqual({ ok: false, message: '知识库名称不能为空' });
  });
});

describe('知识库可见性与维护权', () => {
  it('可见：共享库全员可见，私有库仅归属者；他人私有库按不存在处理', async () => {
    const { store } = createFakeStore([BASE, SHARED]);

    await expect(findVisibleBase(store, 7, 'kb-mine')).resolves.toMatchObject({ id: 'kb-mine' });
    await expect(findVisibleBase(store, 7, 'kb-shared')).resolves.toMatchObject({
      id: 'kb-shared',
    });
    await expect(findVisibleBase(store, 8, 'kb-mine')).resolves.toBeNull();
    await expect(findVisibleBase(store, 7, 'kb-missing')).resolves.toBeNull();
  });

  it('可维护：只有归属者对自己的私有库有维护权，共享库客户端不可维护', async () => {
    const { store } = createFakeStore([BASE, SHARED]);

    await expect(findManageableBase(store, 7, 'kb-mine')).resolves.toMatchObject({ id: 'kb-mine' });
    await expect(findManageableBase(store, 8, 'kb-mine')).resolves.toBeNull();
    await expect(findManageableBase(store, 7, 'kb-shared')).resolves.toBeNull();
  });

  it('列表透传当前用户：只由 mapper 做可见性过滤，服务层不再重复判定', async () => {
    const { store } = createFakeStore([BASE, SHARED]);

    await expect(listBases(store, 7)).resolves.toHaveLength(2);
  });
});

describe('知识库编辑与删除', () => {
  it('编辑：仅归属者；部分字段原样交给 mapper，未出现的列不落库', async () => {
    const { store, updates } = createFakeStore([BASE]);

    const updated = await updateBase(store, silentLogger, 7, 'kb-mine', { description: null });
    expect(updated).toMatchObject({ id: 'kb-mine' });
    expect(updates).toEqual([{ id: 'kb-mine', input: { description: null } }]);

    await expect(updateBase(store, silentLogger, 8, 'kb-mine', { name: 'x' })).resolves.toBeNull();
    expect(updates).toHaveLength(1);
  });

  it('删除：仅归属者，共享库不可删；删除动作只在通过判定后发生', async () => {
    const { store, removes } = createFakeStore([BASE, SHARED]);

    await expect(
      removeBase(store, noDocuments, noDiscard, silentLogger, 7, 'kb-mine'),
    ).resolves.toBe(true);
    expect(removes).toEqual(['kb-mine']);
    await expect(
      removeBase(store, noDocuments, noDiscard, silentLogger, 8, 'kb-mine'),
    ).resolves.toBe(false);
    await expect(
      removeBase(store, noDocuments, noDiscard, silentLogger, 7, 'kb-shared'),
    ).resolves.toBe(false);
    expect(removes).toHaveLength(1);
  });

  it('删除库时清理库内文档的原始文件：清单取自删库之前', async () => {
    const { store } = createFakeStore([BASE]);
    const discarded: string[] = [];
    const knowledge = {
      list: async () => [{ id: 'doc-a' }, { id: 'doc-b' }],
    } as unknown as KnowledgeStore;
    const ingest = {
      discard: async (id: string) => {
        discarded.push(id);
      },
    } as unknown as KnowledgeIngest;

    await expect(removeBase(store, knowledge, ingest, silentLogger, 7, 'kb-mine')).resolves.toBe(
      true,
    );
    expect(discarded).toEqual(['doc-a', 'doc-b']);
  });
});
