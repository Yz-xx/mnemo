import type { ChatCitation, MessageSource } from '../../types';

/** 来源标题：旧版落库存的是文档名，新版是可定位引用 */
export function sourceTitle(source: MessageSource): string {
  return typeof source === 'string' ? source : source.title;
}

/** 能否打开预览：旧版只有文档名，没有文档 ID，无从定位原文 */
export function canPreview(source: MessageSource): source is ChatCitation {
  return typeof source !== 'string';
}

/** 唯一键：新版按文档 + 片段定位，同一文档的不同片段各占一行 */
export function sourceKey(source: MessageSource, index: number): string {
  return typeof source === 'string'
    ? `${source}-${index}`
    : `${source.documentId}-${source.chunkId}`;
}

/** 悬浮提示：优先展示片段摘要；旧版没有摘要时退回标题 */
export function sourceHint(source: MessageSource): string {
  return typeof source === 'string' ? source : source.snippet || source.title;
}
