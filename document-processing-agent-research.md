# 桌面端智能体「上传文件 + 按需操作文档」能力调研与实施方案

> 纯调研产出，未改动任何代码。所有仓库侧断言均回源码取证并标注路径与行号；外部结论标注一手来源。
> 上一份工作区调研（[coding-workspace-agent-research.md](./coding-workspace-agent-research.md)）因铺开三套方案被判定过重而搁置，本文据此收敛为**一条推荐路线 + 明确的取舍点**。

## 1. 一句话结论

目标可以拆成三件代价天差地别的事——**读文件、生成新文件、回写原文件**。前两件今天就能做，第三件在 Office 格式上勉强可做、在 PDF 上**根本做不到**。建议一期只做「读 + 生成」，把「回写」推到二期；这一刀能砍掉大半工作量，且不损失"帮我改文档"的主要使用场景（改成什么 → 导出新文件给你）。

## 2. 现状差距（回源码取证）

| 需要的能力   | 现在的样子                                                                                           | 证据                                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 接收文件上传 | 只有 JSON 解析，**没有 multipart**，且请求体上限 2 MB                                                | [app.ts](apps/agent-server/src/app.ts#L18) `express.json({ limit: '2mb' })`                                               |
| 文件解析     | 无。后端依赖里没有任何文件解析 / 上传库                                                              | [package.json](apps/agent-server/package.json#L13-L27)                                                                    |
| 知识库入库   | 只收**文本字段**，切分后向量化，不存原始文件                                                         | [knowledge.ts](apps/agent-server/src/routes/knowledge.ts#L18-L24)、[store.ts](apps/agent-server/src/rag/store.ts#L62-L90) |
| 消息模型     | 消息只有 `id/role/content/created_at`，**无附件字段**                                                | [types.ts](apps/agent-server/src/conversation/types.ts#L3-L8)                                                             |
| 客户端上传   | 请求头**硬编码** `Content-Type: application/json`，响应只走 `res.json()`，无法发 FormData / 收二进制 | [client.ts](apps/agent-client/src/renderer/src/api/client.ts#L64-L80)                                                     |
| 选文件       | 桥接层只有 5 个成员，**没有文件对话框**；UI 是标题 + 内容两个文本框                                  | [types.ts](apps/agent-client/src/preload/types.ts#L35-L42)、[ipc.ts](apps/agent-client/src/main/ipc.ts#L8-L37)            |
| 图片理解     | 当前对话模型 `qwen2.5:7b` **不支持视觉输入**                                                         | [.env.development](apps/agent-server/.env.development#L29) + Ollama 官方模型页（见 §8）                                   |

结论：这不是"复用现有上传链路"的事，而是**一条要从零搭的链路**。唯一可直接复用的是鉴权、错误契约、SSE 单向推送这三件既有基建。

## 3. 三种语义，代价不同（本文的核心收敛点）

| 语义           | 用户话术                 | 技术实质             | 可行性                                |
| -------------- | ------------------------ | -------------------- | ------------------------------------- |
| **读**         | 「总结这份 PDF」         | 解析成文本喂给模型   | 低难度，纯库活                        |
| **生成**       | 「把这些数据导成 Excel」 | 从零构造新文件       | 中等，库支持成熟                      |
| **回写原文件** | 「把 Word 第 3 段改短」  | 在保真前提下就地修改 | **Office 勉强可做，PDF 不可做**（§4） |

一期做「读 + 生成」时，整个链路仍是**单向**的：文件进 → 模型读 → 产出新文件。不需要改动任何现有协议。
一期就做「回写」则会立刻引入两个新问题：保真度不可控、以及"改坏了怎么回滚"——这正是上一份调研判定过重的同类复杂度。

## 4. 各格式的可行性与选型（一手来源见 §8）

| 格式             | 读                                                                           | 回写（保格式）                                                                                                                | 生成                                              | 结论                                                                                          |
| ---------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `.docx`          | `mammoth`（转 HTML，忽略样式细节）                                           | `pizzip` 拆包改 `word/document.xml`（docx = zip + OOXML）                                                                     | `docx`（构建式）                                  | 可做，但保真需实测；`docx`/`officegen` 只能从零生成，`docxtemplater` 只对**带标签的模板**成立 |
| `.doc`（旧格式） | 无纯 JS 方案                                                                 | 无                                                                                                                            | —                                                 | 必须先经 LibreOffice 转 `.docx`                                                               |
| `.xlsx`          | `exceljs` 或 SheetJS CE                                                      | `exceljs`（读改同一文件，含样式对象）                                                                                         | `exceljs`                                         | 可做；SheetJS CE 需从官方 CDN tarball 安装（npm 上 `xlsx@0.18.5` 已停更且有漏洞工单）         |
| `.pdf`           | `pdfjs-dist` / `pdf.js-extract`（带坐标，可还原表格）                        | **不可原地改正文**：`pdf-lib` 官方明言 "does not provide APIs for removing or editing text on a page outside of a form field" | `pdf-lib` 组装 + headless Chrome `--print-to-pdf` | 只能「读 → 重新生成 → 导出」                                                                  |
| 扫描件 PDF       | 需渲染成图 + `tesseract.js`（支持 `chi_sim`，官方明言**不支持 PDF 输入**）   | —                                                                                                                             | —                                                 | 二期                                                                                          |
| 图片（编辑）     | —                                                                            | `sharp`（裁剪 / 缩放 / 旋转 / 水印 / 格式转换）                                                                               | `sharp`                                           | 低风险；Node ≥ 20.9.0 且 Windows 有 prebuilt                                                  |
| 图片（理解）     | **必须换 vision 模型**（`qwen3-vl:8b` / `gemma3` / `llava` / 云端 DeepSeek） | —                                                                                                                             | —                                                 | 一期不做，或作为独立设置项                                                                    |

两条容易被低估的硬约束：

1. **PDF 的"改"是个伪需求**。业界没有"原地改 PDF 正文"的通用方案，正确形态是把它当**只读输入**，产出落到 docx / markdown / 新 PDF。若用户坚持要"改 PDF"，只能如实告知这里会变成"重新生成一份"。
2. **`.xlsx` 的保真度不可承诺**。修改既有 xlsx 时哪些内容一定丢失（透视表、宏、图表），没有官方明文清单；只能实测 + 在 UI 上明确提示"请核对导出结果"。

## 5. 架构：处理放在哪一侧

与上一份调研同样的抉择点，但这里结论更明确：**一期放后端**。

| 理由         | 说明                                                                        |
| ------------ | --------------------------------------------------------------------------- |
| 复用现有基建 | `/api/*` 鉴权、`{ message }` 错误契约、SSE 单向流全部现成，不必改造线协议   |
| 客户端极薄   | 主进程只做两件事：开文件对话框、把结果文件落盘。渲染进程仍是"发消息 + 展示" |
| 与知识库同侧 | 上传、解析、落盘都在 `DATA_DIR` 下，和 LanceDB 数据同源，便于统一清理与备份 |

二期的分界线很清楚：**只有当"就地操作本机文件（不经后端）"成为需求时，才需要把执行下沉主进程**——那时才要改动 SSE 协议（与上一份调研的方案二一致）。一期不必提前付这个代价。

外部进程（LibreOffice / Chrome headless）无论一期二期都只在**有能力限制参数的那一侧**调用，并按 Electron 官方安全清单保持渲染进程无 Node 能力。

## 6. 关键实现要点

### 6.1 上传接口（后端）

`app.ts` 必须新增 multipart 中间件——**multipart 不经过 `express.json`**，所以既有的 2 MB 限制对它无效，需单独设限（建议 20 MB + 单请求 1 个文件）。

```ts
// app.ts：只加一行，位于 express.json 之前，大小与格式限制走 config
app.use(createUploadMiddleware(deps.config.upload));

// middleware/upload.ts：内存解析 + 白名单，解析前的原始字节留给 file-type 校验
export function createUploadMiddleware(upload: AppConfig['upload']) {
  return multer({
    storage: multer.memoryStorage(), // 先入内存：要拿到原始字节读 magic bytes，再决定是否落盘
    limits: { fileSize: upload.maxBytes, files: upload.maxFiles },
  }).single('file');
}
```

- 路由按 `create<Name>Router(deps)` + `Pick<AppDependencies, ...>` 约定，鉴权仍在 `routes/index.ts` 集中声明。
- **类型校验按 magic bytes**（`file-type`），不信任扩展名与 MIME——其官方声明本身也只是 best-effort hint。
- 落盘路径 `DATA_DIR/uploads/<userId>/<fileId>.<ext>`，元数据入新表（沿用 backend-design §6：utf8mb4、`DATETIME(3)`、全参数化、必带 `user_id` 过滤）。

### 6.2 消息与附件关联

- `messages` 表加附件关联（新表 `message_files` 或 JSON 列），`StoredMessage` / `ChatMessage` 同步补字段。
- **`ChatStreamEvent` 不需要改**：一期附件在发消息前就已上传完，`POST /api/chat` 的入参多一个 `fileIds: string[]` 即可（[chat.ts](packages/reusable/src/chat.ts#L20-L24) 保持不变）。这是"一期不上主进程"带来的直接红利。

### 6.3 工具面（对齐 backend-design §7）

在 `llm/tools.ts` 沿用 `tool()` + `z.object` + 中文错误 + 自校验：

| 工具           | 作用                                                      | 一期 |
| -------------- | --------------------------------------------------------- | ---- |
| `list_files`   | 列出本次会话可用的附件（文件名 / 类型 / 大小）            | ✅   |
| `read_file`    | 取附件的文本内容（按格式分派解析器）                      | ✅   |
| `write_file`   | 按指定格式生成新文件，返回可下载的 fileId                 | ✅   |
| `edit_image`   | 对图片做确定性操作（裁剪 / 缩放 / 水印 / 转格式）         | ✅   |
| `apply_edit`   | 回写原文件（docx 走 pizzip 改 XML、xlsx 走 exceljs 回写） | 二期 |
| `convert_file` | 格式转换（依赖 LibreOffice headless）                     | 二期 |

**工具要能拿到文件**：`AgentService.stream` 把 `fileIds` 放进 `configurable`，工具回调从中读取（与现有 `userId` / `logger` 同一机制）。缺文件时抛中文错误，禁止静默返回空。

### 6.4 客户端要扩的三处（一处都不能漏）

1. **请求头**：现在 `Content-Type: application/json` 是硬编码的。上传要**不设** Content-Type（让浏览器自带 boundary），所以 `buildHeaders` 需支持"不注入 JSON 头"，或另开 `uploadFile()` 方法而不复用 `request()`。
2. **响应体**：`request()` 只 `res.json()`。下载结果文件需要 `arrayBuffer()` / Blob 路径。
3. **选文件 IPC**：新增 `dialog:open`（`dialog.showOpenDialog`，带 `filters` 白名单与 `multiSelections: false`），按 desktop-design §3 **三处同步**：`main/ipc.ts` 注册 → `preload/index.ts` 白名单暴露 → `preload/types.ts` 类型声明；渲染进程仍只经 `api/bridge.ts`。

### 6.5 配置与设置项

新增配置走 backend-design §8 的标准动作（`AppConfig` → `loadConfig()` → 两份 env → README 配置表）：

- `UPLOAD_MAX_BYTES`、`UPLOAD_ALLOWED_TYPES`（magic bytes 白名单）、`UPLOAD_DIR`
- `OLLAMA_VISION_MODEL`（留空即关闭图片理解能力；配了才暴露对应工具）
- 路径类配置一律绝对路径。

### 6.6 图片处理的两个坑

- `sharp` 是原生模块：后端用不受影响；若二期下沉到主进程，需注意 electron-builder 的 `files` 只收 `out/**`，而主进程依赖由 `externalizeDepsPlugin()` 外置、生产依赖由 electron-builder 打进 asar——**打包后要在真机验一次**，官方只给了 bundler 章节、没有 Electron + ESM 的明确保证。
- 不装 vision 模型时，图片理解工具不应"假装读懂"，而要返回可读错误（如「当前模型不支持图片理解，请在设置中启用视觉模型」）；实际文案为「服务端未配置视觉模型，暂时无法读取图片内容。」（定义在 `llm/vision.ts` 的 `VISION_DISABLED_MESSAGE`）。

## 7. 需要你拍板的四个问题

1. **一期范围**：只做「读 + 生成」，还是一步做到「回写原文件」？（这一条决定大半工作量，建议前者）
2. **PDF 的预期**：能否接受"不能原地改正文，只能重新生成一份"？
3. **图片的语义**：「编辑」（裁剪 / 缩放 / 水印，纯程序化）还是「理解」（读图表 / 读截图文字，**必须引入 vision 模型**）？若选理解，允许本机装 `qwen3-vl:8b` 还是必须走云端？
4. **执行位置**：一期是否就按本文建议放后端？还是有"文件不出本机"的硬要求（若有，需直接走主进程并接受协议改造）？

## 8. 建议的落地顺序（一期，工单粒度）

1. 后端：上传中间件 + `POST /api/files` + magic bytes 校验 + 落盘 + 元数据表 + 单测
2. 后端：解析器分派（docx → mammoth / xlsx → exceljs / pdf → pdfjs-dist），纯函数、可单测
3. 后端：`list_files` / `read_file` 两个工具接入 `llm/tools.ts`，`fileIds` 经 `configurable` 下传
4. 客户端：`dialog:open` IPC（三处同步）+ `bridge.ts` 转发 + 附件 chip 展示
5. 客户端：`uploadFile()`（绕过 JSON 头）+ 发送时带 `fileIds` + 会话详情渲染附件
6. 后端 + 客户端：`write_file` 生成导出（docx / xlsx / pdf）+ 下载落盘
7. 后端：`edit_image`（sharp）+ 视觉模型配置项（留空则关闭）
8. 文档同步：根 README、两端 README、`backend-design.md` §8 配置表（新增上传与视觉模型配置）

二期（按需）：`apply_edit` 回写、`convert_file`（LibreOffice）、扫描件 OCR、执行下沉主进程。

## 9. 参考资料（一手来源）

| 主题                       | 来源                                                                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| docx 生成 / 模板 / 转 HTML | https://www.npmjs.com/package/docx、https://docxtemplater.com/docs/get-started-node/、https://www.npmjs.com/package/mammoth                                             |
| docx 低层改写              | https://www.npmjs.com/package/pizzip、ECMA-376（Part 2 = OPC，"Mapping to a ZIP file"）https://ecma-international.org/publications-and-standards/standards/ecma-376/    |
| xlsx                       | https://www.npmjs.com/package/exceljs、SheetJS 许可证 https://docs.sheetjs.com/docs/miscellany/license/、安装源变更 https://git.sheetjs.com/sheetjs/sheetjs/issues/3098 |
| PDF 不可改正文             | https://github.com/Hopding/pdf-lib、https://pdf-lib.js.org/                                                                                                             |
| PDF 解析                   | https://www.npmjs.com/package/pdfjs-dist、https://www.npmjs.com/package/pdf-parse                                                                                       |
| headless 打印 PDF          | https://developer.chrome.google.cn/docs/chromium/new-headless                                                                                                           |
| OCR                        | https://www.npmjs.com/package/tesseract.js、https://tesseract.projectnaptha.com/                                                                                        |
| sharp / jimp               | https://sharp.pixelplumbing.com/install/、https://www.npmjs.com/package/jimp                                                                                            |
| Ollama 视觉                | https://ollama.com/library/qwen2.5（`7b` 标注为 Text、无 vision）、https://docs.ollama.com/capabilities/vision.md、https://docs.ollama.com/api/openai-compatibility     |
| DeepSeek 视觉              | https://api-docs.deepseek.com/guides/vision/                                                                                                                            |
| LibreOffice 无头           | https://help.libreoffice.org/latest/ug/text/shared/guide/start_parameters.html（需对 user profile 有写权限）                                                            |
| Electron 安全              | https://www.electronjs.org/docs/latest/tutorial/security                                                                                                                |
| 文件类型校验               | https://www.npmjs.com/package/file-type（官方声明为 best-effort hint）                                                                                                  |

### 未证实的部分（不要当结论用）

- `@xmldom` 直改 `word/document.xml` 后「能完整保留全部格式」缺少官方承诺，属自证推断。
- `exceljs` 对公式 / 样式保留边界没有官方逐项能力矩阵。
- 「改 xlsx 必然丢失透视表 / 宏 / 图表」无官方明文，只有 SheetJS「Pro 才覆盖这些」的间接证据。
- LibreOffice 在 Windows 的安装体积与首次启动耗时，官方启动参数页未给数字。
- `sharp` 在 Electron 打包场景下的实际可用性，官方只有 bundler 章节。
- DeepSeek 的视觉模型名与参数取自官方文档页面现值，版本敏感、未做交叉验证。
