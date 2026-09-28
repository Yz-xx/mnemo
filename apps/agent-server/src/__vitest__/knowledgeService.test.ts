import { describe, expect, it } from 'vitest';
import { describeAddFailure, parseDocumentInput } from '../services/knowledge.js';

describe('文档入库入参整理', () => {
  it('内容缺失或全为空白时判为非法，并给出可读提示', () => {
    expect(parseDocumentInput({})).toEqual({ ok: false, message: '文档内容不能为空' });
    expect(parseDocumentInput({ content: '   ' })).toEqual({
      ok: false,
      message: '文档内容不能为空',
    });
    // 非字符串内容同样按非法处理，不尝试隐式转换
    expect(parseDocumentInput({ content: 42 })).toEqual({
      ok: false,
      message: '文档内容不能为空',
    });
  });

  it('标题缺省为「未命名文档」，与客户端入口保持一致', () => {
    expect(parseDocumentInput({ content: '苹果是一种常见水果。' })).toEqual({
      ok: true,
      value: { title: '未命名文档', content: '苹果是一种常见水果。' },
    });
  });

  it('标题与内容都去除首尾空白', () => {
    expect(parseDocumentInput({ title: '  水果手册  ', content: ' 香蕉 ' })).toEqual({
      ok: true,
      value: { title: '水果手册', content: '香蕉' },
    });
  });
});

describe('入库失败文案', () => {
  it('带上固定前缀与原始原因，便于判断是不是向量化服务没起来', () => {
    expect(describeAddFailure(new Error('fetch failed'))).toBe('文档入库失败：fetch failed');
  });
});
