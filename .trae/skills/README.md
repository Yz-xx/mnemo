# 工程

我每天做代码工作时用的技能。

## 用户调用

只有你主动输入时才能触达（Claude Code：`disable-model-invocation: true`；Codex：`agents/openai.yaml` 中的 `policy.allow_implicit_invocation: false`）。

- **[ask-matt](./ask-matt/SKILL.md)**：询问哪种技能或流程适合你的情况。它是本仓库中用户调用技能的路由器。
- **[grill-with-docs](./grill-with-docs/SKILL.md)**：一场深度盘问（grilling）会话，同时构建你项目的领域模型，打磨术语并即时更新 `CONTEXT.md` 与 ADR。
- **[triage](./triage/SKILL.md)**：让议题（issue）在分诊角色的状态机中流转。
- **[improve-codebase-architecture](./improve-codebase-architecture/SKILL.md)**：扫描代码库中的深化机会，以可视化 HTML 报告呈现，然后对你选定的那一个进行深度盘问。
- **[setup-matt-pocock-skills](./setup-matt-pocock-skills/SKILL.md)**：为工程技能配置本仓库（议题跟踪器、分诊标签、领域文档布局）。每个仓库运行一次。
- **[to-spec](./to-spec/SKILL.md)**：把当前对话转成一份规格（spec）并发布到议题跟踪器。
- **[to-tickets](./to-tickets/SKILL.md)**：把任何计划、规格或对话拆成一组曳光弹（tracer bullet）工单，每张工单都声明自己的阻塞边（blocking edges），既可以写成本地文件中的文本，也可以是真实跟踪器上的原生阻塞链接。
- **[implement](./implement/SKILL.md)**：构建规格或工单集所描述的工作，在预先约定的接缝处驱动 `/tdd`，并在提交前用 `/code-review` 收尾。
- **[wayfinder](./wayfinder/SKILL.md)**：把一大块工作（超过单个 agent 会话所能承载的体量）规划为议题跟踪器上由决策工单组成的共享地图，一次解决一张，直到通往目的地的路径清晰可见。

## 模型调用

模型或用户均可触达（触发措辞丰富，好让模型能主动取用）。

- **[prototype](./prototype/SKILL.md)**：构建一次性原型来回答某个设计问题：单个可分享的 HTML 文件用于状态/逻辑，或者若干个可切换的 UI 变体。

- **[diagnosing-bugs](./diagnosing-bugs/SKILL.md)**：针对疑难缺陷与性能回归的严谨诊断循环：构建一个会因该缺陷变红的反馈回路 → 最小化 → 提出假设 → 插桩 → 修复 → 回归测试。
- **[research](./research/SKILL.md)**：针对高可信度的一手来源（primary sources）调研某个问题，并把发现记录为仓库中带引用的 Markdown 文件，以后台 agent 的方式运行。
- **[tdd](./tdd/SKILL.md)**：测试驱动开发（TDD），采用红-绿-重构（red-green-refactor）循环。一次一个垂直切片地构建功能或修复缺陷。
- **[domain-modeling](./domain-modeling/SKILL.md)**：主动构建并打磨项目的领域模型，通过挑战术语、用场景做压力测试，并即时更新 `CONTEXT.md` 与 ADR。
- **[codebase-design](./codebase-design/SKILL.md)**：设计深模块（deep module）的共享纪律与词汇：小接口、干净的接缝、通过接口即可测试。
- **[code-review](./code-review/SKILL.md)**：对自某个固定基点（fixed point）以来的差异做双轴审查：**标准（Standards）**（是否遵循仓库的编码标准，外加 Fowler 坏味道基线？）与**规格（Spec）**（是否忠实实现了来源议题/规格？），以并行的 sub-agent 运行。
- **[resolving-merge-conflicts](./resolving-merge-conflicts/SKILL.md)**：逐代码块（hunk）地处理进行中的 git merge 或 rebase 冲突，依据追溯到各方一手来源的意图（intent）来解决，然后完成该操作，绝不 `--abort`。
- **[wizard](./wizard/SKILL.md)**：生成一个交互式 bash 向导，引导人类完成只有他们才能执行的步骤：准备基础设施、设置凭据或 CI 机密、走查一个不熟悉的第三方仪表盘，或执行一次性的迁移或切换。
