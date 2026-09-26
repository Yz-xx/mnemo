# 设计两次

当用户想为选定的深化候选者探索备选接口时，使用这套并行 sub-agent 模式。基于"Design It Twice"（Ousterhout）：你的第一个想法不太可能是最好的。

使用 [SKILL.md](SKILL.md) 中的词汇：**module**、**interface**、**seam**、**adapter**、**leverage**。

## 流程

### 1. 框定问题空间

在启动 sub-agent 之前，为选定的候选者写一份面向用户的问题空间说明：

- 任何新接口都需要满足的约束
- 它会依赖的依赖，以及它们属于哪个类别（见 [DEEPENING.md](DEEPENING.md)）
- 一份粗略的示意性代码草图，用来给约束落地，不是提案，只是把约束变具体的一种方式

把这份说明展示给用户，然后立即进入第 2 步。sub-agent 并行工作时，用户一边读一边想。

### 2. 启动 sub-agent

并行启动 3 个以上 sub-agent。每一个都必须为深化后的模块产出一个**截然不同**的接口。

给每个 sub-agent 一份单独的技术简报（文件路径、耦合细节、来自 [DEEPENING.md](DEEPENING.md) 的依赖类别、接缝后面坐着什么）。这份简报独立于第 1 步中面向用户的问题空间说明。给每个 agent 一条不同的设计约束：

- Agent 1："Minimize the interface: aim for 1–3 entry points max. Maximise leverage per entry point."（中文：最小化接口：最多 1 到 3 个入口点。让每个入口点的杠杆最大化。）
- Agent 2："Maximise flexibility: support many use cases and extension."（中文：最大化灵活性：支持多种用例与扩展。）
- Agent 3："Optimise for the most common caller: make the default case trivial."（中文：为最常见的调用方优化：让默认情况变得举手之劳。）
- Agent 4 (if applicable)："Design around ports & adapters for cross-seam dependencies."（中文：围绕端口与适配器来设计跨接缝的依赖。）

把 [SKILL.md](SKILL.md) 的词汇和 CONTEXT.md 的词汇都放进简报，好让每个 sub-agent 的命名都与架构语言和项目领域语言保持一致。

每个 sub-agent 输出：

1. Interface（类型、方法、参数，外加不变量、顺序、错误模式）
2. 展示调用方如何使用它的用法示例
3. 实现在接缝后面藏住了什么
4. 依赖策略与适配器（见 [DEEPENING.md](DEEPENING.md)）
5. 取舍：杠杆在哪里高，在哪里薄

### 3. 呈现并比较

依次呈现各个设计，好让用户逐个吸收，然后用散文比较它们。按 **depth**（接口处的杠杆）、**locality**（变化集中在哪里）和 **seam placement**（接缝位置）来对照。

比较之后，给出你自己的推荐：你认为哪个设计最强，以及为什么。如果不同设计里的元素能很好地结合，就提出一个混合方案。要有主见：用户想要的是一份明确的判断，而不是一张菜单。
