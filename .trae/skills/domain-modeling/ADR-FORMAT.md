# ADR 格式

ADR 存放在 `docs/adr/` 中，使用顺序编号：`0001-slug.md`、`0002-slug.md` 等。

惰性地创建 `docs/adr/` 目录：只在需要第一个 ADR 时创建。

## 模板

```md
# {Short title of the decision}

{1-3 sentences: what's the context, what did we decide, and why.}
```

就这样。一份 ADR 可以只有一段。价值在于记录*某*项决策被做出了以及*为什么*，而不在于把各章节填满。

## 可选章节

只有当它们带来真实价值时才包含这些。多数 ADR 不会需要它们。

- **Status** frontmatter（`proposed | accepted | deprecated | superseded by ADR-NNNN`）：当决策被重新审视时有用
- **Considered Options（考虑过的选项）**：只有当被否决的备选方案值得记住时
- **Consequences（后果）**：只有当非显而易见的下游影响需要被点明时

## 编号

扫描 `docs/adr/`，找出已存在的最大编号，加一。

## 何时提供 ADR

以下三条必须全部为真：

1. **难以逆转**：以后改变主意的代价有意义
2. **脱离上下文会让人意外**：未来的读者会看着代码纳闷"他们到底为什么这么做？"
3. **真实取舍的产物**：确实存在其他可选方案，而你出于具体理由选了这一个

如果一项决策容易逆转，就跳过它：你到时候反悔就是了。如果它不让人意外，没人会纳闷为什么。如果没有真正的备选方案，那就除了"我们做了显而易见的事"之外没什么可记录。

### 什么够格

- **架构形态。** "We're using a monorepo."（中文：我们在用一个单体仓库。）"The write model is event-sourced, the read model is projected into Postgres."（中文：写模型是事件溯源的，读模型投影进 Postgres。）
- **上下文之间的集成模式。** "Ordering and Billing communicate via domain events, not synchronous HTTP."（中文：Ordering 与 Billing 通过领域事件通信，而非同步 HTTP。）
- **携带锁定效应的技术选型。** 数据库、消息总线、鉴权提供方、部署目标。不是每一个库：只是那些要换掉得花一个季度的。
- **边界与范围决策。** "Customer data is owned by the Customer context; other contexts reference it by ID only."（中文：客户数据由 Customer 上下文拥有；其他上下文只按 ID 引用它。）明确的"不"与"是"同样有价值。
- **对显而易见路径的刻意偏离。** "We're using manual SQL instead of an ORM because X."（中文：我们之所以用原生 SQL 而不用 ORM，是因为 X。）任何一位通情达理的读者会假设相反的事。这些能阻止下一位工程师去"修复"某种本来就有意为之的东西。
- **代码中不可见的约束。** "We can't use AWS because of compliance requirements."（中文：因为合规要求，我们无法用 AWS。）"Response times must be under 200ms because of the partner API contract."（中文：因为合作方的 API 合同，响应时间必须在 200ms 以内。）
- **当否决理由并不显而易见时，记下被否决的备选方案。** 如果你考虑过 GraphQL 而出于微妙的理由选了 REST，就把它记下来；否则六个月后又有人会提议 GraphQL。
