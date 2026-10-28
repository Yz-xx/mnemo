// 先跑类型检查：vitest / vite 只转译不校验类型，纯类型错误不会被测试发现
// （没有 typecheck 脚本的包会被 pnpm 自动跳过）
import { run } from './utils/runner.js';

run(['-r', 'run', 'typecheck']);

// 递归执行所有子包的单元测试（没有 test 脚本的包会被 pnpm 自动跳过）
run(['-r', 'run', 'test']);
