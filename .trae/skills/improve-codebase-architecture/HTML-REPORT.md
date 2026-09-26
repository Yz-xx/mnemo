# HTML 报告格式

架构评审渲染为操作系统临时目录中的单个自包含 HTML 文件。Tailwind 与 Mermaid 都来自 CDN。Mermaid 可靠地处理图形状的图示；手工搭建的 div 与内联 SVG 处理更具编辑感的视觉元素（体量图、剖面图）。把两者混用：不要凡事都依赖 Mermaid，否则会开始显得千篇一律。

## 骨架

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Architecture review for {{repo name}}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script type="module">
      import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
      mermaid.initialize({ startOnLoad: true, theme: 'neutral', securityLevel: 'loose' });
    </script>
    <style>
      /* small custom layer for things Tailwind doesn't cover cleanly:
         dashed seam lines, hand-drawn-feeling arrow heads, etc. */
      .seam {
        stroke-dasharray: 4 4;
      }
      .leak {
        stroke: #dc2626;
      }
      .deep {
        background: linear-gradient(135deg, #0f172a, #1e293b);
      }
    </style>
  </head>
  <body class="bg-stone-50 text-slate-900 font-sans">
    <main class="max-w-5xl mx-auto px-6 py-12 space-y-12">
      <header>...</header>
      <section id="candidates" class="space-y-10">...</section>
      <section id="top-recommendation">...</section>
    </main>
  </body>
</html>
```

## 页眉

仓库名、日期，以及一个紧凑的图例：实心方框 = 模块，虚线 = 接缝，红色箭头 = 泄漏，粗深色方框 = 深模块。没有引言段落。直接进入候选方案。

## 候选卡片

图示挑大梁。文字稀疏、平实，不加修饰地使用（来自 `/codebase-design` 技能的）词汇表术语。

每个候选方案是一个 `<article>`：

- **标题**：简短，给这次深化命名（例如 "折叠 Order intake 流水线"）。
- **徽章行**：推荐强度（`Strong` = 翠绿，`Worth exploring` = 琥珀，`Speculative` = 石板灰），外加一个依赖类别的标签（`in-process`、`local-substitutable`、`ports & adapters`、`mock`）。
- **文件**：等宽字体列表，`font-mono text-sm`。
- **前后对比图**：核心部分。两列并排。范式见下文。
- **问题**：一句话。哪里疼。
- **解决方案**：一句话。什么会改变。
- **收益（Wins）**：项目符号，每条 ≤6 个词。例如 "测试命中一个接口"、"定价逻辑不再泄漏"、"删除 4 个浅包装器"。
- **ADR 提示框**（如适用）：琥珀色底框中的一行。

没有成段的解释。如果一张图示需要一段文字才能被看懂，就重画这张图。

## 图示范式

挑选适合该候选方案的范式。混用它们。不要让每张图都长得一样。多样性正是要点之一。

### Mermaid 图（依赖 / 调用流的主力）

当要点是 "X 调用 Y，Y 调用 Z，看看这一团乱" 时，使用 Mermaid 的 `flowchart` 或 `graph`。把它包进一个 Tailwind 样式的卡片里，这样它不会显得是空降进来的。用 classDef 设置样式，把泄漏边染成红色、把深模块染成深色。时序图很适合表达 "之前：6 次往返；之后：1 次"。

```html
<div class="rounded-lg border border-slate-200 bg-white p-4">
  <pre class="mermaid">
    flowchart LR
      A[OrderHandler] --> B[OrderValidator]
      B --> C[OrderRepo]
      C -.leak.-> D[PricingClient]
      classDef leak stroke:#dc2626,stroke-width:2px;
      class C,D leak
  </pre>
</div>
```

### 手工搭建的方框与箭头（当 Mermaid 的布局与你作对时）

模块用带边框和标签的 `<div>` 表示。箭头用内联 SVG 的 `<line>` 或 `<path>` 元素，绝对定位在一个相对定位的容器之上。当你希望 "之后" 的图示感觉像是一个粗边框的深模块、内部被置灰时，就用这个，因为 Mermaid 无法以合适的分量渲染出那种效果。

### 剖面图（适合分层的浅）

堆叠水平色带（`h-12 border-l-4`）来展示一次调用穿过的各层。之前：6 个薄层，每个都不干什么事。之后：1 条厚色带，标注合并后的职责。

### 体量图（适合 "接口和实现一样宽"）

每个模块两个矩形：一个代表接口的表面积，一个代表实现。之前：接口矩形几乎和实现矩形一样高（浅）。之后：接口矩形很短，实现矩形很高（深）。

### 调用图折叠

之前：一棵函数调用树，渲染为嵌套的方框。之后：同一棵树折叠成一个方框，如今成为内部的调用以淡化的方式显示在其中。

## 样式指引

- 偏向编辑感，而非企业仪表盘。留白大方。标题可选用衬线字体（`font-serif` 与 stone/slate 搭配得很好）。
- 用色克制：一个强调色（翠绿或靛蓝），加上红色表示泄漏、琥珀色表示警告。
- 让图示保持在约 320px 高，这样前后对比能舒适地并排显示而无需滚动。
- 图示内部的模块标签使用 `text-xs uppercase tracking-wider`，让它们读起来像示意图，而不是 UI。
- 仅有的脚本是 Tailwind CDN 和 Mermaid 的 ESM 导入。除此之外报告是静态的：没有应用代码，除了 Mermaid 自身的渲染外没有任何交互。

## 首推建议部分

一张更大的卡片。候选方案名称、一句说明原因的话、指向其卡片的锚点链接。仅此而已。

## 语气

平实、简洁，但架构上的名词与动词直接来自 `/codebase-design` 技能。简洁不是跑偏的借口。

**必须准确使用：**模块（module）、接口（interface）、实现（implementation）、深度（depth）、深（deep）、浅（shallow）、接缝（seam）、适配器（adapter）、杠杆（leverage）、局部性（locality）。

**绝不替换为：** component、service、unit（代替 module）· API、signature（代替 interface）· boundary（代替 seam）· layer、wrapper（当你想说 module 时，代替 module）。

**符合该风格的措辞：**

- "Order intake 模块很浅：接口几乎与实现一样。"
- "定价逻辑跨越接缝发生泄漏。"
- "深化：一个接口，一处测试点。"
- "两个适配器证明了接缝的合理性：生产环境用 HTTP，测试环境用内存实现。"

**收益项目符号**用词汇表术语来命名所获：_"局部性：缺陷集中在一个模块"_、_"杠杆：一个接口，N 个调用点"_、_"接口收缩；实现吸收了包装器"_。不要写 _"更易维护"_ 或 _"更干净的代码"_，因为这些术语不在词汇表里，也不配占一席之地。

不要含糊其辞，不要清嗓子式的开场，不要 "值得注意的是…"。如果一个句子可以做成项目符号，就把它做成项目符号。如果一个项目符号可以删掉，就删掉它。如果一个术语不在 `/codebase-design` 词汇表里，先去找一个在表里的，再考虑发明新的。
