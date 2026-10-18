/**
 * 工具调用轨迹：把模型逐片吐出的工具调用参数拼成人类可读的「正在做什么」。
 * 独立成模块是因为「参数何时算攒齐」与「怎么翻译成人话」都是纯计算，
 * 不需要模型、数据库或流——抽出来后可直接单测，Agent 一侧只剩接线。
 */

/** 工具调用参数分片：与 LangChain 的 ToolCallChunk 结构兼容，只取用得上的字段 */
export interface ToolCallChunkLike {
  id?: string | null;
  name?: string | null;
  index?: number | null;
  args?: string | null;
}

/** 带标签的工具：标签取自工具定义本身，本模块不另存一份工具清单 */
export interface LabeledTool {
  name: string;
  label: string;
}

/** 一次工具调用的开始事件：name 供客户端降级展示，detail 是给用户看的阶段描述 */
export interface ToolStart {
  name: string;
  detail: string;
}

/**
 * 摘要候选入参：按可读性排序取首个非空字符串。
 * fileId 这类机器标识刻意不收——用户看不出两份 ID 的区别，摘要只会变成噪声。
 */
const SUMMARY_KEYS = ['query', 'name', 'expression'];

/** 摘要保留长度：标签是过程提示，过长会把界面顶宽 */
const SUMMARY_LIMIT = 24;

/** 解析累积出的参数：JSON 可以是数字或字符串，故用 unknown 承接 */
function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // 分片尚未拼完是最常见的原因，交给下一次 push 或工具结束时的兜底
    return undefined;
  }
}

/** 取关键入参并截断；取不到可读内容时返回 undefined */
function summarizeArgs(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    const text = value.trim();
    return text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT)}…` : text;
  }
  return undefined;
}

/** 一次工具调用的累积状态 */
interface PendingCall {
  name: string;
  args: string;
  started: boolean;
}

/**
 * 按调用累积参数分片，攒到能解析时给出一次开始事件。
 * 模型把工具调用拆成多片下发，首个分片只带工具名、参数还在路上，
 * 因此不能一见工具名就下发「正在检索知识库」——那时还不知道在检索什么。
 */
export class ToolTrace {
  private readonly calls = new Map<string, PendingCall>();
  /** 工具名 → 中文标签：由调用方从工具定义注入，本模块不另存一份清单 */
  private readonly labels: Record<string, string>;

  constructor(tools: ReadonlyArray<LabeledTool>) {
    this.labels = Object.fromEntries(tools.map((item) => [item.name, item.label]));
  }

  /** 消费一个参数分片：能解析出完整参数且该调用尚未开始时给出开始事件，否则返回 null */
  push(chunk: ToolCallChunkLike): ToolStart | null {
    // 序号是首选键：同一消息内多个工具调用按它区分，且它沿该调用的每一片复用，
    // 是唯一能跨分片聚合的键。调用 ID 只在首个分片出现（openai 兼容协议实测如此），
    // 拿 ID 当键会把只带序号的后续分片认成新调用——重复下发 start，且首片的空参数
    // 让用户看不出「在检索什么」。
    // 缺序号时退回调用 ID：Ollama 每片都带完整参数、id 每片重取，一次调用恰好落在一个分片。
    // 两者都缺才退回工具名，同名工具此时无从区分，只能合并成一条。
    const key = chunk.index != null ? `#${chunk.index}` : (chunk.id ?? `#${chunk.name ?? 'tool'}`);
    const call = this.calls.get(key) ?? { name: chunk.name ?? 'tool', args: '', started: false };
    if (chunk.name) call.name = chunk.name;
    if (chunk.args) call.args += chunk.args;
    this.calls.set(key, call);

    if (call.started) return null;
    const args = parseArgs(call.args);
    // 解析不出即视为参数还没拼完：此刻下发只会给出一个「在检索什么」都不知道的标签
    if (args === undefined) return null;

    call.started = true;
    return { name: call.name, detail: this.describe(call.name, args) };
  }

  /** 工具结束时的兜底：参数始终没拼完整就补发一次开始事件，保证过程提示不缺席 */
  flushPendingStart(name: string): ToolStart | null {
    for (const call of this.calls.values()) {
      if (call.name !== name || call.started) continue;
      call.started = true;
      return { name: call.name, detail: this.describe(call.name, parseArgs(call.args)) };
    }
    return null;
  }

  /** 工具名与入参 → 阶段描述：未登记的工具回落成工具名，取不到入参时只给标签 */
  private describe(name: string, args: unknown): string {
    const label = this.labels[name] ?? name;
    const summary = summarizeArgs(args);
    return summary ? `${label}：${summary}` : label;
  }
}
