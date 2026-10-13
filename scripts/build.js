// 全仓构建：先打包公共库（供后端直接消费 dist 产物），再构建业务应用，最后汇总各应用产物到根 dist/
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { run } from './utils/runner.js';

/** 汇总产物的输出目录，各应用按目录名各占一个子文件夹 */
const OUTPUT_DIR = 'dist';

/** 汇总的产物目录名：只收 Vite 的 dist（桌面端产物为 out，不属于汇总范围） */
const ARTIFACT_DIR = 'dist';

/** 清空上次的汇总结果，再把 apps/ 下各应用的 dist 产物复制到 dist/<应用目录名>/ */
function collectArtifacts() {
  rmSync(OUTPUT_DIR, { recursive: true, force: true });

  for (const entry of readdirSync('apps', { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const app = entry.name;

    const source = path.join('apps', app, ARTIFACT_DIR);
    if (!existsSync(source)) {
      console.warn(`[build] 跳过 ${app}：未找到 ${ARTIFACT_DIR} 产物`);
      continue;
    }

    const target = path.join(OUTPUT_DIR, app);
    mkdirSync(target, { recursive: true });
    cpSync(source, target, { recursive: true });
    console.log(`[build] 已汇总 ${app} → ${target}`);
  }
}

// 1. 打包 packages/*（Vite 库模式）
run(['--filter', './packages/*', 'run', 'build']);

// 2. 构建 apps/*（均为 Vite 产物）
run(['--filter', './apps/*', 'run', 'build']);

// 3. 汇总各应用产物到根 dist/，便于统一取用与分发
collectArtifacts();

console.log(`
----------------------------------------------
[build] 全部包构建完成，应用产物已汇总到 ${OUTPUT_DIR}/
----------------------------------------------
`);
