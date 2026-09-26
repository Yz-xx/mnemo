# 议题跟踪器：GitLab

此仓库的议题与规格以 GitLab issue 的形式存在。所有操作都使用 [`glab`](https://gitlab.com/gitlab-org/cli) CLI。

## 约定

- **创建议题**：`glab issue create --title "..." --description "..."`。多行描述使用 heredoc。传入 `--description -` 可打开编辑器。
- **读取议题**：`glab issue view <number> --comments`。用 `-F json` 获得机器可读的输出。
- **列出议题**：`glab issue list -F json`，配以恰当的 `--label` 过滤。
- **评论议题**：`glab issue note <number> --message "..."`。GitLab 把评论称作 "notes"。
- **添加 / 移除标签**：`glab issue update <number> --label "..."` / `--unlabel "..."`。多个标签可以用逗号分隔，也可以重复该 flag。
- **关闭**：`glab issue close <number>`。`glab issue close` 不接受关闭评论，所以先用 `glab issue note <number> --message "..."` 发布说明，再关闭。
- **合并请求（merge request）**：GitLab 把 PR 称作 "merge requests"。使用 `glab mr create`、`glab mr view`、`glab mr note` 等，形状与 `gh pr ...` 相同，只是用 `mr` 代替 `pr`、用 `note`/`--message` 代替 `comment`/`--body`。

从 `git remote -v` 推断仓库；`glab` 在克隆内运行时会自动这么做。

## 以合并请求作为分诊面

**以 MR 作为请求面：否。** _（如果此仓库把外部合并请求当作功能请求处理，就设为 `yes`；`/triage` 会读这个开关。）_

当设为 `yes` 时，MR 会与议题走同一套标签和状态，使用对应的 `glab mr`：

- **读取 MR**：`glab mr view <number> --comments`，以及用 `glab mr diff <number>` 获取差异。
- **列出待分诊的外部 MR**：`glab mr list -F json`，然后只保留作者不是项目成员/拥有者的 MR（贡献者的 MR，而不是维护者正在进行的工作）。
- **评论 / 打标签 / 关闭**：`glab mr note`、`glab mr update --label`/`--unlabel`、`glab mr close`。

与 GitHub 不同，GitLab 为议题和 MR 分别编号，所以一旦你知道维护者指的是哪个面，`#42` 就是明确的。

## 当某个技能说 "发布到议题跟踪器" 时

创建一个 GitLab issue。

## 当某个技能说 "获取相关工单" 时

运行 `glab issue view <number> --comments`。

## 寻路操作（Wayfinding operations）

由 `/wayfinder` 使用。**地图（map）** 是一个议题，**子（child）** 议题作为工单。

- **地图**：一个标签为 `wayfinder:map` 的单个议题，承载记录 / 迄今决策 / 迷雾（Notes / Decisions-so-far / Fog）正文。`glab issue create --label wayfinder:map`。（在拥有原生 epic 的 GitLab 层级上，一个 epic 可以代替它承载地图；而一个带标签的议题在任何地方都管用。）
- **子工单**：一个在其描述顶部带有 `Part of #<map>`、并带有标签 `wayfinder:<type>`（`research`/`prototype`/`grilling`/`task`）的议题。一旦被认领，该工单就被指派给驱动的开发者。
- **阻塞**：GitLab 的**原生阻塞链接**，即规范且 UI 可见的表达。用 `/blocked_by #<n>` 快捷操作添加，以一条 note 发布（`glab issue note <child> --message "/blocked_by #<blocker>"`）。原生阻塞链接是 Premium/Ultimate 功能；在免费层级上（或不可用的地方）回退到描述顶部的 `Blocked by: #<n>, #<n>` 一行。当每个阻塞者都已关闭时，一个工单就被解除阻塞。
- **前沿查询**：`glab issue list -F json`，范围限定为地图的子议题，丢弃任何有未关闭阻塞者的：一个指向未关闭议题的原生 `blocked_by` 链接（`glab api projects/:id/issues/:iid/links`），或 `Blocked by` 行里有一个未关闭的议题，或有指派者的；按地图顺序排在最前的胜出。
- **认领**：`glab issue update <n> --assignee @me`，本次会话的第一次写入。
- **解决**：`glab issue note <n> --message "<answer>"`，然后 `glab issue close <n>`，再把一个上下文指针（要点 gist + 链接）追加到地图的记录 / 迄今决策 / 迷雾（Notes / Decisions-so-far / Fog）。
