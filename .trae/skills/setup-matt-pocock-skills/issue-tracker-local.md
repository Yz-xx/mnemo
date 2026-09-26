# 议题跟踪器：本地 Markdown

此仓库的议题与规格以 markdown 文件的形式存在于 `.scratch/` 中。

## 约定

- 每个功能一个目录：`.scratch/<feature-slug>/`
- 规格是 `.scratch/<feature-slug>/spec.md`
- 实现议题是每个工单一个文件，位于 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 开始编号，绝不使用单个合并的工单文件
- 分诊状态记录为每个议题文件顶部附近的 `Status:` 一行（角色字符串见 `triage-labels.md`）
- 评论与对话历史追加到文件底部、位于 `## Comments` 标题之下

## 当某个技能说 "发布到议题跟踪器" 时

在 `.scratch/<feature-slug>/` 下创建一个新文件（如需要就创建目录）。

## 当某个技能说 "获取相关工单" 时

读取所引用路径处的文件。用户通常会直接传入路径或议题编号。

## 寻路操作（Wayfinding operations）

由 `/wayfinder` 使用。**地图（map）** 是一个文件，每个工单对应一个**子（child）**文件。

- **地图**：`.scratch/<effort>/map.md`（记录 / 迄今决策 / 迷雾（Notes / Decisions-so-far / Fog）正文）。
- **子工单**：`.scratch/<effort>/issues/NN-<slug>.md`，从 `01` 开始编号，问题写在正文里。`Type:` 一行记录工单类型（`research`/`prototype`/`grilling`/`task`）；`Status:` 一行记录 `claimed`/`resolved`。
- **阻塞**：顶部附近的一行 `Blocked by: NN, NN`。当它列出的每个文件都是 `resolved` 时，一个工单就被解除阻塞。
- **前沿**：扫描 `.scratch/<effort>/issues/`，找出未关闭、未被阻塞且未被认领的文件；按编号排在最前的胜出。
- **认领**：在任何工作之前设置 `Status: claimed` 并保存。
- **解决**：把答案追加到 `## Answer` 标题之下，设置 `Status: resolved`，再把一个上下文指针（要点 gist + 链接）追加到 `map.md` 里地图的记录 / 迄今决策 / 迷雾（Notes / Decisions-so-far / Fog）。
