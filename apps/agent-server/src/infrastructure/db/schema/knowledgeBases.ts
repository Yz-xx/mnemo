import type { Client } from 'pg';
import { randomUUID } from 'node:crypto';

/**
 * 共享库的固定 UUID：存量 global 文档迁入此处（见 docs/adr/0018 决策 2）。
 * 幂等靠固定 id + ON CONFLICT DO NOTHING，不依赖名称查重——用户改名不影响二次迁移定位。
 */
export const SHARED_KNOWLEDGE_BASE_ID = '00000000-0000-4000-8000-000000000001';

/** 兜底私有库名称：仅为存量私有文档补建，用户可随时改名（无特殊标记，ADR 0018 决策 6） */
const DEFAULT_BASE_NAME = '我的知识库';

/** 会话绑库列：无条件幂等补列，存量库靠它追平新装库（新装由 CREATE TABLE 直接建出） */
const ADD_CONVERSATION_COLUMN_SQL = `ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS knowledge_base_id uuid NULL REFERENCES knowledge_bases (id) ON DELETE SET NULL`;

/**
 * 存量文档表补外键：旧 DDL 没有该列，自然也没有外键，删库时文档不会级联。
 * 新装库由 createDocumentsSql 直接建出同名约束；DO 块按约束名判存在，续跑不重复添加。
 */
const ADD_DOCUMENT_FK_SQL = `DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_documents_knowledge_base_id_fkey'
  ) THEN
    ALTER TABLE knowledge_documents
      ADD CONSTRAINT knowledge_documents_knowledge_base_id_fkey
      FOREIGN KEY (knowledge_base_id) REFERENCES knowledge_bases (id) ON DELETE CASCADE;
  END IF;
END $$`;

/** 探测指定表是否还有某个旧列 */
async function legacyColumnExists(client: Client, table: string, column: string): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = $1 AND column_name = $2 LIMIT 1`,
    [table, column],
  );
  return rows.length > 0;
}

/**
 * 是否仍有迁移收尾工作：documents / chunks 的旧列任一处残留，或旧索引还在，都必须继续跑。
 * 不能只看 documents.scope——删列阶段先删 documents 再删 chunks，
 * 中断在两步之间时只查 documents 会让 chunks 的旧列与旧索引永久残留（违背中断自愈）。
 */
async function migrationPending(client: Client): Promise<boolean> {
  const { rows } = await client.query<{ pending: boolean }>(
    `SELECT (
       EXISTS (SELECT 1 FROM information_schema.columns
         WHERE table_name = 'knowledge_documents' AND column_name IN ('scope', 'owner_user_id'))
       OR EXISTS (SELECT 1 FROM information_schema.columns
         WHERE table_name = 'knowledge_chunks' AND column_name IN ('scope', 'owner_user_id'))
       OR EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_chunks_visibility')
     ) AS pending`,
  );
  return Boolean(rows[0]?.pending);
}

/**
 * 存量文档迁库（docs/adr/0018）：
 * 补列 → 共享库兜底 → 按 owner 事务迁移私有文档 → global 搬运 → 片段回填 → 复核 →
 * 补外键 → 设非空并删除旧可见性列。
 * 每步各自幂等、判据只落数据上（knowledge_base_id IS NULL 即未迁）：
 * 任意一步中断，下次启动从剩余工作继续，不会重复搬运或提前删列。
 */
export async function migrateKnowledgeBases(client: Client): Promise<void> {
  await client.query(ADD_CONVERSATION_COLUMN_SQL);
  if (!(await migrationPending(client))) return;

  // 加列不带非空约束：存量行必须先允许悬空，搬完数据才设非空
  await client.query(
    'ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS knowledge_base_id uuid',
  );
  await client.query(
    'ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS knowledge_base_id uuid',
  );

  // 共享库：固定 UUID 幂等插入，global 文档的唯一归宿
  await client.query(
    `INSERT INTO knowledge_bases (id, name, description, visibility, owner_user_id, created_at, updated_at)
     VALUES ($1, $2, NULL, $3, $4, $5, $5) ON CONFLICT (id) DO NOTHING`,
    [SHARED_KNOWLEDGE_BASE_ID, '共享知识库', 'global', null, new Date()],
  );

  // 旧 scope 列已被删（前次中断在收尾阶段）时跳过按范围搬运，只做剩余清理
  if (await legacyColumnExists(client, 'knowledge_documents', 'scope')) {
    // owner 清单只取仍有未归属文档的用户：中断后重跑不重复处理已迁完的
    const { rows: owners } = await client.query<{ owner_user_id: number | string }>(
      `SELECT DISTINCT owner_user_id FROM knowledge_documents
        WHERE scope = 'private' AND owner_user_id IS NOT NULL AND knowledge_base_id IS NULL`,
    );
    for (const row of owners) {
      await migrateOwnerDocuments(client, Number(row.owner_user_id));
    }

    await client.query(
      `UPDATE knowledge_documents SET knowledge_base_id = $1
        WHERE scope = 'global' AND knowledge_base_id IS NULL`,
      [SHARED_KNOWLEDGE_BASE_ID],
    );
  }

  // 片段回填：从所属文档取库号，不重复解析归属规则
  await client.query(
    `UPDATE knowledge_chunks c SET knowledge_base_id = d.knowledge_base_id
       FROM knowledge_documents d
      WHERE c.document_id = d.id AND c.knowledge_base_id IS NULL`,
  );

  // 复核：仍有未归属行说明前面某步没走完，此时删列会丢数据，必须抛错留待下次自愈
  await assertAllAssigned(client, 'knowledge_documents');
  await assertAllAssigned(client, 'knowledge_chunks');

  // 结构对齐新装库：补外键 → 设非空 → 删旧可见性列 → 换检索过滤索引
  await client.query(ADD_DOCUMENT_FK_SQL);
  await client.query('ALTER TABLE knowledge_documents ALTER COLUMN knowledge_base_id SET NOT NULL');
  await client.query('ALTER TABLE knowledge_chunks ALTER COLUMN knowledge_base_id SET NOT NULL');
  await client.query('ALTER TABLE knowledge_documents DROP COLUMN IF EXISTS scope');
  await client.query('ALTER TABLE knowledge_documents DROP COLUMN IF EXISTS owner_user_id');
  await client.query('ALTER TABLE knowledge_chunks DROP COLUMN IF EXISTS scope');
  await client.query('ALTER TABLE knowledge_chunks DROP COLUMN IF EXISTS owner_user_id');
  await client.query('DROP INDEX IF EXISTS idx_chunks_visibility');
  await client.query(
    'CREATE INDEX IF NOT EXISTS idx_chunks_base ON knowledge_chunks (knowledge_base_id)',
  );
}

/**
 * 单个 owner 的私有文档迁移：建库与搬运同事务，中断只影响未处理的 owner。
 * 已有私有库（上次迁移建库成功但搬运未跑）则复用，不重建第二座兜底库。
 */
async function migrateOwnerDocuments(client: Client, ownerId: number): Promise<void> {
  await client.query('BEGIN');
  try {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM knowledge_bases WHERE visibility = 'private' AND owner_user_id = $1 LIMIT 1`,
      [ownerId],
    );
    const baseId = rows[0] ? String(rows[0].id) : randomUUID();
    if (!rows[0]) {
      await client.query(
        `INSERT INTO knowledge_bases (id, name, description, visibility, owner_user_id, created_at, updated_at)
         VALUES ($1, $2, NULL, $3, $4, $5, $5)`,
        [baseId, DEFAULT_BASE_NAME, 'private', ownerId, new Date()],
      );
    }
    await client.query(
      `UPDATE knowledge_documents SET knowledge_base_id = $1
        WHERE scope = 'private' AND owner_user_id = $2 AND knowledge_base_id IS NULL`,
      [baseId, ownerId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** 复核用白名单：动态表名只接受本模块真实涉及的两张表，杜绝拼接注入 */
const ASSIGNED_TABLES = new Set(['knowledge_documents', 'knowledge_chunks']);

/** 复核指定表已无未归属行：COUNT 经 int8 读回，出口 Number 收敛成数字再判定 */
async function assertAllAssigned(client: Client, table: string): Promise<void> {
  if (!ASSIGNED_TABLES.has(table)) throw new Error(`未知数据表：${table}`);
  const { rows } = await client.query<{ unassigned: number | string }>(
    `SELECT COUNT(*) FILTER (WHERE knowledge_base_id IS NULL) AS unassigned FROM ${table}`,
  );
  if (Number(rows[0]?.unassigned ?? 0) > 0) {
    throw new Error(`存量迁移未完成：${table} 仍存在未归属知识库的行`);
  }
}
