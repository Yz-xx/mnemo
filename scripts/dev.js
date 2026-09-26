// 本地开发：先构建公共库（后端通过 workspace 引用其 dist），再并行启动用户选择的应用
// 用法：pnpm dev                     # 交互式多选（默认全选）
//       pnpm dev backend desktop     # 直接指定，支持目录名或包名
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { run } from './utils/runner.js';
import { multiSelect } from './utils/select.js';

/** 扫描 apps/ 下声明了 dev 脚本的应用，按目录名排序 */
function collectApps() {
  return readdirSync('apps', { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      try {
        const manifest = path.join('apps', entry.name, 'package.json');
        const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
        if (!pkg.scripts?.dev) return [];
        return [
          {
            dir: entry.name,
            name: pkg.name ?? entry.name,
            // 用目录路径作为 pnpm 过滤器，避免包名中的 @ 与 / 在不同 shell 下的转义差异
            filter: `./apps/${entry.name}`,
            label: `${pkg.name ?? entry.name}（apps/${entry.name}）`,
            hint: pkg.description ?? '',
          },
        ];
      } catch {
        return []; // 缺少或无法解析 package.json 的目录直接跳过
      }
    });
}

/** 按命令行参数筛选应用，同时返回无法识别的参数 */
function pickByArgs(apps, args) {
  const selected = apps.filter((app) => args.includes(app.dir) || args.includes(app.name));
  const unknown = args.filter((arg) => !apps.some((app) => app.dir === arg || app.name === arg));
  return { selected, unknown };
}

const apps = collectApps();
if (apps.length === 0) {
  console.error('[dev] apps/ 下没有声明 dev 脚本的应用');
  process.exit(1);
}

// pnpm 透传参数时会保留分隔符 --，这里统一剔除
const args = process.argv.slice(2).filter((arg) => arg !== '--');
let selected;

if (args.length > 0) {
  const { selected: matched, unknown } = pickByArgs(apps, args);
  if (unknown.length > 0) {
    const available = apps.map((app) => app.dir).join(' / ');
    console.error(`[dev] 未知应用：${unknown.join(', ')}（可选：${available}）`);
    process.exit(1);
  }
  selected = matched;
} else if (!process.stdin.isTTY) {
  // 非交互环境（CI、输出被管道接管）下无法弹菜单，保持启动全部应用的行为
  console.log('[dev] 当前环境不支持交互选择，将启动全部应用');
  selected = apps;
} else {
  const picked = await multiSelect({
    message: '? 请选择要启动的应用（↑/↓ 移动，空格切换，a 全选，回车确认，Esc 取消）',
    items: apps.map((app) => ({ label: app.label, hint: app.hint, value: app.dir })),
  });

  if (picked === null) {
    console.log('[dev] 已取消');
    process.exit(0);
  }
  selected = apps.filter((app) => picked.includes(app.dir));
}

if (selected.length === 0) {
  console.error('[dev] 未选择任何应用，已退出');
  process.exit(1);
}

console.log(`[dev] 启动应用：${selected.map((app) => app.dir).join('、')}`);

// 1. 确保公共库产物存在
run(['--filter', './packages/*', 'run', 'build']);

// 2. 并行运行所选应用的 dev 脚本（agent-server: tsx watch / agent-client: electron-vite / frontend: vite）
run(['--parallel', ...selected.flatMap((app) => ['--filter', app.filter]), 'run', 'dev']);
