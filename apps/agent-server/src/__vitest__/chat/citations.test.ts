import { describe, expect, it } from 'vitest';
import { createCitations } from '../../services/llm/citations.js';

/**
 * 本组用例覆盖「来源判定」：只承认正文里真的标注过的已登记文档；
 * 检索命中但正文没采用时返回空集合，不替模型认领出处。
 */
describe('Citations 引用判定', () => {
  it('正文用《》标注来源时，只返回被标注的文档', () => {
    const citations = createCitations();
    citations.register('d1', '公共手册');
    citations.register('d2', '我的笔记');

    expect(citations.resolve('根据《公共手册》，苹果属于水果。')).toEqual(['公共手册']);
  });

  it('多处标注按正文出现顺序返回，同一文档只保留一次', () => {
    const citations = createCitations();
    citations.register('d1', '公共手册');
    citations.register('d2', '我的笔记');

    expect(
      citations.resolve('《我的笔记》说香蕉是私有资料；《公共手册》也提到《我的笔记》。'),
    ).toEqual(['我的笔记', '公共手册']);
  });

  it('支持「」与引号等常见标注形态，不限定《》', () => {
    const citations = createCitations();
    citations.register('d1', '公共手册');

    expect(citations.resolve('「公共手册」提到苹果。')).toEqual(['公共手册']);
    expect(citations.resolve('“公共手册”提到苹果。')).toEqual(['公共手册']);
  });

  it('未加括号但直接写出文档名时也算标注', () => {
    const citations = createCitations();
    citations.register('d1', '公共手册');

    expect(citations.resolve('公共手册里写着苹果是全局资料。')).toEqual(['公共手册']);
  });

  it('正文没有标注任何已登记文档时，不返回来源', () => {
    const citations = createCitations();
    citations.register('d1', '浏览器的渲染原理');

    // 检索命中了无关文档：回答讲 HTTP/2，通篇没有出现文档名，不能挂出处
    expect(citations.resolve('HTTP/2 的多路复用通过流机制解决了队头阻塞。')).toEqual([]);
  });

  it('标注了未登记的文档名时不采信', () => {
    const citations = createCitations();
    citations.register('d1', '公共手册');

    expect(citations.resolve('根据《不存在的文档》，答案是……')).toEqual([]);
  });

  it('长标题与短标题同时命中同一处时，只保留更长的那个', () => {
    const citations = createCitations();
    citations.register('d1', '手册');
    citations.register('d2', '公共手册');

    expect(citations.resolve('《公共手册》提到苹果。')).toEqual(['公共手册']);
  });

  it('同一文档被重复登记时只出现一次', () => {
    const citations = createCitations();
    citations.register('d1', '公共手册');
    citations.register('d1', '公共手册');

    expect(citations.resolve('《公共手册》提到苹果。')).toEqual(['公共手册']);
  });

  it('size 只统计真正登记过的文档，供调用方决定是否推终局空清单', () => {
    const citations = createCitations();
    expect(citations.size()).toBe(0);

    citations.register('d1', '公共手册');
    citations.register('d1', '公共手册');
    // 空白标题视为无效登记，与 register 的过滤口径一致
    citations.register('d2', '   ');

    expect(citations.size()).toBe(1);
  });
});
