// 递归执行所有子包的单元测试（没有 test 脚本的包会被 pnpm 自动跳过）
import { run } from './utils/runner.js';

run(['-r', 'run', 'test']);
