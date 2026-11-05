import type { KnowledgeBase, KnowledgeBaseView, KnowledgeScope } from '../../entities/knowledge.js';
import type { DbPool } from '../../infrastructure/db/pool.js';
import type { QueryResultRow } from 'pg';
import { randomUUID } from 'node:crypto';
import { isUuid } from '../../utils/uuid.js';

/** 更新输入：两列都可选，只改出现过的字段（PATCH 语义），列名在 SQL 侧白名单展开 */
export interface UpdateKnowledgeBaseInput {
  name?: string;
  description?: string | null;
}

/** 新建知识库的输入：id 与时间由 mapper 生成，调用方不关心也不传 */
export interface CreateKnowledgeBaseInput {
  name: string;
  description?: string | null;
  visibility: KnowledgeScope;
  ownerUserId: number | null;
}

/** 库行：INSERT / SELECT 读回的原始列形状 */
interface KnowledgeBaseRow extends QueryResultRow {
  id: string;
  name: string;
  description: string | null;
  visibility: string;
  owner_user_id: number | null;
  created_at: Date | string;
  updated_at: Date | string;
}

/** 读回的行映射统一出口：timestamptz 驱动读回 Date，出口一律收敛成 ISO 串 */
function toBase(row: KnowledgeBaseRow): KnowledgeBase {
  const readTime = (value: Date | string): string =>
    value instanceof Date ? value.toISOString() : String(value);
  return {
    id: String(row.id),
    name: String(row.name),
    description:
      row.description === null || row.description === undefined ? null : String(row.description),
    visibility: row.visibility === 'global' ? 'global' : 'private',
    ownerUserId:
      row.owner_user_id === null || row.owner_user_id === undefined
        ? null
        : Number(row.owner_user_id),
    createdAt: readTime(row.created_at),
    updatedAt: readTime(row.updated_at),
  };
}

/**
 * 知识库 mapper：只做 SQL 与行映射，归属与可见性的配对约束由表的 CHECK 兜底，
 * 业务判定（如 global 库仅管理令牌可写）留在 service 层。
 */
export class KnowledgeBaseStore {
  constructor(private readonly pool: DbPool) {}

  /** 新建知识库：uuid 与时间在此生成并随 INSERT 一次往返取回 */
  async create(input: CreateKnowledgeBaseInput): Promise<KnowledgeBase> {
    const now = new Date();
    const { rows } = await this.pool.query<KnowledgeBaseRow>(
      `INSERT INTO knowledge_bases
         (id, name, description, visibility, owner_user_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       RETURNING id, name, description, visibility, owner_user_id, created_at, updated_at`,
      [
        randomUUID(),
        input.name,
        input.description ?? null,
        input.visibility,
        input.ownerUserId,
        now,
      ],
    );
    return toBase(rows[0]!);
  }

  /** 列出对当前用户可见的库：全局共享的 + 自己私有的，附每库文档数 */
  async list(userId: number): Promise<KnowledgeBaseView[]> {
    const { rows } = await this.pool.query<KnowledgeBaseRow>(
      `SELECT id, name, description, visibility, owner_user_id, created_at, updated_at
         FROM knowledge_bases WHERE visibility = 'global' OR owner_user_id = $1
         ORDER BY created_at DESC`,
      [userId],
    );
    const counts = await this.readDocumentCounts();
    return rows.map((row) => ({ ...toBase(row), documentCount: counts[row.id] ?? 0 }));
  }

  /** 管理端列表：不做可见性过滤，返回全部库（含各用户的私有库），附每库文档数 */
  async listAll(): Promise<KnowledgeBaseView[]> {
    const { rows } = await this.pool.query<KnowledgeBaseRow>(
      `SELECT id, name, description, visibility, owner_user_id, created_at, updated_at
         FROM knowledge_bases ORDER BY created_at DESC`,
    );
    const counts = await this.readDocumentCounts();
    return rows.map((row) => ({ ...toBase(row), documentCount: counts[row.id] ?? 0 }));
  }

  /** 按 id 批量取库：管理端解析文档归属用，不存在的 id 不出现在结果里 */
  async findByIds(ids: string[]): Promise<Map<string, KnowledgeBase>> {
    if (ids.length === 0) return new Map();
    const { rows } = await this.pool.query<KnowledgeBaseRow>(
      `SELECT id, name, description, visibility, owner_user_id, created_at, updated_at
         FROM knowledge_bases WHERE id = ANY($1)`,
      [ids],
    );
    return new Map(rows.map((row) => [String(row.id), toBase(row)]));
  }

  /** 按 id 取库：非 UUID 或不存在一律返回 null，不泄漏他人库是否存在 */
  async find(id: string): Promise<KnowledgeBase | null> {
    if (!isUuid(id)) return null;
    const { rows } = await this.pool.query<KnowledgeBaseRow>(
      `SELECT id, name, description, visibility, owner_user_id, created_at, updated_at
         FROM knowledge_bases WHERE id = $1 LIMIT 1`,
      [id],
    );
    return rows[0] ? toBase(rows[0]) : null;
  }

  /** 用户可见库的 id 清单：检索过滤前预解析（HNSW 扫描中不做 join，见 docs/adr/0018 决策 4） */
  async visibleIds(userId: number): Promise<string[]> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM knowledge_bases WHERE visibility = 'global' OR owner_user_id = $1`,
      [userId],
    );
    return rows.map((row) => String(row.id));
  }

  /**
   * 更新库：只改出现过的列（name / description 白名单），updated_at 随更新一并落库。
   * 空 PATCH（两列都没给）不落库直接返回 null，避免无意义的全表扫描 UPDATE
   */
  async update(id: string, input: UpdateKnowledgeBaseInput): Promise<KnowledgeBase | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (input.name !== undefined) {
      values.push(input.name);
      sets.push(`name = $${values.length}`);
    }
    if (input.description !== undefined) {
      values.push(input.description ?? null);
      sets.push(`description = $${values.length}`);
    }
    if (sets.length === 0) return null;
    values.push(new Date());
    sets.push(`updated_at = $${values.length}`);
    values.push(id);
    const { rows } = await this.pool.query<KnowledgeBaseRow>(
      `UPDATE knowledge_bases SET ${sets.join(', ')}
         WHERE id = $${values.length}
         RETURNING id, name, description, visibility, owner_user_id, created_at, updated_at`,
      values,
    );
    return rows[0] ? toBase(rows[0]) : null;
  }

  /** 删除库：文档与片段由外键级联删除，会话绑定由 SET NULL 级联回落为「不限库」 */
  async remove(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM knowledge_bases WHERE id = $1', [id]);
    return Number(rowCount ?? 0) > 0;
  }

  /**
   * 每库文档计数：文档表由向量适配器惰性建，未建表（42P01）时列表照常、计数全为 0，
   * 其余错误照常抛出——静默吞掉真实故障会让计数永远归零而无人察觉
   */
  private async readDocumentCounts(): Promise<Record<string, number>> {
    try {
      const { rows } = await this.pool.query<{
        knowledge_base_id: string;
        count: number | string;
      }>(
        'SELECT knowledge_base_id, COUNT(*) AS count FROM knowledge_documents GROUP BY knowledge_base_id',
      );
      // COUNT 经 int8 读回，池模块已全局收敛为数字，此处再 Number() 兜底类型收窄
      return Object.fromEntries(
        rows.map((row) => [String(row.knowledge_base_id), Number(row.count)]),
      );
    } catch (error) {
      if ((error as { code?: string }).code !== '42P01') throw error;
      return {};
    }
  }
}
