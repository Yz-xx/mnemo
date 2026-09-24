import { spawnSync } from 'node:child_process';
import process from 'node:process';

/**
 * 在仓库根目录执行一条 pnpm 命令，子进程共享标准输入输出
 * @param {string[]} args pnpm 参数列表，例如 ['-r', 'run', 'build']
 */
export function run(args) {
  const result = spawnSync('pnpm', args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    // Windows 下 pnpm 是 .cmd 脚本，必须经由 shell 解析
    shell: process.platform === 'win32',
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
