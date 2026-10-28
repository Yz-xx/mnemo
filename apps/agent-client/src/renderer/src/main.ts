import { createApp } from 'vue';
import App from './App.vue';
import { installRenderMetrics } from './perf/renderMetrics';
import './styles/index.less';

installRenderMetrics();
createApp(App).mount('#app');
