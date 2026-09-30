import { describe, expect, it } from 'vitest';
import { formatBytes, toBase64 } from '../bytes.js';

describe('Base64 编码', () => {
  it('按字节还原后编码，与 Buffer 的 base64 口径一致', () => {
    expect(toBase64(new Uint8Array([0x68, 0x69, 0x21]))).toBe('aGkh');
    // 高位字节同样按 0-255 还原，不能按 UTF-8 解读
    expect(toBase64(new Uint8Array([0xff, 0xfe]))).toBe('//4=');
  });

  it('空字节序列编码为空字符串', () => {
    expect(toBase64(new Uint8Array([]))).toBe('');
  });
});

describe('字节容量可读化', () => {
  it('按 B / KB / MB / GB 四档进位，字节档不带小数、其余保留一位', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB');
  });

  it('超过 GB 不再进档，避免出现 TB 这类列表里用不到的档位', () => {
    expect(formatBytes(2048 * 1024 * 1024)).toBe('2.0 GB');
  });
});
