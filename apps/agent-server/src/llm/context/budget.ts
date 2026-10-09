import { estimateTextTokens, truncateToTokens } from './tokens.js';

/** 截断说明：附在被截断的文本之后，让模型知道后面还有内容没给 */
const TRUNCATED_NOTE = '\n\n（本轮工具结果已达上下文预算上限，其余内容未注入）';

/** 额度耗尽到连截断说明都放不下时的统一答复：调用方原样返回给模型，措辞不各写一份 */
export const BUDGET_EXHAUSTED_NOTE = '本轮工具结果已达上下文预算上限，未注入新内容。';

/** 一次注入的受理结果：实际可注入的文本，以及它是否因预算不足被截断 */
export interface Admission {
  /** 实际可注入的文本；被截断时末尾已附上说明 */
  text: string;
  /** 是否因剩余预算不足被截断 */
  truncated: boolean;
}

/**
 * 单轮工具结果的上下文额度：检索、读取与附件预读共用一份，跨同轮多次调用累计。
 * 与历史窗口（window.ts）分工不同——那里管跨轮的历史裁剪，这里管一轮之内往上下文里塞了多少产物，
 * 防止模型反复检索 / 反复读文件、或一份超长附件把窗口挤爆。
 */
export interface ToolBudget {
  /** 本轮已交付给模型的检索文档 ID：同一文档的片段不再重复注入 */
  readonly deliveredDocuments: Set<string>;
  /** 本轮已注入内容的估算 token 数，供日志观测 */
  readonly usedTokens: number;
  /**
   * 受理一段即将注入模型的内容，返回实际可注入的文本：
   * 装得下原样返回；装不下则按剩余预算截断并附说明；连说明都放不下（额度已耗尽）返回 null。
   */
  admit(text: string): Admission | null;
}

/** 创建本轮工具结果额度；limit 为本轮检索、读取与附件预读合计可注入的 token 上限 */
export function createToolBudget(limit: number): ToolBudget {
  let used = 0;

  return {
    deliveredDocuments: new Set<string>(),
    get usedTokens() {
      return used;
    },
    admit(text) {
      const tokens = estimateTextTokens(text);
      const left = limit - used;
      if (tokens <= left) {
        used += tokens;
        return { text, truncated: false };
      }
      // 截断前先给说明文字留出额度，否则提示本身又构成一笔超预算
      const room = left - estimateTextTokens(TRUNCATED_NOTE);
      if (room <= 0) return null;
      const admitted = `${truncateToTokens(text, room)}${TRUNCATED_NOTE}`;
      // 按实际注入量记账而非直接置为上限：否则日志里的用量会高报
      used += estimateTextTokens(admitted);
      return { text: admitted, truncated: true };
    },
  };
}
