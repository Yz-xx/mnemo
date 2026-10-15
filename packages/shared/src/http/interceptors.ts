import type { InterceptorManager } from './types.js';

interface InterceptorEntry<H> {
  id: number;
  handler: H;
}

/**
 * 拦截器链：只提供注册与移除，执行顺序由 `list()` 的返回顺序决定（即注册顺序）。
 *
 * 不在这里做「请求拦截器逆序执行」之类的编排：顺序是执行链的口径，
 * 由它一处决定；管理器只维护集合，两处各定一半顺序正是以后对不上的根源。
 */
export function createInterceptorManager<H>(): InterceptorManager<H> {
  let nextId = 1;
  const entries: InterceptorEntry<H>[] = [];

  return {
    use: (handler) => {
      const id = nextId;
      nextId += 1;
      entries.push({ id, handler });
      return id;
    },
    eject: (id) => {
      const index = entries.findIndex((entry) => entry.id === id);
      // 不存在时静默忽略：重复移除是调用方的正常场景（如组件卸载路径重入）
      if (index >= 0) entries.splice(index, 1);
    },
    list: () => entries.map((entry) => entry.handler),
  };
}
