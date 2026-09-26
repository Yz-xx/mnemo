---
name: code-review
description: '审查自某个固定基点（fixed point，提交、分支、标签或 merge-base）以来的变更，沿两条轴进行：标准（Standards，代码是否遵循本仓库有文档记录的编码标准？）与规格（Spec，代码是否与来源议题/规格所要求的一致？）。在并行的 sub-agent 中运行两项审查并并排报告。当用户想审查一个分支、一个 PR、进行中的变更，或要求 "review since X" 时使用。'
---

对 `HEAD` 与用户提供的固定基点之间的差异做双轴审查：

- **标准（Standards）**：代码是否符合本仓库有文档记录的编码标准？
- **规格（Spec）**：代码是否忠实实现了来源议题 / 规格？

两条轴都作为**并行的 sub-agent** 运行，这样它们不会污染彼此的上下文，随后本技能汇总它们的发现。

议题跟踪器应该已经提供给你了。如果 `docs/agents/issue-tracker.md` 缺失，告诉用户运行 `/setup-matt-pocock-skills`。

## 流程

### 1. 钉住固定基点

用户所说的就是固定基点（一个提交 SHA、分支名、标签、`main`、`HEAD~5` 等）。如果他们没有指定，就向他们索要。

把差异命令抄录一次：`git diff <fixed-point>...HEAD`（三点，所以比较是相对 merge-base 进行的）。同时通过 `git log <fixed-point>..HEAD --oneline` 记下提交列表。

在继续之前，确认固定基点能解析（`git rev-parse <fixed-point>`）且差异非空。错误的 ref 或空的差异应该在这里失败，而不是在两个并行 sub-agent 内部失败。

### 2. 确定规格来源

按以下顺序寻找来源规格：

1. 提交消息里的议题引用（`#123`、`Closes #45`、GitLab `!67` 等），通过 `docs/agents/issue-tracker.md` 里的工作流获取。
2. 用户作为参数传入的路径。
3. `docs/`、`specs/` 或 `.scratch/` 下与分支名或特性匹配的规格文件。
4. 如果什么都没找到，询问用户规格在哪里。如果他们说不存在，**Spec** sub-agent 会跳过并报告"没有可用规格"。

### 3. 确定标准来源

仓库中任何记录代码该怎么写的东西，例如 `CODING_STANDARDS.md` 或 `CONTRIBUTING.md`。

无论仓库记录了什么，Standards 这条轴总是额外携带下面的**坏味道基线（smell baseline）**：一组固定的 Fowler 代码坏味道（_Refactoring_，第 3 章），即使仓库什么都没记录也适用。有两条规则约束它：

- **仓库覆盖基线。** 有文档记录的仓库标准总是胜出；当它认可了基线会标记的东西时，抑制该坏味道。
- **始终是判断性的取舍。** 每个坏味道都是一条贴了标签的启发式（"可能的 Feature Envy"），绝不是硬性违规。与此处的任何标准一样，凡是工具已经强制执行的，就跳过。

每个坏味道的读法是*它是什么* → _怎么修_；把它与差异对照：

- **Mysterious Name（神秘的名字）**：一个函数、变量或类型的名字没能揭示它做什么或存什么。→ 重命名它；如果想不到一个诚实的名字，说明设计含混不清。
- **Duplicated Code（重复代码）**：同一段逻辑形状在本次变更的一个以上代码块（hunk）或文件里出现。→ 抽出共享的形状，让两处都调用它。
- **Feature Envy（依恋情结）**：一个方法访问另一个对象的数据比访问自己的还多。→ 把该方法搬到它所依恋的数据上。
- **Data Clumps（数据泥团）**：同样那几个字段或参数老是结伴同行（一个想要诞生的类型）。→ 把它们捆成一个类型，传那个类型。
- **Primitive Obsession（基本类型偏执）**：用一个基本类型或字符串顶替一个配得上独立类型的领域概念。→ 给这个概念它自己的小类型。
- **Repeated Switches（重复的 switch）**：同一个类型上的同一种 `switch`/`if` 级联在整次变更中反复出现。→ 用多态替换，或者用两处共享的一张贴映射。
- **Shotgun Surgery（霰弹式修改）**：一次逻辑变更迫使你在差异中的许多文件里零散地编辑。→ 把一起变化的东西聚到一个模块里。
- **Divergent Change（发散式变化）**：一个文件或模块因几个互不相关的原因被编辑。→ 拆开，让每个模块只为一个原因而变化。
- **Speculative Generality（夸夸其谈通用性）**：为规格并不存在的需求添加抽象、参数或钩子。→ 删掉它；先内联回去，直到出现真实需求。
- **Message Chains（过长的消息链）**：调用方不该依赖的长串 `a.b().c().d()` 导航。→ 把这次走链藏在第一个对象的一个方法后面。
- **Middle Man（中间人）**：一个类或函数基本只是继续往下转发。→ 砍掉它，直接调用真正的目标。
- **Refused Bequest（被拒绝的遗赠）**：一个子类或实现者忽略或覆盖了它继承来的大部分东西。→ 放弃继承，改用组合。

### 4. 并行启动两个 sub-agent

**Standards sub-agent 的提示词**应包含：

- 完整的差异命令与提交列表。
- 你在第 3 步找到的标准来源文件列表，**外加第 3 步的坏味道基线**全文粘贴（该 sub-agent 没有其他途径访问它）。
- 简报：\"Report, per file/hunk where relevant, (a) every place the diff violates a documented standard: cite the standard (file + the rule); and (b) any baseline smell you spot: name it and quote the hunk. Distinguish hard violations from judgement calls: documented-standard breaches can be hard, but baseline smells are always judgement calls, and a documented repo standard overrides the baseline. Skip anything tooling enforces. Under 400 words.\"（中文说明：按相关文件/代码块报告：(a) 差异违反有文档标准之处，引用该标准（文件 + 规则）；(b) 你发现的任何基线坏味道，说出名字并引用该代码块。区分硬性违规与判断性取舍：有文档标准的违反可以是硬性的，但基线坏味道始终是判断性的，且有文档的仓库标准覆盖基线。凡是工具强制执行的都跳过。400 字以内。）

**Spec sub-agent 的提示词**应包含：

- 差异命令与提交列表。
- 规格的路径或已获取的内容。
- 简报：\"Report: (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote the spec line for each finding. Under 400 words.\"（中文说明：报告：(a) 规格要求但缺失或不完整的需求；(b) 差异中未被要求的行为（范围蔓延）；(c) 看起来已实现、但实现有误的需求。每条发现都引用规格中的原句。400 字以内。）

如果规格缺失，跳过 Spec sub-agent，并在最终报告中注明这一点。

### 5. 汇总

把两份报告分别放在 `## Standards` 和 `## Spec` 标题下，原样呈现或略作清理。**不要**合并或重排发现，因为两条轴是刻意分开的（见 _为什么是两条轴_）。

最后用一句话总结：每条轴的发现总数，以及*每条轴内部*最严重的问题（如果有）。不要跨轴挑出一个总冠军：那正是这种分离旨在防止的重排。

## 为什么是两条轴

一次变更可能通过一条轴而在另一条上失败：

- 遵循每一项标准但实现了错误东西的代码 → **标准通过，规格失败。**
- 完全按议题要求做但破坏了项目约定的代码 → **规格通过，标准失败。**

分别报告它们，能防止一条轴掩盖另一条。
