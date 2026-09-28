import type { Router } from 'vue-router';
import { createRouter, createWebHistory } from 'vue-router';
// unplugin-vue-router 生成的虚拟模块：routes 是 src/pages 下的文件式路由表，
// handleHotUpdate 用于开发期热替换路由
import { handleHotUpdate, routes } from 'vue-router/auto-routes';
import { installGuards } from './guards';

const router: Router = createRouter({
  history: createWebHistory(),
  routes,
});

installGuards(router);

// 开发期修改 pages 文件后自动反映到路由表，无需刷新
if (import.meta.hot) {
  handleHotUpdate(router);
}

export default router;
