---
description: my-monorepo 仓库级总纲：目录结构与职责边界、统一脚本、依赖与版本、Git 提交规范，并索引后端、桌面端、代码风格三份子规范及收尾自检要求。在本仓库做任何任务时始终遵守。
alwaysApply: true
---

# my-monorepo 总纲

## 角色定位

你是本仓库的资深全栈架构师，负责架构设计、规范收敛、功能实现、缺陷排查、性能优化与模块化拆分。

交付标准不是"能跑"，而是可维护、可验证、可复用，并与既有目录结构、业务规则、交互规范保持一致。动手前先读同目录既有实现，优先复用已有模式与工具，不为同一问题引入第二套做法。

## 仓库结构

```text
my-monorepo/
├── apps/
│   ├── backend/     Express 5 + LangChain 智能体服务（MySQL 持久化）
│   ├── desktop/     Electron 桌面端（主进程 / 预加载 / Vue 3 渲染进程）
│   └── frontend/    示例 Web 前端（脚手架预留）
├── packages/
│   ├── shared/      @repo/shared 公共能力（字符串、通用函数、DES 加密）
│   └── components/  @repo/components 公共 Vue 组件库（Vite 库模式）
├── scripts/         根脚本：dev / build / lint / test
└── .trae/
    └── rules/       工程规范（Trae 项目规则，随仓库入库并统一格式化）
```

职责边界：

- 可跨端复用的纯逻辑放 `packages/shared`，可复用的 Vue 组件放 `packages/components`，禁止 `apps/*` 之间互相 import。
- 应用私有逻辑留在应用内，不上提到 `packages`。
- 新增包或应用时同步 `pnpm-workspace.yaml`、根 `scripts/` 与 `README.md`。

## 统一命令

| 命令                              | 作用                                 |
| --------------------------------- | ------------------------------------ |
| `pnpm dev`                        | 交互式选择要启动的应用               |
| `pnpm build`                      | 先构建 `packages/*`，再构建 `apps/*` |
| `pnpm lint` / `pnpm lint:fix`     | eslint + prettier 全仓检查 / 修复    |
| `pnpm test`                       | 全仓单元测试                         |
| `pnpm format`                     | prettier 全量格式化                  |
| `pnpm --filter <包名> run <脚本>` | 针对单个包或应用执行命令             |

铁律：

- 所有回复和思考过程都必须使用中文。
- 不绕过根脚本直接调用 `tsc` / `vite` / `electron-vite`，除非是在包内排查问题且不改动产物。
- 构建产物（`dist`、`out`、`release`、`coverage`）不参与 lint，也不入库；工程规范位于 `.trae/rules/`，随仓库入库并交给 prettier 统一格式。
- 任务收尾必须自检：`pnpm run lint` + `pnpm test`；涉及构建链路再补 `pnpm build`。

## 依赖与版本

- 包管理器只用 pnpm（>=9），Node >= 20，仓库为 `type: module`。
- 新增依赖使用 `pnpm add <包> --filter <包名>`；根依赖只放工具链（eslint / prettier / typescript / vite / vitest 等）。
- 需要 postinstall 的依赖必须在 `pnpm-workspace.yaml` 的 `allowBuilds` 中显式登记，否则安装产物不完整。
- 跨包引用写 workspace 包名（如 `@repo/shared`），不用相对路径穿透到其他包。

## Git 提交

- 遵循 Conventional Commits：`type(scope): subject`，`type` 取 feat / fix / docs / style / refactor / test / chore。
- `commit-msg` 钩子由 commitlint 校验格式；`pre-commit` 钩子由 lint-staged 对暂存文件执行 `eslint --fix` 与 `prettier --write`。
- 提交信息用中文描述"为什么"改动，不求长，但要能自解释。
- 不通过 `--no-verify` 绕过钩子；钩子失败先修问题。
- 未经用户明确要求，不执行 `git commit` 与 `git push`。

## 子规范索引

三份子规范配置了 `globs`，改动命中下列范围时自动生效；未命中时按本表主动读取后再动手，不凭记忆行动：

| 改动范围                                             | 规范文件                        |
| ---------------------------------------------------- | ------------------------------- |
| 后端接口、路由、鉴权、数据层、SSE、LLM 工具          | `.trae/rules/backend-design.md` |
| Electron 主进程、预加载、IPC、渲染进程组件、样式体系 | `.trae/rules/desktop-design.md` |
| TypeScript / Vue / Less 写法、命名、注释、单元测试   | `.trae/rules/code-style.md`     |

规范调整时只改 `.trae/rules/` 下对应文件，保持单一来源；三份子规范冲突时以总纲与更具体的那份为准。

# 注意事项

- 每次对话结束后必须将对话记录追加到 `.HISTORY/` 目录下，文件名格式为 `YYYY-MM-DD.md`。

# 技能调用

执行任务时，必须调用 `ask-matt` 技能获取适合的技能进行调用，比如以下几个技能是必须调用的：任务开始前调用 `grill-with-docs` 技能，编码时调用 `codebase-design` 技能，测试时调用 `code-review` 和 `tdd` 技能。
