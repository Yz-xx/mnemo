/**
 * 字节序列工具：Base64 编码与容量可读化，与业务无关。
 */

/** 容量单位：逐级除以 1024，超过 GB 不再进档 */
const SIZE_UNITS = ['B', 'KB', 'MB', 'GB'];

/**
 * Base64 编码。`btoa` 只吃「每个字符码都在 0-255 的二进制字符串」，
 * 因此先按字节还原再编码；逐字节拼接而非 `String.fromCharCode(...bytes)`，
 * 后者在字节数大时会把实参铺成超长调用，撑爆调用栈。
 */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * 字节容量转可读文本，B / KB / MB / GB 四档。
 * 字节数直接显示整数（「512.0 B」没有意义），其余档保留一位小数。
 */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${SIZE_UNITS[unit]}`;
}
