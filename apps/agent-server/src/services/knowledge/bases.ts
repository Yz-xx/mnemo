import type { KnowledgeIngest } from './ingest.js';
import type { KnowledgeStore } from './store.js';
import type { KnowledgeBase, KnowledgeBaseView } from '../../entities/knowledge.js';
import type { KnowledgeBaseStore } from '../../mappers/knowledge/bases.js';
import type { Logger } from '@mnemo/logger';

/** 知识库名称长度上限：与库表 DDL 的 varchar(128) 对齐，超限即 400 */
const NAME_MAX_LENGTH = 128;

/** 新建知识库的输入 */
export interface BaseInput {
  name: string;
  description: string | null;
}

/** 编辑库的部分输入：只改出现过的字段，未出现的保持原值 */
export interface BasePatch {
  name?: string;
  description?: string | null;
}

/**
 * 整理库入参：名称必填且限长（由路由翻成 400），描述可选（空串归一为 null）。
 * 客户端只能建私有库（global 库由迁移与管理令牌维护，见 docs/adr/0018 决策 7），
 * visibility 不进输入、由路由层固定传 'private'。
 */
export function parseBaseInput(
  body: unknown,
): { ok: true; value: BaseInput } | { ok: false; message: string } {
  const raw = (body ?? {}) as { name?: unknown; description?: unknown };
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return { ok: false, message: '知识库名称不能为空' };
  if (name.length > NAME_MAX_LENGTH) {
    return { ok: false, message: `知识库名称不能超过 ${NAME_MAX_LENGTH} 个字符` };
  }
  const description =
    typeof raw.description === 'string' && raw.description.trim() ? raw.description.trim() : null;
  return { ok: true, value: { name, description } };
}

/**
 * 整理编辑入参：只收出现过的字段（PATCH 语义），名称按创建同口径校验。
 * 不能复用 parseBaseInput——那里名称必填、描述缺省为空，会让「只改描述」直接 400、
 * 「只改名」把原描述静默清空。
 */
export function parseBasePatch(
  body: unknown,
): { ok: true; value: BasePatch } | { ok: false; message: string } {
  const raw = (body ?? {}) as { name?: unknown; description?: unknown };
  const patch: BasePatch = {};

  if (raw.name !== undefined) {
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) return { ok: false, message: '知识库名称不能为空' };
    if (name.length > NAME_MAX_LENGTH) {
      return { ok: false, message: `知识库名称不能超过 ${NAME_MAX_LENGTH} 个字符` };
    }
    patch.name = name;
  }

  if (raw.description !== undefined) {
    patch.description =
      typeof raw.description === 'string' && raw.description.trim() ? raw.description.trim() : null;
  }

  // 两列都没给：没有可更新内容，按参数非法拦下，避免空 UPDATE 白跑一趟
  if (patch.name === undefined && patch.description === undefined) {
    return { ok: false, message: '没有需要更新的字段' };
  }
  return { ok: true, value: patch };
}

/** 对当前用户可见的库清单（全局共享的 + 自己私有的），附每库文档数 */
export async function listBases(
  knowledgeBases: KnowledgeBaseStore,
  userId: number,
): Promise<KnowledgeBaseView[]> {
  return knowledgeBases.list(userId);
}

/**
 * 新建私有库：归属当前用户。global 库不在客户端创建范围内，
 * 故此入口固定 visibility='private'，不暴露可见性入参
 */
export async function createBase(
  knowledgeBases: KnowledgeBaseStore,
  logger: Logger,
  userId: number,
  input: BaseInput,
): Promise<KnowledgeBase> {
  const base = await knowledgeBases.create({
    name: input.name,
    description: input.description,
    visibility: 'private',
    ownerUserId: userId,
  });
  logger.info('知识库已创建', { baseId: base.id, userId });
  return base;
}

/**
 * 取当前用户可见的库：global 库或归属本人的私有库，其余按不存在处理（不泄漏他人库）。
 * 列表与文档读取都以它为前置；不可见返回 null 由路由翻成 404
 */
export async function findVisibleBase(
  knowledgeBases: KnowledgeBaseStore,
  userId: number,
  id: string,
): Promise<KnowledgeBase | null> {
  const base = await knowledgeBases.find(id);
  if (!base) return null;
  return base.visibility === 'global' || base.ownerUserId === userId ? base : null;
}

/** 当前用户对该库是否有维护权：私有库仅归属者；global 库客户端不可维护（返回 false） */
function isManageable(base: KnowledgeBase, userId: number): boolean {
  return base.visibility === 'private' && base.ownerUserId === userId;
}

/**
 * 取当前用户可维护的库：不存在、不可见或 global 库都返回 null（按不存在处理）。
 * 上传、编辑与删除库内文档都以它为前置
 */
export async function findManageableBase(
  knowledgeBases: KnowledgeBaseStore,
  userId: number,
  id: string,
): Promise<KnowledgeBase | null> {
  const base = await findVisibleBase(knowledgeBases, userId, id);
  return base && isManageable(base, userId) ? base : null;
}

/** 编辑库：改名 / 改描述，仅归属者可操作；空 PATCH 视为不存在处理 */
export async function updateBase(
  knowledgeBases: KnowledgeBaseStore,
  logger: Logger,
  userId: number,
  id: string,
  input: Partial<BaseInput>,
): Promise<KnowledgeBase | null> {
  const base = await findManageableBase(knowledgeBases, userId, id);
  if (!base) return null;
  const updated = await knowledgeBases.update(id, input);
  if (updated) logger.info('知识库已更新', { baseId: id, userId });
  return updated;
}

/**
 * 删除库：仅归属者可删自己的私有库，global 库不可删。
 * 库内文档与片段由外键级联删除，会话绑定由 SET NULL 回落为「不限库」；
 * 原始文件不在库里，必须先取文档清单、删库成功后逐个清理，否则磁盘残留。
 * 不可逆操作，日志留痕便于回溯
 */
export async function removeBase(
  knowledgeBases: KnowledgeBaseStore,
  knowledge: KnowledgeStore,
  ingest: KnowledgeIngest,
  logger: Logger,
  userId: number,
  id: string,
): Promise<boolean> {
  const base = await findManageableBase(knowledgeBases, userId, id);
  if (!base) return false;
  // 先取清单：库删掉后按库查不到文档，原始文件就无从清理
  const documents = await knowledge.list(base.id);
  const removed = await knowledgeBases.remove(id);
  if (!removed) return false;
  await Promise.all(documents.map((document) => ingest.discard(document.id)));
  logger.info('知识库已删除', {
    baseId: id,
    userId,
    name: base.name,
    documents: documents.length,
  });
  return removed;
}
