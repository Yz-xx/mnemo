// Node 端库打包配置（Vite 库模式）：共同口径见 scripts/vite-lib.js；
// node: 内置模块一并外置，不打进产物
import { defineLibConfig } from '../../scripts/vite-lib.js';

export default defineLibConfig(import.meta.url, { externalNodeBuiltins: true });
