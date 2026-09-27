import { describe, expect, it } from 'vitest';
import { buildDocument } from '../files/generate.js';
import { extractText } from '../files/parser.js';

const TITLE = '季度报告';
const BODY = '营收增长 12%\n成本下降 3%';

/**
 * 生成与解析互为镜像：断言方式是把生成的文件再交给解析器读回来，
 * 只检查字节非空证明不了文件真的能被打开、内容真的在里头。
 */
describe('buildDocument', () => {
  it('生成 docx 并能被解析器读回标题与正文', async () => {
    const doc = await buildDocument({ format: 'docx', title: TITLE, content: BODY });

    expect(doc.ext).toBe('docx');
    expect(doc.mime).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    const text = await extractText({ ext: doc.ext, name: `${TITLE}.docx`, bytes: doc.bytes });
    expect(text).toContain(TITLE);
    expect(text).toContain('营收增长 12%');
  });

  it('生成 xlsx 并能被解析器读回，行内按竖线分列', async () => {
    const doc = await buildDocument({
      format: 'xlsx',
      title: TITLE,
      content: '姓名|分数\n张三|90',
    });

    expect(doc.ext).toBe('xlsx');
    const text = await extractText({ ext: doc.ext, name: `${TITLE}.xlsx`, bytes: doc.bytes });
    expect(text).toContain('姓名 | 分数');
    expect(text).toContain('张三 | 90');
  });

  it('生成 pdf 并能被解析器读回中文正文', async () => {
    const doc = await buildDocument({ format: 'pdf', title: TITLE, content: BODY });

    expect(doc.ext).toBe('pdf');
    expect(doc.mime).toBe('application/pdf');
    const text = await extractText({ ext: doc.ext, name: `${TITLE}.pdf`, bytes: doc.bytes });
    expect(text).toContain(TITLE);
    expect(text).toContain('营收增长');
  });

  it('文件名里的非法字符不会让 xlsx 生成失败', async () => {
    // 工作表名不允许 [ ] : * ? / \ 这些字符，标题直接来自模型，必须清洗
    const doc = await buildDocument({
      format: 'xlsx',
      title: '报告[2026]:初稿/终稿',
      content: '内容',
    });

    await expect(
      extractText({ ext: doc.ext, name: '报告.xlsx', bytes: doc.bytes }),
    ).resolves.toContain('内容');
  });

  it('超长正文会分页而不是被裁掉', async () => {
    // 单页容量有限，写满必须换页，否则后半段内容会静默消失
    const long = Array.from({ length: 120 }, (_, index) => `第 ${index + 1} 行内容`).join('\n');
    const doc = await buildDocument({ format: 'pdf', title: TITLE, content: long });

    const text = await extractText({ ext: doc.ext, name: `${TITLE}.pdf`, bytes: doc.bytes });
    expect(text).toContain('第 1 行内容');
    expect(text).toContain('第 120 行内容');
  });
});
