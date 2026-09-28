import type { KnowledgeStore } from '../../rag/index.js';
import type { VisionReader } from '../vision.js';
import type { FileSource } from './files.js';
import { DISABLED_VISION } from '../vision.js';
import { createFileTools } from './files.js';
import { createKnowledgeTool } from './knowledge.js';
import { createUtilityTools } from './utility.js';

/**
 * 组装 Agent 工具集：知识库检索、附件清单与读取、文件导出、当前时间、算术计算。
 * 图片理解能力经 vision 注入：未配视觉模型的环境传 DISABLED_VISION，工具会给出可读提示。
 */
export function createTools(
  knowledge: KnowledgeStore,
  files: FileSource,
  vision: VisionReader = DISABLED_VISION,
) {
  return [
    createKnowledgeTool(knowledge),
    ...createFileTools(files, vision),
    ...createUtilityTools(),
  ];
}

/** 工具实例类型：由工厂的返回值推出，新增工具时无需另行登记类型 */
export type AgentTool = ReturnType<typeof createTools>[number];

/** 工具清单项：管理后台「LLM 工具」页只读展示 */
export interface ToolDescriptor {
  name: string;
  description: string;
  /** 参数名清单：取自工具自己的 zod schema，用于提示调用它需要给出什么输入 */
  params: string[];
}

/** 读取 zod schema 的字段名；非对象 schema 或未声明 schema 都按「无参数」处理 */
function readParamNames(schema: unknown): string[] {
  const shape = (schema as { shape?: Record<string, unknown> } | null | undefined)?.shape;
  return shape ? Object.keys(shape) : [];
}

/**
 * 从工具实例上读取展示信息：名称、用途与参数都取自工具定义本身。
 * 后台因此不必另存一份工具清单——改描述时不可能只改一边，新增工具也自动出现。
 */
export function describeTools(tools: AgentTool[]): ToolDescriptor[] {
  return tools.map((item) => ({
    name: item.name,
    description: item.description,
    params: readParamNames((item as { schema?: unknown }).schema),
  }));
}
