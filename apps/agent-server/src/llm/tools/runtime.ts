import type { ToolRunnableConfig } from '@langchain/core/tools';
import type { Logger } from '@repo/logger';

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
 * 从运行时配置中取出本轮检索来源的收集器：由 Agent 注入，检索工具只往里追加文档名。
 * 来源由此确定地流向客户端，而不是靠模型在正文里自行标注。
 */
export function readSources(config?: ToolRunnableConfig): string[] | undefined {
  const sources = config?.configurable?.sources;
  return Array.isArray(sources) ? (sources as string[]) : undefined;
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
