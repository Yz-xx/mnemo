---
status: accepted
---

# 让智能体的思考过程在客户端可见

对话界面目前只呈现最终答复，用户看不到「模型在想什么」「它在调什么工具」「历史为什么被压缩」。本文记录把这三类过程信息变得可见的整体取向，以及顺序、事件形态、落库边界三处定案。分三层落地：L2 执行过程（不换模型）→ L1 模型推理链（需更换或新增支持 thinking 的模型）→ L3 治理决策（后端数据已现成）。

## 现状

- 跨端 SSE 契约 [chat.ts](file:///d:/Files/common/porgram/my-monorepo/packages/reusable/src/chat.ts) 的 `AgentStreamEvent` 只有 `token` / `tool` / `file` / `source` 四类，**没有承载推理内容的 `thinking` 事件**。
- [agent.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/llm/agent.ts) 在 `AIMessageChunk` 分支只做两件事——取 `tool_call_chunks` 与 `extractText(message.content)`。推理内容落在 `additional_kwargs.reasoning_content`，**从未被读取**。
- [model.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/llm/model.ts) 的 `ChatOllama` **未传 `think`**；实测对 thinking 模型（如 `qwen3`）**省略 `think` 等同于开启**——Ollama `/api/chat` 仍照常返回推理内容。原先「`@langchain/ollama@1.3.0` 写死 `options.think ?? false`、不显式开启则拿不到 reasoning」的推断与实测不符：靠「不传」关不掉推理链，**必须显式传 `false`**。
- 默认模型 `qwen2.5:7b` 本身不产 thinking；本仓另有教训是 `deepseek-r1:7b` 不支持 Ollama 工具调用。
- `@langchain/core@1.2.12` 已内建 `messages/block_translators/ollama.js` 与 `deepseek.js`，把 `additional_kwargs.reasoning_content` 翻成标准内容块 `{ type: 'reasoning', reasoning }`——**底座现成，仓库未使用**。
- `tool` 事件只带工具名（[chat.ts](file:///d:/Files/common/porgram/my-monorepo/packages/reusable/src/chat.ts)），`tool_call_chunks` 里的 `args` 被丢弃；客户端 [MessageItem.vue](file:///d:/Files/common/porgram/my-monorepo/apps/agent-client/src/renderer/src/components/MessageItem/MessageItem.vue) 已有 `steps`（工具轨迹 chip）这套现成的「过程可见」设施。
- [chatStream.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/services/chatStream.ts) 已算出 `trimmedMessages` / `summarized`，但只写进服务端日志，未下发客户端。

## 术语

- **模型推理链（reasoning）**：模型在给出正文前自己产生的思考文本，经 Ollama `think` 模式或 DeepSeek reasoner 的 `reasoning_content` 暴露。
- **内容块（content block）**：LangChain 1.x 表示消息内容的标准结构，推理内容对应 `{ type: 'reasoning' }`，正文对应 `{ type: 'text' }`。
- **执行过程（tool trace）**：本轮调用了哪些工具、正在做什么、入参是什么。
- **治理决策（governance trace）**：本轮是否裁剪历史、裁掉多少条、是否生成摘要。

## 决策

1. **分三层落地，按 L2 → L1 → L3 推进**：L2 零模型风险先做，L1 要动模型与主链路须留足实测余量，L3 数据已现成放最后收口。三层各自独立可上线。
2. **`tool` 事件增可选 `detail` 字段**：结构不破坏，`detail` 承载人类可读的阶段描述（如「检索知识库：人工智能」），由服务端把工具名映射成中文标签后拼接。
3. **入参摘要延迟到可解析时下发**：`tool_call_chunks` 的 `args` 是增量 JSON 字符串，当前在首个带 `name` 的分片就 yield `start`，那时 `args` 尚不完整。改为按调用 key 累积 `args`、每次尝试 `JSON.parse`，**成功即发 `start`（带 `detail`）**；始终解析不出则在 `ToolMessage` 到达时兜底补发。延迟仅几帧，仍远早于工具执行结束，保留「慢工具有即时反馈」的初衷。
4. **`detail` 不落库**：`messages.tools` 继续只存工具名，历史回看降级为工具名。工具名已足以表达「做过什么」，参数摘要的回看价值不足以支撑一次 schema 变更。
5. **L1 新增 `LLM_THINKING` 配置，默认 `false`，且 `ChatOllama` 始终显式透传 `think: config.llm.thinking`**：Ollama 对 thinking 模型省略 `think` 等同于开启，只在打开时才传会让「默认关闭」形同虚设，故关闭时必须显式传 `think: false`；实测非 thinking 模型（如 `qwen2.5:7b`）收到 `think: false` 不会报错，透传安全。开启后模型行为与耗时都会变，因此默认关闭保证不换模型时行为与现在一致。
6. **推理内容提取「内容块优先、`additional_kwargs` 兜底」**：Ollama 开启 `think` 后 `@langchain/core` 会把块规整为 `{ type: 'reasoning' }`，而未走 translator 的路径仍是 `additional_kwargs.reasoning_content`，两条来源都要兼容。`extractText` 保持只取 text 块，推理内容不会混进正文。
7. **thinking 不落库、不进 `BaseMessage[]`、不计 token**：推理链体积大、含模型噪声、回看价值低；更关键的是它一旦进入历史或参与估算，会直接冲击 [ADR 0008](0008-context-window-and-summary.md) 的窗口治理口径。
8. **客户端以可折叠面板呈现「思考过程」**：放在正文之前，**正文首个 token 到达即自动折叠**——thinking 与正文可能交错出现，不自动折叠会让界面反复跳动。
9. **L3 的 `context` 事件仅在真正裁剪时下发**：`trimmedMessages > 0` 才推，避免每轮都挂一条无意义提示。
10. **跨端契约只改 `packages/reusable/src/chat.ts` 一处**：新增事件与字段一律加在这份唯一真相来源里，两端共用，不得各写一份副本。

## Considered Options

- **直接读 `additional_kwargs.reasoning_content`、不看内容块**：在 Ollama 开启 `think` 后块形态已是标准 `{ type: 'reasoning' }`，只认一条路径会漏。否决，改双来源兼容。
- **`tool start` 立即下发、不带参数**：改动最小，但可读性提升有限，用户仍看不到「在检索什么」。降级为解析失败时的兜底行为。
- **thinking 落库并在历史回看时还原**：需加列、回读并处理体积膨胀。否决，与决策 7 的预算隔离相冲突。
- **默认开启 thinking**：对 `qwen2.5:7b` 可能直接报错，且改变主链路行为。否决，改为显式配置且默认关闭。
- **每轮都下发 `context` 事件**：界面噪音，且大多数轮次并未触发裁剪。否决，改为条件下发。
- **各端各写一份事件类型**：桌面端历史上就曾多出一个服务端从不下发的 `detail` 字段。否决，沿用既有单一契约。

## Consequences

- **L1 是主链路变更**：需更换或新增支持 thinking 且支持工具调用的模型（`qwen3` / `gpt-oss` 一类），并实测工具调用遵循率——`qwen2.5:7b` 是当前工具可用性的保证，不能只看 thinking 能力就换。
- **L1 已实测**：`qwen3` 开启 thinking 仍能正确调用工具（`search_knowledge_base` / `calculator`），推理内容经 `thinking` 事件下发且不落库、不进历史、不计入预算；`LLM_THINKING=false` 时推理链被真正关闭（显式 `think: false`）。
- **契约外溢**：新增事件与字段后，两端消费方与相关测试夹具须同步；跨端契约类型不入 `@repo/reusable` 之外的副本。
- **配置同步**：`LLM_THINKING` 需同步 `AppConfig` → `loadConfig()` → `.env.development` / `.env.production` → `apps/agent-server/README.md` 配置表。
- **历史回看存在缺口**：推理链与工具参数摘要都不落库，重新打开历史会话时看不到这两项，界面须以「无此信息」的形态自然降级，而非显示空白面板。
- **时序需实测**：thinking 与正文交错的具体节奏取决于模型，折叠时机需在真机上走查确认。

## 待办（实施时）

- L2：`tool` 事件增 `detail`；工具名中文映射；`args` 累积与 `ToolMessage` 兜底；客户端 `ChatStep` 透传与渲染；测试覆盖「分片未完整不发、完整后只发一次、解析失败仍兜底」。
- L1：`LLM_THINKING` 配置打通四层；`ChatOllama` 显式透传 `think`；`extractReasoning()` 双来源提取；`thinking` 事件贯通两端；折叠面板；测试覆盖「开关关闭时行为不变、两条来源各一例、thinking 不计入上下文预算」。
- L3：`context` 事件贯通两端；仅裁剪时下发；测试覆盖「未触发裁剪不下发、`summarized` 与日志一致」。
