# 领域文档

工程类技能在探索代码库时应当如何消费此仓库的领域文档。

## 探索之前，先读这些

- 仓库根目录的 **`CONTEXT.md`**，或者
- 仓库根目录的 **`CONTEXT-MAP.md`**（如果存在）：它为每个上下文指向一个 `CONTEXT.md`。读取每一个与你主题相关的。
- **`docs/adr/`**：读取触及你即将动手的区域的那些 ADR。在多上下文仓库中，还要检查 `src/<context>/docs/adr/` 里针对特定上下文的决策。

如果这些文件中有任何一个不存在，就**静默进行**。不要点出其缺席；不要提议预先创建它们。`/domain-modeling` 技能（经由 `/grill-with-docs` 和 `/improve-codebase-architecture` 到达）会在术语或决策真正被确定时按需惰性创建它们。

## 文件结构

单上下文仓库（大多数仓库）：

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

多上下文仓库（根目录存在 `CONTEXT-MAP.md`）：

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← system-wide decisions
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← context-specific decisions
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
```

## 使用词汇表的术语

当你的输出命名一个领域概念时（在议题标题、重构提案、假设、测试名称里），使用 `CONTEXT.md` 中定义的术语。不要滑向词汇表明确回避的同义词。

如果你需要的概念还不在词汇表里，那是个信号：要么你在发明项目不使用的语言（重新考虑），要么存在一个真实的缺口（为 `/domain-modeling` 记下它）。

## 标注 ADR 冲突

如果你的输出与既有 ADR 相矛盾，就明确呈现它，而不是默默覆盖：

> _与 ADR-0007（事件溯源订单）矛盾，但值得重新打开，因为…_
