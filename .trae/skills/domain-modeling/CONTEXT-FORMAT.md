# CONTEXT.md 格式

## 结构

```md
# {Context Name}

{One or two sentence description of what this context is and why it exists.}

## Language

**Order**:
{A one or two sentence description of the term}
_Avoid_: Purchase, transaction

**Invoice**:
A request for payment sent to a customer after delivery.
_Avoid_: Bill, payment request

**Customer**:
A person or organization that places orders.
_Avoid_: Client, buyer, account
```

## 规则

- **要有主见。** 当同一个概念存在多个词时，挑出最好的那个，把其余的列在 `_Avoid_` 下。
- **定义要紧凑。** 最多一两句话。定义它*是什么*，而不是它*做什么*。
- **只包含本项目上下文特有的术语。** 通用编程概念（超时、错误类型、工具模式）不属于其中，即便项目大量使用它们。在添加一个术语之前，问自己：这是一个本上下文独有的概念，还是一个通用编程概念？只有前者才够格。
- **在自然集群浮现时，把术语归到子标题下。** 如果所有术语都属于同一个内聚的领域，平铺一张清单也可以。

## 单上下文 vs 多上下文仓库

**单个上下文（多数仓库）：** 仓库根目录下一个 `CONTEXT.md`。

**多个上下文：** 仓库根目录下一个 `CONTEXT-MAP.md` 列出各个上下文、它们所在的位置，以及它们彼此之间的关系：

```md
# Context Map

## Contexts

- [Ordering](./src/ordering/CONTEXT.md): receives and tracks customer orders
- [Billing](./src/billing/CONTEXT.md): generates invoices and processes payments
- [Fulfillment](./src/fulfillment/CONTEXT.md): manages warehouse picking and shipping

## Relationships

- **Ordering → Fulfillment**: Ordering emits `OrderPlaced` events; Fulfillment consumes them to start picking
- **Fulfillment → Billing**: Fulfillment emits `ShipmentDispatched` events; Billing consumes them to generate invoices
- **Ordering ↔ Billing**: Shared types for `CustomerId` and `Money`
```

技能会推断适用哪种结构：

- 如果 `CONTEXT-MAP.md` 存在，读它来找出各个上下文
- 如果只有一个根 `CONTEXT.md`，就是单上下文
- 如果两者都不存在，就在第一个术语被敲定时惰性创建根 `CONTEXT.md`

当存在多个上下文时，推断当前话题与哪一个相关。如果不清楚，就问。
