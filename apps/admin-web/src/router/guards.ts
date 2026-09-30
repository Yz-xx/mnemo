import type { Router } from 'vue-router';
import { getToken } from '@/api/client';
import { useAuthStore } from '@/stores/auth';

/**
 * 路由守卫：登录态 + 管理员角色双校验。
 *
 * 刷新页面时 store 里的用户信息为空，先等 restoreUser 拉一次 /me 再判角色，
 * 否则刚刷新就会被误判成非管理员踢回登录页。守卫在 pinia 安装之后执行
 * （main.ts 先 use(pinia) 再 use(router)），因此可以安全地取 store。
 *
 * 非管理员一律回登录页：后台没有面向普通账号的页面，跳过去只会再被拦一次。
 */
export function installGuards(router: Router): void {
  router.beforeEach(async (to) => {
    // 登录页本身放行，避免无限重定向
    if (to.path === '/login') return true;
    if (!getToken()) {
      return { path: '/login', query: { redirect: to.fullPath } };
    }

    const auth = useAuthStore();
    if (!auth.user) await auth.restoreUser();
    if (auth.user?.role !== 'admin') {
      return { path: '/login' };
    }
    return true;
  });
}
