import { describe, expect, it } from 'vitest';
import { splitHighlight } from '../components/CitationDrawer/highlight';

describe('splitHighlight 文本高亮', () => {
  it('片段命中时切成「前文 + 命中段 + 后文」三段', () => {
    const segments = splitHighlight('甲。苹果是水果。乙。', '苹果是水果。');

    expect(segments).toEqual([
      { text: '甲。', highlighted: false },
      { text: '苹果是水果。', highlighted: true },
      { text: '乙。', highlighted: false },
    ]);
  });

  it('片段位于开头时不产生空的前文段', () => {
    expect(splitHighlight('苹果是水果。后文', '苹果是水果。')).toEqual([
      { text: '苹果是水果。', highlighted: true },
      { text: '后文', highlighted: false },
    ]);
  });

  it('片段位于结尾时不产生空的后文段', () => {
    expect(splitHighlight('前文苹果是水果。', '苹果是水果。')).toEqual([
      { text: '前文', highlighted: false },
      { text: '苹果是水果。', highlighted: true },
    ]);
  });

  it('摘要与全文对不上时整段不高亮，不伪造定位', () => {
    expect(splitHighlight('苹果是水果。', '香蕉是水果。')).toEqual([
      { text: '苹果是水果。', highlighted: false },
    ]);
  });

  it('空摘要或空全文时按无命中处理', () => {
    expect(splitHighlight('苹果是水果。', '   ')).toEqual([
      { text: '苹果是水果。', highlighted: false },
    ]);
    expect(splitHighlight('', '苹果')).toEqual([]);
  });
});
