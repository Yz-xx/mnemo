import { describe, expect, it } from 'vitest';
import { ToolTrace } from '../../services/llm/toolTrace.js';

/**
 * 测试夹具：工具名与标签由调用方从工具定义注入，
 * 这里只摆出用例涉及的工具，顺带覆盖「未登记的工具回落成工具名」。
 */
const LABELED_TOOLS = [
  { name: 'search_knowledge_base', label: '检索知识库' },
  { name: 'read_file', label: '读取文件' },
  { name: 'get_current_time', label: '获取当前时间' },
  { name: 'calculator', label: '计算' },
];

/**
 * 本组用例只覆盖「参数何时算攒齐」与「怎么翻译成人话」两条规格：
 * 前者决定过程提示下发的时机，后者决定用户看到的是不是「正在检索什么」。
 */
describe('ToolTrace 工具调用轨迹', () => {
  it('参数分片还未拼成完整 JSON 时不发开始事件', () => {
    const trace = new ToolTrace(LABELED_TOOLS);

    expect(trace.push({ id: 'c1', name: 'search_knowledge_base', args: '{"que' })).toBeNull();
  });

  it('参数拼成完整 JSON 时发出开始事件，detail 由中文标签与关键入参拼成', () => {
    const trace = new ToolTrace(LABELED_TOOLS);
    trace.push({ id: 'c1', name: 'search_knowledge_base', args: '{"query":"' });

    const start = trace.push({ id: 'c1', args: '人工智能"}' });

    expect(start).toEqual({ name: 'search_knowledge_base', detail: '检索知识库：人工智能' });
  });

  it('开始事件只发一次：同一次调用的后续分片不再产出', () => {
    const trace = new ToolTrace(LABELED_TOOLS);
    trace.push({ id: 'c1', name: 'calculator', args: '{"expression":"1+1"}' });

    expect(trace.push({ id: 'c1', args: '' })).toBeNull();
  });

  it('同一轮里同名工具的多次调用各发一次，按调用 ID 区分', () => {
    const trace = new ToolTrace(LABELED_TOOLS);

    const first = trace.push({ id: 'c1', name: 'search_knowledge_base', args: '{"query":"年报"}' });
    const second = trace.push({
      id: 'c2',
      name: 'search_knowledge_base',
      args: '{"query":"预算"}',
    });

    expect(first?.detail).toBe('检索知识库：年报');
    expect(second?.detail).toBe('检索知识库：预算');
  });

  it('分片不带调用 ID 时按工具名与序号区分调用', () => {
    const trace = new ToolTrace(LABELED_TOOLS);

    const first = trace.push({ name: 'search_knowledge_base', index: 0, args: '{"query":"甲"}' });
    const second = trace.push({ name: 'search_knowledge_base', index: 1, args: '{"query":"乙"}' });

    expect(first?.detail).toBe('检索知识库：甲');
    expect(second?.detail).toBe('检索知识库：乙');
  });

  it('后续分片只带序号、不带调用 ID 与工具名时，仍归并到同一次调用', () => {
    const trace = new ToolTrace(LABELED_TOOLS);
    // openai 兼容协议的实测分片形态：首片带 name 与 id，次片只剩 index 与参数残片
    expect(
      trace.push({ id: 'call_mock_1', name: 'search_knowledge_base', index: 0, args: '' }),
    ).toBeNull();

    const start = trace.push({ index: 0, args: '{"query":"浏览器的渲染原理"}' });

    // 次片若被认成新调用，这里会得到一个 name 为 tool、摘要为「tool：浏览器的渲染原理」的事件
    expect(start).toEqual({
      name: 'search_knowledge_base',
      detail: '检索知识库：浏览器的渲染原理',
    });
  });

  it('同名工具多次调用时，只带序号的分片各自归并到对应调用', () => {
    const trace = new ToolTrace(LABELED_TOOLS);
    // 两次调用的分片交错下发，且尾片都只剩序号：序号是它们唯一还能区分的依据
    expect(
      trace.push({ id: 'c1', name: 'search_knowledge_base', index: 0, args: '{"que' }),
    ).toBeNull();
    expect(
      trace.push({ id: 'c2', name: 'search_knowledge_base', index: 1, args: '{"que' }),
    ).toBeNull();

    expect(trace.push({ index: 1, args: 'ry":"预算"}' })).toEqual({
      name: 'search_knowledge_base',
      detail: '检索知识库：预算',
    });
    expect(trace.push({ index: 0, args: 'ry":"年报"}' })).toEqual({
      name: 'search_knowledge_base',
      detail: '检索知识库：年报',
    });
  });

  it('分片不带序号时退回调用 ID，Ollama 式「一片即一次完整调用」不会被合并', () => {
    const trace = new ToolTrace(LABELED_TOOLS);

    // Ollama 每片都带完整参数、id 每片重取：两片就是两次调用，各自产出一条
    expect(trace.push({ id: 'o1', name: 'search_knowledge_base', args: '{"query":"甲"}' })).toEqual(
      { name: 'search_knowledge_base', detail: '检索知识库：甲' },
    );
    expect(trace.push({ id: 'o2', name: 'search_knowledge_base', args: '{"query":"乙"}' })).toEqual(
      { name: 'search_knowledge_base', detail: '检索知识库：乙' },
    );
  });

  it('工具结束时兜底补发始终没能解析出参数的调用，且只补发一次', () => {
    const trace = new ToolTrace(LABELED_TOOLS);
    expect(trace.push({ id: 'c1', name: 'read_file', args: '{"fileId":' })).toBeNull();

    expect(trace.flushPendingStart('read_file')).toEqual({ name: 'read_file', detail: '读取文件' });
    expect(trace.flushPendingStart('read_file')).toBeNull();
  });

  it('已正常发出开始事件的调用不再被兜底补发', () => {
    const trace = new ToolTrace(LABELED_TOOLS);
    trace.push({ id: 'c1', name: 'calculator', args: '{"expression":"1+1"}' });

    expect(trace.flushPendingStart('calculator')).toBeNull();
  });

  it('未登记的工具回落成工具名，取不到关键入参时只给标签', () => {
    const trace = new ToolTrace(LABELED_TOOLS);

    expect(trace.push({ id: 'c1', name: 'unknown_tool', args: '{"foo":1}' })).toEqual({
      name: 'unknown_tool',
      detail: 'unknown_tool',
    });
  });

  it('无参工具给出空对象时立即发出', () => {
    const trace = new ToolTrace(LABELED_TOOLS);

    expect(trace.push({ id: 'c1', name: 'get_current_time', args: '{}' })).toEqual({
      name: 'get_current_time',
      detail: '获取当前时间',
    });
  });

  it('入参过长时截断，避免把整段正文塞进标签', () => {
    const trace = new ToolTrace(LABELED_TOOLS);
    const expression = `${'1+'.repeat(40)}1`;

    const start = trace.push({
      id: 'c1',
      name: 'calculator',
      args: `{"expression":"${expression}"}`,
    });

    // 期望值写死为「前 24 字符 + 省略号」：实现若改了保留长度，这条用例必须随之被发现
    expect(start?.detail).toBe(`计算：${'1+'.repeat(12)}…`);
  });
});
