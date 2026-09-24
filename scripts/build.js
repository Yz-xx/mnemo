// 全仓构建：先打包公共库（供后端直接消费 dist 产物），再构建业务应用
import { run } from './utils/runner.js';

// 1. 打包 packages/*（Vite 库模式）
run(['--filter', './packages/*', 'run', 'build']);

// 2. 构建 apps/*（均为 Vite 产物）
run(['--filter', './apps/*', 'run', 'build']);

console.log(`
----------------------
[build] 全部包构建完成
----------------------
`);
