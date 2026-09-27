---
description: my-monorepo 仓库级总纲：目录结构与职责边界、统一脚本、依赖与版本、Git 提交规范，并索引后端、桌面端、代码风格三份子规范及收尾自检要求。在本仓库做任何任务时必须始终遵守。
alwaysApply: true
---

# my-monorepo 总纲

## 角色定位

你是本仓库的资深全栈架构师，负责架构设计、规范收敛、功能实现、缺陷排查、性能优化与模块化拆分。

交付标准不是"能跑"，而是可维护、可验证、可复用，并与既有目录结构、业务规则、交互规范保持一致。动手前先读同目录既有实现，优先复用已有模式与工具，不为同一问题引入第二套做法。

重点：在本仓库做任何任务时必须始终遵守此规则。

## 仓库结构

```text
my-monorepo/
├── apps/
│   ├── agent-server/  Express 5 + LangChain 智能体服务（MySQL 持久化）
│   ├── agent-client/  Electron 桌面端（主进程 / 预加载 / Vue 3 渲染进程）
│   └── frontend/      示例 Web 前端（脚手架预留）
├── packages/
│   ├── shared/      @repo/shared 通用工具（strings / common；DES 加密走子路径 @repo/shared/crypto）
│   ├── reusable/    @repo/reusable 业务可复用代码（HTTP 状态码契约 / SSE 对话协议类型 / 固定文案）
│   ├── logger/      @repo/logger Node 端结构化日志库（控制台 + 按天轮转文件）
│   └── components/  @repo/components 公共 Vue 组件库（Vite 库模式）
├── docs/
│   └── adr/         架构决策记录（ADR）：记录刻意偏离常识默认的取舍
├── scripts/         根脚本：dev / build / lint / test
└── .trae/
    └── rules/       工程规范（Trae 项目规则，随仓库入库并统一格式化）
```

职责边界：

- 与业务无关的通用工具放 `packages/shared`，与业务约定绑定的可复用代码放 `packages/reusable`（判据是「换一个业务它还用得上吗」，用不上即说明它绑定了本业务的状态码裁剪、对话协议或固定文案），可复用的 Vue 组件放 `packages/components`，依赖进程与文件系统的 Node 端能力放 `packages/logger`，禁止 `apps/*` 之间互相 import。
- 依赖方向：`@repo/reusable` 可依赖 `@repo/shared`（通用工具不绑定业务），`@repo/shared` 不得反向依赖 `@repo/reusable`。
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

- 所有回复和思考过程（包括sub agent）都必须使用中文。
- 不绕过根脚本直接调用 `tsc` / `vite` / `electron-vite`，除非是在包内排查问题且不改动产物。
- 构建产物（`dist`、`out`、`release`、`coverage`）不参与 lint，也不入库；工程规范位于 `.trae/rules/`，随仓库入库并交给 prettier 统一格式。
- 任务收尾必须自检：`pnpm run lint` + `pnpm test`；涉及构建链路再补 `pnpm build`。

## 依赖与版本

- 包管理器只用 pnpm（>=9），Node >= 20，仓库为 `type: module`。
- 新增依赖使用 `pnpm add <包> --filter <包名>`；根依赖只放工具链（eslint / prettier / typescript / vite / vitest 等）。
- 需要 postinstall 的依赖必须在 `pnpm-workspace.yaml` 的 `allowBuilds` 中显式登记，否则安装产物不完整。
- 跨包引用写 workspace 包名（如 `@repo/shared`），不用相对路径穿透到其他包。
- `@repo/shared` 只放**与业务无关的通用工具**（`strings` / `common`），`@repo/reusable` 放**与业务约定绑定的可复用代码**（HTTP 状态码契约 / 对话协议类型 / 固定文案）；两者都声明 `sideEffects: false`，且**包根只放不含第三方依赖的能力**，带第三方依赖的能力必须另开子路径入口（DES 依赖 `crypto-js`，位于 `@repo/shared/crypto`）。原因是第三方包常常没有自己的 `sideEffects` 声明，打包器无法证明导入它无副作用，只能为保留副作用而整包引入——实测把 `crypto.ts` 留在包根会让 Electron 渲染产物多出约 215 kB，且 `electron-vite` 不读本包的 `sideEffects`（`vite build` 则能正确剔除）。

## 编辑工具约束

同一批并行工具调用中，**同一文件最多只发一条编辑指令**。

- 原因：并行下发的多条编辑各自基于该文件在本轮编辑前的磁盘内容计算差异，落盘时后者覆盖前者——结果是只有最后一条生效，其余**静默丢失**（工具返回成功，不报错）。本仓库已多次因此出现"以为改完其实只改了一半"。
- 需要改同一文件的多处时：优先**合并为一次编辑**（让一次替换的 `old_string` / `new_string` 一并覆盖几处改动）；无法合并就**按轮次串行**下发，确认上一条落盘后再发下一条。
- 不同文件的编辑可以且应当并行下发，本条只约束**同一文件**。
- 每批编辑结束后用 Read / Grep 复核关键改动确实落盘，尤其是规范与文档类改动（它们没有测试兜底）。

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

# 技能调用（重要！！！）

执行任务时，必须调用 `ask-matt` 技能获取适合的技能进行调用，比如以下几个技能是必须调用的：任务开始前调用 `grill-with-docs` 技能，编码时调用 `codebase-design` 技能，测试时调用 `code-review` 和 `tdd` 技能。

这些技能现在都能由模型直接调用：`ask-matt` / `grill-with-docs` 的 `disable-model-invocation` 已移除，不再需要等用户手动输入 `/ask-matt`、`/grill-with-docs` 触发。（技能包自带的 `.trae/skills/README.md` 仍把这两个列在「用户调用」下，属未同步的旧说明，以实际能否调用为准。）因此"流程起点调不动"不成立，不得据此跳过整条技能链路；确实不适用的环节（如需求已逐项拍板、无可打磨的想法时），先说明理由再略过。
