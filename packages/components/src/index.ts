// 组件库统一出口
import type { App } from 'vue';
import MyButton from './components/MyButton.vue';

// 具名导出，支持按需引入：import { MyButton } from '@repo/components'
export { MyButton };

const components = { MyButton };

// Vue 插件安装方法，支持 app.use(Components) 全局注册
export default {
  install(app: App): void {
    Object.entries(components).forEach(([name, component]) => {
      app.component(name, component);
    });
  },
};
