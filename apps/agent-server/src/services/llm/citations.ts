/**
 * 检索来源的登记与采用判定。
 *
 * 检索工具只在片段真正注入上下文时登记文档；答复结束后从正文里解析实际被标注的文档名。
 * 一处都没标注就返回空集合：检索到的资料可能完全没被采用（例如与问题无关仍被召回），
 * 服务端不能替模型认领出处——宁可少标，也不把「模型看过」当成「回答用过」。
 */

/**
 * 本轮检索来源：小接口藏住「标注匹配」规则。
 * 调用方只需在注入时登记、在回答结束后取一次结论，不必知道括号形态与重叠消歧。
 */
export interface Citations {
  /** 登记一份真正注入上下文的文档；同一文档重复登记按首次计 */
  register(documentId: string, title: string): void;
  /** 已登记文档数：为 0 表示本轮没有候选来源，调用方连终局空清单都不必推 */
  size(): number;
  /** 从答复正文判定实际被引用的文档名，按正文首次出现顺序；空数组表示正文没有标注 */
  resolve(answer: string): string[];
}

/** 常见来源标注括号：模型不一定会照抄《》，多认几种形态提升判定召回 */
const BRACKETS = [
  ['《', '》'],
  ['「', '」'],
  ['“', '”'],
  ['"', '"'],
] as const;

/** 裸标题可作为引用证据的最短长度：过短的词会在正文里频繁误命中 */
const MIN_PLAIN_TITLE = 4;

/** 去掉空白后再匹配：「公共 手册」与「公共手册」视为同一份文档 */
function compact(text: string): string {
  return text.replace(/\s+/g, '');
}

/** 一份已登记文档：key 用于匹配，title 用于展示 */
interface RegisteredTitle {
  documentId: string;
  title: string;
  key: string;
}

/** 正文中的一处命中：区间用于消解「长短标题套叠」 */
interface Hit {
  title: string;
  start: number;
  end: number;
}

/** 在正文里定位标题：优先找括号标注，其次找裸标题；都找不到返回 null */
function locate(text: string, title: string): { start: number; end: number } | null {
  let best: { start: number; end: number } | null = null;
  for (const [open, close] of BRACKETS) {
    const index = text.indexOf(`${open}${title}${close}`);
    if (index === -1) continue;
    const end = index + open.length + title.length + close.length;
    // 同一份文档可能被多种括号标注，取正文里最先出现的那处
    if (!best || index < best.start) best = { start: index, end };
  }
  if (best) return best;
  if (title.length < MIN_PLAIN_TITLE) return null;
  const index = text.indexOf(title);
  return index === -1 ? null : { start: index, end: index + title.length };
}

/** 按正文顺序收集命中，并丢掉与更长标题套叠的短标题 */
function collectHits(text: string, registered: RegisteredTitle[]): Hit[] {
  const hits = registered.flatMap((item) => {
    const position = locate(text, item.key);
    return position ? [{ title: item.title, ...position }] : [];
  });
  // 同一处文本被长短两个标题同时命中时只留长的，否则「公共手册」会额外带出一个「手册」
  hits.sort((a, b) => a.start - b.start || b.end - a.end);

  const accepted: Hit[] = [];
  for (const hit of hits) {
    if (accepted.some((item) => hit.start < item.end && item.start < hit.end)) continue;
    accepted.push(hit);
  }
  return accepted;
}

/** 创建本轮来源登记器：状态只活在单轮对话内，随轮次结束丢弃 */
export function createCitations(): Citations {
  const registered: RegisteredTitle[] = [];
  const seen = new Set<string>();

  return {
    register(documentId, title) {
      const key = compact(title);
      if (!key || seen.has(documentId)) return;
      seen.add(documentId);
      registered.push({ documentId, title, key });
    },
    size() {
      return registered.length;
    },
    resolve(answer) {
      // 没标注就是没采用：已注入只证明模型看过，不能据此挂上出处
      return collectHits(compact(answer), registered).map((hit) => hit.title);
    },
  };
}
