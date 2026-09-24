// 代码检查：ESLint 校验逻辑问题 + Prettier 校验格式；传入 --fix 时自动修复
import { run } from './utils/runner.js';

const shouldFix = process.argv.includes('--fix');

run(['exec', 'eslint', '.', ...(shouldFix ? ['--fix'] : [])]);
run(['exec', 'prettier', shouldFix ? '--write' : '--check', '.']);
