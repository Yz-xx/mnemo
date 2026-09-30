import { vi } from 'vitest';

/**
 * node 环境没有 localStorage：用内存实现顶替，让 admin-web 里经 localStorage 读写令牌的
 * 模块（api/client、stores/auth、router/guards）能在无 DOM 环境下被测。
 * 因此本仓库不需要为了测试引入 happy-dom —— 需要的只是「有个地方存字符串」。
 */
export function installMemoryStorage(): void {
  const map = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    get length(): number {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  } satisfies Storage);
}
