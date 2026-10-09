/** ASCII 字符的估算密度：约 4 个字符折 1 个 token */
const ASCII_CHARS_PER_TOKEN = 4;

/** 逐字符累加出的 ASCII 与宽字符计数：估算与截断共用同一套加权口径 */
interface CharCounts {
  ascii: number;
  wide: number;
}

/** 按同一套加权口径把计数折算为 token 数；向上取整，不足 1 个 token 的零头也占位 */
function countsToTokens({ ascii, wide }: CharCounts): number {
  return Math.ceil(ascii / ASCII_CHARS_PER_TOKEN) + wide;
}

/** 累加文本里的字符构成：码点小于 0x80 的算 ASCII（英文、数字、半角标点），其余按整字符计 */
function countChars(text: string): CharCounts {
  const counts: CharCounts = { ascii: 0, wide: 0 };
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) < 0x80) counts.ascii += 1;
    else counts.wide += 1;
  }
  return counts;
}

/**
 * 统计一段文本的近似 token 数。
 * 不引入分词器：本仓的对话模型在本地小模型（qwen3）与线上模型（DeepSeek）之间切换，
 * 两者分词规则不同，统一按字符构成加权估算即可满足「判断是否超窗口」所需的精度。
 */
export function estimateTextTokens(text: string): number {
  return countsToTokens(countChars(text));
}

/**
 * 按 token 预算截断文本，返回不超过 maxTokens 的最长前缀。
 * 与 estimateTextTokens 共用同一套字符加权口径：截断后再估一次不会对不上。
 * 预算非正时返回空串，由调用方决定如何提示。
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  let ascii = 0;
  let wide = 0;
  let end = 0;
  for (const char of text) {
    const isAscii = (char.codePointAt(0) ?? 0) < 0x80;
    const nextAscii = ascii + (isAscii ? 1 : 0);
    const nextWide = wide + (isAscii ? 0 : 1);
    // 加进这个字符就超预算即停手，返回已经装得下的前缀
    if (countsToTokens({ ascii: nextAscii, wide: nextWide }) > maxTokens) break;
    ascii = nextAscii;
    wide = nextWide;
    end += char.length;
  }
  return text.slice(0, end);
}
