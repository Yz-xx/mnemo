---
name: setup-matt-pocock-skills
description: '为工程类技能配置此仓库：设置它的议题跟踪器（issue tracker）、分诊标签词汇（triage label vocabulary）与领域文档布局。在首次使用其他工程类技能之前运行一次。'
disable-model-invocation: true
---

# 设置 Matt Pocock 的技能

搭建工程类技能所假设的按仓库（per-repo）配置：

- **议题跟踪器（issue tracker）**：议题放在哪里（默认 GitHub；本地 markdown 开箱即用也受支持）
- **分诊标签（triage labels）**：用于五个规范分诊角色的字符串
- **领域文档**：`CONTEXT.md` 和 ADR 放在哪里，以及读取它们的消费方规则

这是一个提示驱动的技能，不是一个确定性的脚本。先探索，呈现你发现的东西，与用户确认，然后再写。

## 流程

### 1. 探索

查看当前仓库以了解它的起始状态。有什么就读什么；不要假设：

- `git remote -v` 和 `.git/config`：这是一个 GitHub 仓库吗？是哪个？
- 仓库根目录的 `AGENTS.md` 和 `CLAUDE.md`：两者中是否有一个存在？其中是否已经有 `## Agent skills` 小节？
- 仓库根目录的 `CONTEXT.md` 和 `CONTEXT-MAP.md`
- `docs/adr/` 以及任何 `src/*/docs/adr/` 目录
- `docs/agents/`：此技能先前的输出是否已经存在？
- `.scratch/`：一个表明本地 markdown 议题跟踪器约定已在使用的迹象
- `triage` 技能是否已安装？（一个与这个技能并列的 `triage` 技能文件夹，或者你的可用技能中的 `triage`。）这决定 B 部分是否运行。
- 单体仓库（monorepo）信号：一个 `pnpm-workspace.yaml`、`package.json` 里的 `workspaces` 字段，或者一个内容充实、自带 `src/` 的 `packages/*`。这些只出现在真正大型的多包仓库中；它们的缺席意味着单上下文（single-context），而几乎每个仓库都是这样。

### 2. 呈现发现并提问

总结哪些存在、哪些缺失。然后按顺序处理各个部分。一个部分、一个答复，然后进入下一个。

每个部分都以推荐的答案开头，这样用户一个词就能接受它。只有当选择确实有分支时才给一行解释；当探索已经把它确定下来时，就完全跳过该部分（`triage` 未安装时跳过 B 部分，没有单体仓库时跳过 C 部分）。

**A 部分：议题跟踪器。**

> 解释：所谓 "议题跟踪器" 就是此仓库的议题所存放的地方。像 `to-tickets`、`triage` 和 `to-spec` 这样的技能会读写它。它们需要知道是调用 `gh issue create`、在 `.scratch/` 下写一个 markdown 文件，还是遵循你描述的其他某种工作流。请选择你实际用来跟踪此仓库工作的地方。

默认立场：这些技能是为 GitHub 设计的。如果某个 `git remote` 指向 GitHub，就提议它。如果某个 `git remote` 指向 GitLab（`gitlab.com` 或自托管主机），就提议 GitLab。否则（或者用户偏好如此），提供：

- **GitHub**：议题存放在仓库的 GitHub Issues 里（使用 `gh` CLI）
- **GitLab**：议题存放在仓库的 GitLab Issues 里（使用 [`glab`](https://gitlab.com/gitlab-org/cli) CLI）
- **本地 markdown**：议题作为文件存放在此仓库的 `.scratch/<feature>/` 下（适合个人项目或没有远程仓库的仓库）
- **其他**（Jira、Linear 等）：请用户用一段话描述工作流；技能会把它记录为自由形式的文字

把选择记录在 `docs/agents/issue-tracker.md` 里。GitHub 和 GitLab 模板带有一个 "以 PR 作为请求面" 的开关，默认**关闭**。保持关闭，不要去提它：想让外部 PR 进入分诊队列的用户，日后可以在文件里把它打开。

**B 部分：分诊标签词汇。** 如果 `triage` 技能未安装（探索已经告诉你），就完全跳过这一部分，因为未安装的技能不需要标签。

如果它已安装，就只问一个问题：

> 你想保留默认的分诊标签吗？（推荐：**是**）

默认值是五个规范角色，每个标签字符串与其名称相同：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。回答**是**时，就照原样写。只有当用户说不，通常是因为他们的跟踪器已经用了别的名字（例如用 `bug:triage` 代表 `needs-triage`），才收集这些覆盖项，好让 `triage` 应用既有的标签而不是创建重复的。

**C 部分：领域文档。** 默认**单上下文**（仓库根目录一个 `CONTEXT.md` + `docs/adr/`）。这适合几乎每个仓库；不用问就直接写。

只有当探索发现了单体仓库信号时，才提供**多上下文**（根目录一个 `CONTEXT-MAP.md`，指向每个上下文各自的 `CONTEXT.md` 文件）。然后确认他们想要哪种布局。

### 3. 确认并编辑

向用户展示以下内容的草稿：

- 要添加到正在编辑的 `CLAUDE.md` / `AGENTS.md` 其中之一里的 `## Agent skills` 块（选择规则见第 4 步）
- `docs/agents/issue-tracker.md`、`docs/agents/domain.md` 和 `docs/agents/triage-labels.md` 的内容（最后一个只在 `triage` 已安装时）

让他们在你写入之前编辑。

### 4. 写入

**挑选要编辑的文件：**

- 如果 `CLAUDE.md` 存在，就编辑它。
- 否则如果 `AGENTS.md` 存在，就编辑它。
- 如果两者都不存在，问用户要创建哪一个；不要替他们选。

当 `CLAUDE.md` 已经存在时，绝不创建 `AGENTS.md`（反之亦然）；始终编辑已经存在的那一个。

如果选定的文件里已经存在 `## Agent skills` 块，就就地更新其内容，而不是追加一个重复的。不要覆盖用户对周围小节所做的编辑。

该块：

```markdown
## Agent skills

### Issue tracker

[one-line summary of where issues are tracked]. See `docs/agents/issue-tracker.md`.

### Triage labels

[one-line summary of the label vocabulary]. See `docs/agents/triage-labels.md`.

### Domain docs

[one-line summary of layout: "single-context" or "multi-context"]. See `docs/agents/domain.md`.
```

只有当 `triage` 已安装且 B 部分运行了，才包含 `### Triage labels` 子块并写入 `docs/agents/triage-labels.md`。否则，两者都省略。

然后以这个技能文件夹里的种子模板为起点，写入那些文档文件：

- [issue-tracker-github.md](./issue-tracker-github.md)：GitHub 议题跟踪器
- [issue-tracker-gitlab.md](./issue-tracker-gitlab.md)：GitLab 议题跟踪器
- [issue-tracker-local.md](./issue-tracker-local.md)：本地 markdown 议题跟踪器
- [triage-labels.md](./triage-labels.md)：标签映射（仅在 `triage` 已安装时）
- [domain.md](./domain.md)：领域文档消费方规则 + 布局

对于 "其他" 议题跟踪器，根据用户的描述从零写 `docs/agents/issue-tracker.md`。

### 5. 完成

告诉用户设置已完成，以及现在有哪些工程类技能会从这些文件读取。提一下他们日后可以直接编辑 `docs/agents/*.md`；只有当想切换议题跟踪器或从零重来时才需要重新运行这个技能。
