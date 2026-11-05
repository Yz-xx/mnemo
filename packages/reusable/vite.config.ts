// 业务可复用代码的打包配置（Vite 库模式）：共同口径见 scripts/vite-lib.js；
// 跨包依赖（@mnemo/shared）由工厂按 package.json 自动外置，产物里不内联同一份通用工具
import { defineLibConfig } from '../../scripts/vite-lib.js';

export default defineLibConfig(import.meta.url);
