import type { KnowledgeBase } from '../../entities/knowledge.js';
import type { KnowledgeBaseReader } from '../../services/knowledge/index.js';

/**
 * 内存库读取器替身：构造时注入库清单，find / visibleIds 按它作答。
 * 供 KnowledgeStore 业务用例隔离 PostgreSQL——可见性判定逻辑本身是被测对象，
 * 替身只提供数据，不复刻判定。
 */
export function createFakeBases(bases: KnowledgeBase[]): KnowledgeBaseReader {
  return {
    async find(id) {
      return bases.find((base) => base.id === id) ?? null;
    },
    async visibleIds(userId) {
      return bases
        .filter((base) => base.visibility === 'global' || base.ownerUserId === userId)
        .map((base) => base.id);
    },
  };
}

/** 快速造一条库记录：省去测试里逐字段拼对象 */
export function makeBase(
  id: string,
  visibility: 'global' | 'private',
  ownerUserId: number | null,
): KnowledgeBase {
  return {
    id,
    name: `库 ${id}`,
    description: null,
    visibility,
    ownerUserId,
    createdAt: '2026-11-05T08:00:00.000Z',
    updatedAt: '2026-11-05T08:00:00.000Z',
  };
}
