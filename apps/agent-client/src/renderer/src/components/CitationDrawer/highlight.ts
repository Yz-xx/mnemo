/** 高亮切段：highlighted 为真的段落即引用命中的原文 */
export interface TextSegment {
  text: string;
  highlighted: boolean;
}

/** 无命中时的整段结果：空内容返回空数组，避免模板渲染出一个空 span */
function plain(content: string): TextSegment[] {
  return content ? [{ text: content, highlighted: false }] : [];
}

/**
 * 按片段摘要把全文切成「命中前后 + 命中段」。
 * 只做整段精确匹配：摘要被截断或与全文不一致时宁可不高亮——
 * 定位不准的高亮会让用户以为内容就在那一段（见 ADR 纪律：无定位信息不伪造高亮）。
 */
export function splitHighlight(content: string, snippet: string): TextSegment[] {
  const needle = snippet.trim();
  if (!needle) return plain(content);

  const index = content.indexOf(needle);
  if (index === -1) return plain(content);

  const segments: TextSegment[] = [];
  if (index > 0) segments.push({ text: content.slice(0, index), highlighted: false });
  segments.push({ text: needle, highlighted: true });
  const tail = content.slice(index + needle.length);
  if (tail) segments.push({ text: tail, highlighted: false });
  return segments;
}
