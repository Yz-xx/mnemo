# 后台管理网站（@repo/admin-web）

`agent-server` 的后台管理网站：管理员登录后完成运行总览、用户治理、知识库 / 会话 / 文件治理，以及接口日志、操作审计与系统配置的查看。数据全部取自后端 `/api/admin/*` 接口，前端不直连数据库、不持有业务规则。定位是运维与账号治理的可视化入口——普通账号在登录环节就被拦下，这里没有面向终端用户的页面。

- 框架：Vue 3 `<script setup>` + TypeScript + Vite 6 + Less
- 路由：vue-router 4 + `unplugin-vue-router` 文件式自动路由（`src/pages` 即路由表）
- 状态：pinia（setup store），目前只有 `auth` 一个 store
- 请求：复用 `@repo/reusable` 的 `createApiClient` 工厂，本包只注入 `baseURL` 与 token 取值器
- 图表：echarts 按需引入（`echarts/core` + 按需注册图表与组件，避免整包进产物）
- 图标：lucide-vue-next
- UI：不引 Element / Ant，表格、分页、搜索栏、弹窗等组件自建并目录化
- 主题：固定亮色，不做主题切换

---

## 一、目录结构

```text
apps/admin-web/
├── src/
│   ├── main.ts                  # 入口：装 pinia / router，恢复登录态并注入 401 处理
│   ├── App.vue                  # 布局分发器：login 独立渲染，其余套 AdminLayout
│   ├── api/
│   │   ├── client.ts            # adminApi 实例 + token 读写 + 令牌失效回调注入
│   │   ├── auth.ts              # 登录 / 当前用户 / 登出
│   │   ├── index.ts             # 管理接口统一出口：按功能域 re-export，页面统一从 '@/api' 引入
│   │   ├── overview.ts          # 总览统计 / 运行状态
│   │   ├── users.ts             # 用户治理（含批量停用 / 删除）
│   │   ├── knowledge.ts         # 知识库文档（含批量删除）
│   │   ├── conversations.ts     # 会话（含批量删除）
│   │   ├── files.ts             # 上传文件（含批量删除）
│   │   ├── logs.ts              # 接口日志
│   │   ├── audit.ts             # 操作审计
│   │   ├── system.ts            # LLM 工具清单 / 系统配置
│   │   └── types.ts             # 与后端约定的契约类型
│   ├── router/
│   │   ├── index.ts             # 路由实例（routes 来自自动路由虚拟模块）
│   │   └── guards.ts            # 登录态 + 管理员角色双校验
│   ├── stores/auth.ts           # 登录态 store（token 落 localStorage，user 在内存）
│   ├── layouts/AdminLayout.vue  # 顶栏 + 可收起侧边栏 + 内容区
│   ├── pages/                   # 每页一目录；超 200 行的页面拆成 index.vue + 同名 .ts + 同名 .less
│   │   ├── index.vue            # 总览（真实统计 + 运行状态条 + 消息趋势图）
│   │   ├── overview.ts/.less    #   └ 总览页抽出的逻辑与样式（与 index.vue 并排，取 BEM 前缀命名）
│   │   ├── users/index.vue      # 用户管理（搜索 / 分页 / 改角色与状态 / 新建 / 删除）
│   │   ├── knowledge/index.vue  # 知识库管理（管理视角文档列表 / 新增全局文档 / 删除）
│   │   ├── conversations/index.vue # 会话管理（全账号会话 / 详情查看 / 删除）
│   │   ├── files/index.vue      # 文件管理（全账号上传文件 / 删除）
│   │   ├── logs/index.vue       # 接口日志（路径关键词 / 方法 / 状态档位 + 分页 + 详情）
│   │   ├── audit/index.vue      # 操作审计（管理员写操作留档 + 请求体摘要详情）
│   │   ├── tools/index.vue      # LLM 工具清单（只读，未超 200 行故保持单文件）
│   │   ├── config/index.vue     # 系统配置只读视图（密钥类只显示是否已配置）
│   │   ├── login.vue            # 登录页（meta.layout='blank'，不经 AdminLayout）
│   │   ├── login.ts/.less       #   └ 登录页抽出的逻辑与样式
│   │   └── [...all].vue         # 未匹配路径的兜底页
│   ├── composables/
│   │   └── usePagedList.ts      # 列表页共用的分页取数（页码 / 加载态 / 错误文案 + 并发竞态防护）
│   ├── components/              # 8 个目录化自建组件，见第五章
│   └── styles/
│       ├── base.less            # 全局重置与基础排版
│       └── tokens.less          # CSS 变量令牌（固定亮色）
├── typed-router.d.ts            # 自动路由生成的路由类型，入库并登记到 tsconfig include
├── vite.config.ts               # 自动路由插件 / 别名 / /api 代理
└── tsconfig.json
```

说明：`users/`、`knowledge/`、`conversations/`、`files/`、`logs/`、`audit/`、`config/` 七个目录同样各自带了 `<目录名>.ts` 与 `<目录名>.less`（上表按目录折叠）。页面**不设 `index.ts` 导出**——路由由 `.vue` 生成、页面也不被别处 import，多一层入口只会多一个要同步维护的名字。`tools/index.vue` 与 `[...all].vue` 未超 200 行，保持单文件。

---

## 二、技术选型与取舍

- **文件式自动路由**：`src/pages` 下的文件结构即路由，省掉一张手写路由表这一处「改页面必改两处」的漂移点。生成的 `typed-router.d.ts` 入库并登记到 `tsconfig` 的 `include`，`router.push('/users')` 一类的路径因此能被类型检查拦下笔误。
- **HTTP 客户端上提到 `@repo/reusable`**：请求头拼装、错误归一化、SSE 解析三段逻辑与桌面端完全同形，抽成注入式工厂后本包只提供「baseURL 与 token 从哪来」。token 取值推迟到请求发起时（而非构造期固化），实例可长期持有。
- **固定亮色 + 自建组件**：后台以信息密度和可读性为先，不做主题切换，故不引主题体系；UI 需求集中在表格、分页、弹窗三处，自建比引入整套组件库更省，也避免样式被第三方覆盖规则牵着走。
- **依赖边界**：`vite` / `@types/node` / `@vitejs/plugin-vue` 由根 `package.json` 提供，本包**不重复声明**；`unplugin-vue-router` 只服务构建（`vite.config.ts` 与文件式路由生成），归 `devDependencies`。只登记真正用到的 `@repo/*` 包与 tsconfig 路径映射——多留一条映射，等于给一次误 import 留了「也能通过」的后路。
- **服务端能力优先**：列表的过滤、搜索与分页一律走服务端参数，前端不本地过滤。否则「当前页显示 3 条、总数却写 47」这类对不上的状态迟早出现。
- **分页取数收进 `composables/usePagedList.ts`**：六个列表页的「页码、每页条数、加载态、错误文案、翻页竞态」逐字同形，这些收进 composable；**筛选条件不进**——由各页经 `fetcher` 闭包注入，免得为六个页面的不同查询参数再造一层配置。竞态用请求序号挡住（只认最后一次发出的请求），原先各页都没有。

---

## 三、鉴权与登录态

后端有两条进入后台的入口（详见 [apps/agent-server/README.md](../agent-server/README.md)）：

| 入口                     | 前端如何参与                                                               |
| ------------------------ | -------------------------------------------------------------------------- |
| 管理员会话（常规）       | 登录页换取 Bearer 令牌，之后所有请求由 `adminApi` 自动带上 `Authorization` |
| 运维超级令牌（应急通道） | 属运维手段，前端不提供入口，经请求头 `x-admin-token` 直接调用管理接口即可  |

- **登录即筛角色**：`/api/auth/login` 成功后，若 `role` 非 `admin` 或 `status` 非 `active`，store 当场抛错且**不写入令牌**。否则守卫会先放行再弹回登录页，用户看到的是「登录成功了又被踢出来」。
- **口令加密传输**：登录与新建用户提交的 `password` 不是明文，而是先用服务端公钥（`GET /api/auth/public-key`）做 RSA-OAEP 加密后的 Base64 密文，加密动作收在 `@repo/reusable` 的 `encryptPassword`（见 [ADR 0004](../../docs/adr/0004-password-transport-and-storage.md)）。服务端解不开就是 `400`，明文送上去一样被拒。
- **守卫双校验**：`router/guards.ts` 先看 token 是否存在，再在 `restoreUser()` 拉完 `/api/auth/me` 之后判角色。必须先拉用户信息再判——刷新页面时 store 里的 `user` 是空的，直接判角色会把刚刷新的人误踢回登录页。
- **401 统一收口**：任意请求返回 401（令牌过期或被新登录顶掉）时，`api/client.ts` 清掉 localStorage 里的令牌，并通过 `setSessionExpiredHandler` 通知调用方清 store、跳登录页。回调由 `main.ts` 注入而非在 client 里直接 `import router`，是为了避免 `client → router → store → client` 的循环依赖；跳转策略留在调用方，client 只负责宣布「令牌已失效」。
- **登出**：尽力调 `/api/auth/logout` 清服务端会话，无论成败都清本地态（`clear()` 与 401、`/me` 失败三处共用）。

---

## 四、接口清单

| 方法     | 路径                                                       | 说明                                                                       |
| -------- | ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| `POST`   | `/api/auth/login`                                          | 登录，返回 `{ token, user }`                                               |
| `GET`    | `/api/auth/me`                                             | 当前用户信息，用于刷新页面后恢复登录态                                     |
| `POST`   | `/api/auth/logout`                                         | 登出，删除服务端会话                                                       |
| `GET`    | `/api/admin/stats`                                         | 总览：用户规模、会话与消息量、近 7 天消息趋势、知识库文档数                |
| `GET`    | `/api/admin/health`                                        | 运行状态：健康检查六项 + 运行时长 + MySQL 目标                             |
| `GET`    | `/api/admin/users?keyword=&page=&pageSize=`                | 用户列表（用户名包含匹配 + 分页，`pageSize` 上限 100）                     |
| `POST`   | `/api/admin/users`                                         | 新建用户，body `{ username, password, role }`，成功 201                    |
| `PATCH`  | `/api/admin/users/:id`                                     | 变更角色或状态，body `{ role?, status? }`                                  |
| `DELETE` | `/api/admin/users/:id`                                     | 删除用户，成功 204（连带清理其会话、对话与上传文件）                       |
| `GET`    | `/api/admin/knowledge/documents?keyword=&page=&pageSize=`  | 文档列表（管理视角，含各用户私有文档与归属账号名）                         |
| `POST`   | `/api/admin/knowledge/documents`                           | 新增全局共享文档，body `{ title, content }`，入库时同步完成切分与向量化    |
| `DELETE` | `/api/admin/knowledge/documents/:id`                       | 删除任意文档（连同其向量片段），成功 204                                   |
| `GET`    | `/api/admin/conversations?keyword=&page=&pageSize=`        | 会话列表（全账号，按标题包含匹配 + 分页）                                  |
| `GET`    | `/api/admin/conversations/:id`                             | 会话详情（含全部消息，工具 / 附件 / 检索来源还原为标签）                   |
| `DELETE` | `/api/admin/conversations/:id`                             | 删除任意会话（消息一并清除），成功 204                                     |
| `GET`    | `/api/admin/files?keyword=&page=&pageSize=`                | 文件列表（全账号，按文件名包含匹配 + 分页）                                |
| `DELETE` | `/api/admin/files/:id`                                     | 删除文件（元数据与落盘字节一并清理），成功 204                             |
| `GET`    | `/api/admin/logs?keyword=&method=&status=&page=&pageSize=` | 接口日志（路径关键词 + 方法白名单 + 状态档位 `all` / `client` / `server`） |
| `GET`    | `/api/admin/audit?keyword=&page=&pageSize=`                | 操作审计（按请求路径包含匹配 + 分页），只记管理端写操作                    |
| `GET`    | `/api/admin/system/tools`                                  | LLM 工具清单（名称、用途、参数名），只读                                   |
| `GET`    | `/api/admin/system/config`                                 | 运行配置只读视图，密钥类只回「是否已配置」                                 |

失败语义：权限不足按「资源不存在」返回 404；用户名冲突按「参数非法」返回 400；「不能停用或降级当前登录账号」「至少保留一个可登录的管理员账号」等自锁规则由后端返回 400 与对应文案，前端只做展示，不重复实现规则。

`listAdminTools` 是个例外：服务端与其他列表接口一致地回 `{ items }` 信封，本函数就地解包，让页面拿到的是清单本身——工具清单数量固定且少，不值得再包一层分页结构。

---

## 五、页面与组件

**页面**

- **总览**：顶部四张指标卡（用户 / 会话 / 消息 / 知识库文档）+ 运行状态条（服务名、提供方与模型、知识库是否启用、运行时长、MySQL 目标）+ 近 7 天消息趋势折线图。
- **用户管理**：关键词搜索 + 分页表格，行内直接改角色与状态、新建用户（`UserFormDialog`）、删除需二次确认。当前登录账号所在行的角色与状态控件禁用——自锁规则后端也会拦，禁用只是少一次注定失败的往返。
- **知识库管理**：管理视角的文档列表（全局与各用户私有文档一并可见，私有文档带归属账号名），可新增全局共享文档（`KnowledgeFormDialog`）、删除任意文档（连同其向量片段）。
- **会话管理**：全账号会话列表（标题、归属账号、消息数、更新时间），支持按标题搜索、经弹窗查看会话详情（含全部消息）与删除会话。
- **文件管理**：全账号上传文件列表（文件名、类型、大小、归属账号、上传时间），支持按文件名搜索与删除（元数据与落盘字节一并清理）。
- **接口日志**：路径关键词 + 请求方法 + 状态档位三重过滤 + 分页，详情弹窗展示请求 ID、查询串、请求体、响应体与错误摘要（服务端已脱敏并截断）。三个过滤维度全走服务端，避免列表与总数对不上。
- **操作审计**：管理端写操作的留档列表（操作人、方法、路径、状态、时间），详情弹窗看请求体摘要。只读，记录由服务端中间件自动登记。
- **LLM 工具**：工具清单，展示名称、用途与参数名。清单取自服务端运行时注入 Agent 的同一份工具定义，不另存第二份；因数量少、描述长短悬殊，用清单式布局而非表格。
- **系统配置**：运行配置只读视图（端口、数据目录、模型与温度、切分参数、上传上限、日志级别、MySQL 目标等），密钥类一律只显示「已配置 / 未配置」，明文不出服务端。
- **登录**：独立布局，成功即进总览。
- **[`[...all].vue`](../admin-web/src/pages/[...all].vue)**：仅兜底未匹配的路径，侧边栏入口已全部指向具体页面。

**组件**（均按 `Xxx/{index.ts, Xxx.vue, Xxx.less}` 目录化，`index.ts` 用 `export { default } from './Xxx.vue'` 导出）

| 组件                  | 职责                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DataTable`           | 泛型表格（`generic="T extends object"`），列由 `ColumnSpec` 数组描述；`selectable` 打开行选择，经 `v-model:selected-keys` 双向绑定，表头复选框只作用于当前页 |
| `PageBar`             | 分页条，受控于 `page` / `pageSize` / `total`，含上一页 / 下一页与「跳至指定页」（越界收敛到首尾页）                                                          |
| `BatchBar`            | 批量操作条：展示已选条数，动作按钮由默认插槽提供，另带取消选择                                                                                               |
| `SearchBar`           | 关键词输入 + 搜索按钮                                                                                                                                        |
| `ModalDialog`         | 弹窗骨架（遮罩、标题栏、内容插槽、底部取消与确认），`loading` 期间锁关闭                                                                                     |
| `UserFormDialog`      | 基于 `ModalDialog` 的新建用户表单（用户名 / 密码 / 角色）                                                                                                    |
| `KnowledgeFormDialog` | 基于 `ModalDialog` 的新增全局文档表单（标题 / 正文）                                                                                                         |
| `MessageTrendChart`   | 基于 echarts 的消息趋势折线图，随容器尺寸自适应                                                                                                              |

---

## 六、样式与令牌

- 色值一律走 CSS 变量，令牌集中在 `src/styles/tokens.less`，组件内不写死颜色。
- 令牌里 `--danger` / `--success` 各有一个 `-strong` 变体，用于「深色语义文字压浅色底」的场景（状态徽标、错误提示条）：原色叠在各自的 `-soft` 底上对比度只有 3.0~4.0:1，达不到正文所需的 4.5:1。
- 记录性字段（路径、请求 ID、时间、字节数）统一走等宽令牌，列对齐后更容易逐行比对；分隔线用 `--border`（本包没有桌面端的 `--gold-line`）。
- 组件与页面的私有样式都落在同目录 `.less`，由 `.vue` 以 `<style src="./Xxx.less" lang="less" scoped>` 引入（`App.vue` 例外，保持内联 scoped）；只有被两个及以上组件复用的样式才提到 `styles/`。页面同此——超过 200 行的页面已把样式抽到同目录同名 `.less`，模板留在 `.vue`，逻辑抽到同目录同名 `.ts`。
- 类名用 BEM（`admin-layout__nav-item--active`），嵌套保持浅层。

---

## 七、开发与构建

```bash
pnpm --filter @repo/admin-web run dev      # vite dev，默认 5173
pnpm --filter @repo/admin-web run build    # vue-tsc --noEmit + vite build
pnpm --filter @repo/admin-web run preview  # 预览构建产物
```

- 开发期 `/api` 由 `vite.config.ts` 的 proxy 转发到 `http://localhost:3000`（`agent-server` 的默认端口），因此本机先把后端跑起来；`baseURL` 留空走同源，生产期由反向代理统一接入，前端不感知后端真实地址。
- 后端在 `apps/agent-server`，需要先建好管理员账号（或用运维超级令牌调 `POST /api/admin/users` 建一个）才能登录。
- 质量校验走根脚本：`pnpm lint`（ESLint + Prettier）与 `pnpm test`（本包暂无单测，测试编写位置约定为 `src/__vitest__/`）；改了路由或类型后建议单独跑一次 `pnpm --filter @repo/admin-web run build`，它包含 `vue-tsc --noEmit` 全量类型检查。

---

## 八、交付状态与待办

P1 交付「总览 + 用户管理」，P2 交付其余七个模块（知识库、会话、文件、接口日志、操作审计、LLM 工具、系统配置）。侧边栏入口均已指向具体页面，`[...all].vue` 只作兜底。

尚未立项的调整已在评审中拍板为**维持现状**，理由见 [`docs/adr/0002`](../../docs/adr/0002-contract-type-sharing-boundary.md)：

- `api/types.ts` 不从 `@repo/reusable` 复用——两端同名字段并不同构，合并会让桌面端看到管理端专属字段；
- 页面内联 scoped 样式不再抽公共 `.less`——它们各页专属，抽出来只会是一堆单调用点的类；分页/筛选态仍是各页局部状态，不因 `usePagedList` 引入 store；
- 状态管理继续用 pinia——`auth` 跨路由存活（顶栏、守卫、401 回跳都要用）是 store 的正例，其余页面的分页与筛选属组件局部状态。
