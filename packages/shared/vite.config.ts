// 公共库打包配置（Vite 库模式）：共同口径见 scripts/vite-lib.js，本包无额外差异
import { defineLibConfig } from '../../scripts/vite-lib.js';

export default defineLibConfig(import.meta.url);
