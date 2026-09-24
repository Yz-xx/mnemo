// 本地开发：先构建公共库（后端通过 workspace 引用其 dist），再并行启动前后端
import { run } from './utils/runner.js';

// 1. 确保公共库产物存在
run(['--filter', './packages/*', 'run', 'build']);

// 2. 并行运行各应用的 dev 脚本（frontend: Vite / backend: tsx watch）
run(['--parallel', '--filter', './apps/*', 'run', 'dev']);
