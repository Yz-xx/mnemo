import { createPinia } from 'pinia';
import { createApp } from 'vue';
import '@mnemo/components/style.css';
import { setSessionExpiredHandler } from './api/client';
import App from './App.vue';
import router from './router';
import { useAuthStore } from './stores/auth';
import './styles/base.less';

const app = createApp(App);
app.use(createPinia());
app.use(router);

// 恢复登录用户信息：pinia 安装后取 store，router 首次导航只校验 token 存在性，
// user 信息异步拉取 /api/auth/me 填充即可，无需阻塞首屏渲染
const auth = useAuthStore();
void auth.restoreUser();

// 任意请求收到 401 时统一回登录页：仅清 localStorage 会让页面停在原处、
// 顶栏仍显示已登录用户，与路由守卫的失效处理不一致
setSessionExpiredHandler(() => {
  auth.clear();
  void router.push('/login');
});

app.mount('#app');
