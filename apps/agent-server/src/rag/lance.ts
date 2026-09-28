// 类型类必须直接从 apache-arrow 取：LanceDB 的 CJS 入口透传导出无法被 ESM 静态识别
import { Field, FixedSizeList, Float32, Float64, Schema, Utf8 } from 'apache-arrow';

export const DOCUMENTS_TABLE = 'documents';
export const CHUNKS_TABLE = 'chunks';

/** 文档 ID 为 UUID，按白名单校验后再拼进过滤表达式，避免注入 */
export const DOCUMENT_ID = /^[0-9a-fA-F-]{36}$/;

/**
 * 文档表结构：显式声明列类型，避免按首行数据推断类型出错
 * （owner_user_id 需要可空，数值列统一用 Float64 以免读出 BigInt）
 */
export function documentsSchema(): Schema {
  return new Schema([
    new Field('id', new Utf8(), false),
    new Field('title', new Utf8(), false),
    new Field('scope', new Utf8(), false),
    new Field('owner_user_id', new Float64(), true),
    new Field('chunks', new Float64(), false),
    new Field('embedding_model', new Utf8(), false),
    new Field('dim', new Float64(), false),
    new Field('created_at', new Utf8(), false),
  ]);
}

/** 片段表结构：向量维度在建表时固定，维度不符时写入会直接失败 */
export function chunksSchema(dim: number): Schema {
  return new Schema([
    new Field('id', new Utf8(), false),
    new Field('document_id', new Utf8(), false),
    new Field('title', new Utf8(), false),
    new Field('content', new Utf8(), false),
    new Field('scope', new Utf8(), false),
    new Field('owner_user_id', new Float64(), true),
    new Field('created_at', new Utf8(), false),
    new Field('vector', new FixedSizeList(dim, new Field('item', new Float32(), false)), false),
  ]);
}
