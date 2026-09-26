# 议题跟踪器：GitHub

此仓库的议题与规格以 GitHub issue 的形式存在。所有操作都使用 `gh` CLI。

## 约定

- **创建议题**：`gh issue create --title "..." --body "..."`。多行正文使用 heredoc。
- **读取议题**：`gh issue view <number> --comments`，用 `jq` 过滤评论并同时获取标签。
- **列出议题**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，并配以恰当的 `--label` 和 `--state` 过滤。
- **评论议题**：`gh issue comment <number> --body "..."`
- **添加 / 移除标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **关闭**：`gh issue close <number> --comment "..."`

从 `git remote -v` 推断仓库；`gh` 在克隆内运行时会自动这么做。

## 以拉取请求作为分诊面

**以 PR 作为请求面：否。** _（如果此仓库把外部 PR 当作功能请求处理，就设为 `yes`；`/triage` 会读这个开关。）_

当设为 `yes` 时，PR 会与议题走同一套标签和状态，使用对应的 `gh pr`：

- **读取 PR**：`gh pr view <number> --comments`，以及用 `gh pr diff <number>` 获取差异。
- **列出待分诊的外部 PR**：`gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`，然后只保留 `authorAssociation` 为 `CONTRIBUTOR`、`FIRST_TIME_CONTRIBUTOR` 或 `NONE` 的（丢掉 `OWNER`/`MEMBER`/`COLLABORATOR`）。
- **评论 / 打标签 / 关闭**：`gh pr comment`、`gh pr edit --add-label`/`--remove-label`、`gh pr close`。

GitHub 的议题和 PR 共用同一个编号空间，所以一个裸的 `#42` 可能是两者之一：先用 `gh pr view 42` 解析，再回退到 `gh issue view 42`。

## 当某个技能说 "发布到议题跟踪器" 时

创建一个 GitHub issue。

## 当某个技能说 "获取相关工单" 时

运行 `gh issue view <number> --comments`。

## 寻路操作（Wayfinding operations）

由 `/wayfinder` 使用。**地图（map）** 是一个议题，**子（child）** 议题作为工单。

- **地图**：一个标签为 `wayfinder:map` 的单个议题，承载记录 / 迄今决策 / 迷雾（Notes / Decisions-so-far / Fog）正文。`gh issue create --label wayfinder:map`。
- **子工单**：一个作为 GitHub 子议题（sub-issue）链接到地图的议题（对子议题端点调用 `gh api`）。在未启用子议题的地方，把子议题加入地图正文里的一个任务列表，并在子议题正文顶部放 `Part of #<map>`。标签：`wayfinder:<type>`（`research`/`prototype`/`grilling`/`task`）。一旦被认领，该工单就被指派给驱动的开发者。
- **阻塞**：GitHub 的**原生议题依赖**，即规范且 UI 可见的表达。用 `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>` 添加一条边，其中 `<blocker-db-id>` 是阻塞者的数字**数据库 id**（`gh api repos/<owner>/<repo>/issues/<n> --jq .id`，_不是_ `#number` 或 `node_id`）。GitHub 会报告 `issue_dependencies_summary.blocked_by`（仅未关闭的阻塞者，即实际的闸门）。在依赖不可用的地方，回退到在子议题正文顶部的 `Blocked by: #<n>, #<n>` 一行。当每个阻塞者都已关闭时，一个工单就被解除阻塞。
- **前沿查询（Frontier query）**：列出地图未关闭的子议题（`gh issue list --state open`，范围限定为地图的子议题 / 任务列表），丢弃任何有未关闭阻塞者（`issue_dependencies_summary.blocked_by > 0`，或 `Blocked by` 行里有一个未关闭的议题）或有指派者的；按地图顺序排在最前的胜出。
- **认领**：`gh issue edit <n> --add-assignee @me`，本次会话的第一次写入。
- **解决**：`gh issue comment <n> --body "<answer>"`，然后 `gh issue close <n>`，再把一个上下文指针（要点 gist + 链接）追加到地图的记录 / 迄今决策 / 迷雾（Notes / Decisions-so-far / Fog）。
