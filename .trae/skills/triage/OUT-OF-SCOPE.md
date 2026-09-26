# 超出范围知识库

仓库中的 `.out-of-scope/` 目录存储被拒功能请求的持久记录。它有两个用途：

1. **组织记忆**：记录某项功能为何被拒，这样在议题关闭后理由不会丢失
2. **去重**：当新来的议题与先前的一次拒绝相符时，技能可以浮现出先前的决定，而不必重新争论

## 目录结构

```
.out-of-scope/
├── dark-mode.md
├── plugin-system.md
└── graphql-api.md
```

每个**概念**一个文件，而不是每个议题一个文件。请求同一内容的多个议题会归到同一个文件下。

## 文件格式

文件应当以轻松、易读的风格撰写，更像一份简短的设计文档，而不是一条数据库记录。使用段落、代码示例和例子，让初次接触它的人也能清楚理解并受益于这些理由。

````markdown
# Dark Mode

This project does not support dark mode or user-facing theming.

## Why this is out of scope

The rendering pipeline assumes a single color palette defined in
`ThemeConfig`. Supporting multiple themes would require:

- A theme context provider wrapping the entire component tree
- Per-component theme-aware style resolution
- A persistence layer for user theme preferences

This is a significant architectural change that doesn't align with the
project's focus on content authoring. Theming is a concern for downstream
consumers who embed or redistribute the output.

```ts
// The current ThemeConfig interface is not designed for runtime switching:
interface ThemeConfig {
  colors: ColorPalette; // single palette, resolved at build time
  fonts: FontStack;
}
```
````

## Prior requests

- #42: "Add dark mode support"
- #87: "Night theme for accessibility"
- #134: "Dark theme option"

```

### 命名文件

为概念取一个简短、有描述性的 kebab-case 名称：`dark-mode.md`、`plugin-system.md`、`graphql-api.md`。这个名称应当足够可辨识，让人浏览目录时不必打开文件就能明白什么被拒了。

### 撰写理由

理由应当有实质内容：不是“我们不想要这个”，而是为什么。好的理由会引用：

- 项目范围或理念（“本项目聚焦于 X；主题化是下游的事”）
- 技术约束（“支持这个需要 Y，而它与我们的 Z 架构冲突”）
- 战略决策（“我们选择用 A 而不是 B，因为……”）

理由应当经久耐用。避免引用临时状况（“我们现在太忙了”）；那些不是真正的拒绝，而是推迟。

## 何时检查 `.out-of-scope/`

在分诊期间（第 1 步：收集上下文），阅读 `.out-of-scope/` 中的所有文件。评估一个新议题时：

- 检查该请求是否与一个已有的超出范围概念相符
- 匹配是按概念相似度，而不是关键词：“night theme”会匹配 `dark-mode.md`
- 如果有匹配，就向维护者浮现它：“这与 `.out-of-scope/dark-mode.md` 相似。我们之前拒绝过它，因为[理由]。你现在还这么看吗？”

维护者可以：

- **确认**：新议题会被加到已有文件的“Prior requests”列表中，然后关闭
- **重新考虑**：删除或更新那个超出范围文件，议题则走正常分诊流程
- **不同意**：这些议题相关但不同，走正常分诊流程

## 何时写入 `.out-of-scope/`

只有当一项**enhancement**（不是 bug）被作为 `wontfix` *拒绝*时。这同样适用于 enhancement 类的 PR，和适用于议题完全一样：被拒的 PR 也记录在这里，免得同一个请求又作为全新代码回来。

当某事物是因为**已经实现**而被作为 `wontfix` 关闭时，**不要**写在这里。那是一个已构建的功能，不是被拒的功能；记录它会让去重检查被错误的拒绝污染。取而代之，关闭评论应指出该功能已经存在的位置。

流程：

1. 维护者判定某个功能请求超出范围
2. 检查是否已存在相符的 `.out-of-scope/` 文件
3. 如果有：把新议题追加到“Prior requests”列表
4. 如果没有：新建一个文件，包含概念名、决定、理由，以及第一条先前请求
5. 在议题上发布一条评论，解释该决定并提及那个 `.out-of-scope/` 文件
6. 用 `wontfix` 标签关闭议题

## 更新或删除超出范围的文件

如果维护者对某个先前被拒的概念改变了主意：

- 删除那个 `.out-of-scope/` 文件
- 技能无需重新打开旧议题；它们是历史记录
- 触发这次重新考虑的新议题走正常分诊流程
```
