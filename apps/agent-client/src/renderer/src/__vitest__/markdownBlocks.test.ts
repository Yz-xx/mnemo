import MarkdownIt from 'markdown-it';
import { describe, expect, it } from 'vitest';
import { renderBlocks } from '../components/MessageItem/markdown';

// 与实现保持同配置的参照实例：用于验证「分块渲染」与「整体渲染」输出逐字一致
const reference = new MarkdownIt({ html: false, linkify: true, breaks: true });
reference.renderer.rules.link_open = (tokens, index, options, _env, self) => {
  tokens[index].attrSet('target', '_blank');
  return self.renderToken(tokens, index, options);
};

const SAMPLE = [
  '# 标题',
  '',
  '第一段，含 `行内代码` 与链接 https://example.com 。',
  '',
  '- 列表一',
  '- 列表二',
  '',
  '```ts',
  'const a = 1;',
  '',
  'const b = 2;',
  '```',
  '',
  '| 列 A | 列 B |',
  '| --- | --- |',
  '| 1 | 2 |',
].join('\n');

describe('renderBlocks', () => {
  it('分块顺序拼接后与整体渲染逐字一致', () => {
    expect(renderBlocks(SAMPLE).join('')).toBe(reference.render(SAMPLE));
  });

  it('围栏代码块内部的空行不会被当作块边界', () => {
    const fenceBlocks = renderBlocks(SAMPLE).filter((html) => html.includes('<pre>'));
    expect(fenceBlocks).toHaveLength(1);
    expect(fenceBlocks[0]).toContain('const b = 2;');
  });

  it('列表整体保留在一个块里', () => {
    const listBlocks = renderBlocks(SAMPLE).filter((html) => html.includes('<ul>'));
    expect(listBlocks).toHaveLength(1);
    expect(listBlocks[0]).toContain('列表二');
  });

  it('追加内容时已有块的 HTML 逐字不变', () => {
    const before = renderBlocks('第一段');
    const after = renderBlocks('第一段\n\n第二段');

    expect(after).toHaveLength(2);
    expect(after[0]).toBe(before[0]);
  });

  it('空文本返回空数组', () => {
    expect(renderBlocks('')).toEqual([]);
  });
});
