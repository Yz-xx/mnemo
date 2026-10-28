import type { Citations } from '../citations.js';
import type { ToolBudget } from '../context/index.js';
import type { ToolRunnableConfig } from '@langchain/core/tools';
import type { Logger } from '@mnemo/logger';

/** 一次导出产出的文件引用：Agent 在流结束后推给客户端，供用户点击下载 */
export interface GeneratedFileRef {
  fileId: string;
  name: string;
  size: number;
}

/** 从运行时配置中取出本轮导出文件的收集器：由 Agent 注入，工具只往里追加 */
export function readExports(config?: ToolRunnableConfig): GeneratedFileRef[] | undefined {
  const exported = config?.configurable?.exported;
  return Array.isArray(exported) ? (exported as GeneratedFileRef[]) : undefined;
}

/**
 * 从运行时配置中取出本轮检索来源的收集器：由 Agent 注入，检索工具只追加真正注入上下文的文档名。
 * 过程中的增量出处由它承担；终局是否采用由 citations 按正文标注判定，两者在流末尾收口。
 */
export function readSources(config?: ToolRunnableConfig): string[] | undefined {
  const sources = config?.configurable?.sources;
  return Array.isArray(sources) ? (sources as string[]) : undefined;
}

/**
 * 从运行时配置中取出本轮来源登记器：由 Agent 注入，检索工具只登记真正注入上下文的文档。
 * 回答结束后 Agent 再用同一个登记器从正文判定实际采用，两者必须共用一份状态。
 */
export function readCitations(config?: ToolRunnableConfig): Citations | undefined {
  const citations = config?.configurable?.citations as Citations | undefined;
  return typeof citations?.register === 'function' ? citations : undefined;
}

/** 从运行时配置中取出当前用户 ID：调用者身份由 Agent 经 configurable 注入 */
export function readUserId(config?: ToolRunnableConfig): number {
  const userId = config?.configurable?.userId;
  if (!Number.isInteger(userId)) {
    throw new Error('缺少当前用户身份，无法检索知识库');
  }
  return userId as number;
}

/**
 * 从运行时配置中取出本轮附件 ID。
 * 名单在路由层校验后可注入，工具只按这份名单办事：模型即使编出别的 ID 也读不到东西。
 */
export function readFileIds(config?: ToolRunnableConfig): string[] {
  const ids = config?.configurable?.fileIds;
  return Array.isArray(ids) ? (ids as string[]) : [];
}

/** 取请求级日志：由 Agent 经 configurable 下传，未注入时静默跳过，工具不强依赖日志 */
export function readLogger(config?: ToolRunnableConfig): Logger | undefined {
  const logger = config?.configurable?.logger as Logger | undefined;
  return typeof logger?.debug === 'function' ? logger : undefined;
}

/**
 * 从运行时配置中取出本轮工具结果额度：由 Agent 注入，检索与读取共用同一份。
 * 未注入时返回 undefined，工具按「无治理」处理——直接调用工具的单测即属此情形。
 */
export function readToolBudget(config?: ToolRunnableConfig): ToolBudget | undefined {
  const budget = config?.configurable?.toolBudget as ToolBudget | undefined;
  return typeof budget?.admit === 'function' ? budget : undefined;
}
