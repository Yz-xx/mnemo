# 后台账号与客户端账号隔离，管理权限分超管与管理员两级

同一账号在管理后台与桌面客户端会互相顶掉：两端共用 `POST /api/auth/login`，而 `SessionStore.create()` 在签发新会话前会清空该用户的全部旧会话，于是后登录的一方顶掉先登录的一方。这是产品取舍而非缺陷修复——本文记录选定的语义，以及随之而来的账号模型与权限分级。

## 现状

- 三端共用一张 `users` 表，`role ENUM('admin','user') NOT NULL DEFAULT 'user'`，列注释为「admin 可登录管理后台」，即 `role` 表达的是**能否进后台**，不是**只能进哪里**。
- **登录接口不区分端**：客户端 `POST /api/auth/login` 完全不看 `role`，只校验口令与 `status`；后台复用同一个接口。因此 admin 账号可以在客户端登录，这才是「两端互顶」的根源。
- 后台**接口层**已要求 `role='admin'`（`requireAdmin`），后台**前端**守卫登录后也会查 `role` 把人踢回；客户端接口只要求登录。
- 客户端 `POST /api/auth/register` **公开且无鉴权**，而 `UserStore.register()` 带「库中还没有任何用户 → 首个注册者自动成为 admin」的自举（注释写明是为了让管理后台能自动完成初始化）。
- `requireAdmin` 另接受 `x-admin-token`（配置项 `KNOWLEDGE_ADMIN_TOKEN`）这条**不绑定具体账号**的运维通道，其审计条目 `actor_id` 记为 NULL。

## 决策

1. **账号与端绑定**：一个账号只属于一端。客户端登录只接受 `user`，后台登录只接受后台角色。于是「同账号两端互顶」从根上消失——不是被容纳，而是不再可能发生。`user_sessions` 表结构与 `SessionStore.create()` / `prune()` 的单端语义**保持不变**。
2. **登录入口按端拆分**：新增 `POST /api/admin/auth/login`；客户端保持 `/api/auth/login`。**端由路径承载**，不让调用方传字段自证身份。
3. **角色分三级**：`super_admin` / `admin` / `user`。代码里以常量 `ADMIN_ROLES = ['super_admin', 'admin']` 表示「后台侧」，避免判定散落成多处 `||`。
4. **超管由启动自举创建**：读环境变量 `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD`，**仅当库中没有任何后台侧账号时**创建；已存在则跳过，不覆盖。未配置时启动告警而非静默跳过。
5. **注册收口**：客户端注册固定产出 `role='user'`，删除 `UserStore.register()` 的「首个注册者变 admin」自举；后台不设注册入口，后台账号只能由超管在用户管理里创建。
6. **权限只在「用户管理」模块分级**：超管可管理**所有**账号；admin 只能操作 `role='user'` 的账号。其余模块（总览 / 日志 / 审计 / 会话 / 文件 / 知识库 / 系统）两者权限**相同**，`requireAdmin` 无需改动，差异下沉到 `routes/admin/users.ts` 内部按调用者角色分支。
7. **`x-admin-token` 保留，权限等价超管**：它是超管丢号或被误停时唯一的结构性后路；若只给 admin 权限，应急场景下照样管不了后台账号。

## Considered Options

- **维持单端不隔离，只补「你已在别处登录」的提示**：改动最小，但「admin 用客户端」这条路径仍然存在，顶号照旧，也不解决空库抢注。否决。
- **分端会话（同账号两端各留一条会话）**：需要给服务端引入「端」概念、`user_sessions` 加列、唯一键改 `(user_id, client_type)`、`prune()` 改口径、存量行补默认值。它**容纳**问题而不是消除问题，隔离后已无必要。否决。
- **后台账号单独建表**（`admin_users` + `users`，连会话一起拆成 `admin_sessions` / `client_sessions`）：结构性隔离最干净——admin 令牌物理上不可能命中 client 会话；但代价是两个 store、两套会话实例、一次拆表迁移与审计 `actor_id` 语义改造，而隔离目标单表方案已完全达成。否决。
- **`user_sessions` 加 `user_type` 判别列**：判别列只是把「端」从 `users` 挪到 `user_sessions`，隔离从结构性降级为行为性。否决。
- **用户管理模块不分级**（所有 admin 权限相同）：表结构零改动，但无法表达「只有超管能管后台账号」。否决。

## Consequences

- **MySQL 改 ENUM 是重写表**：`users.role` 由两值扩为三值会触发表重建，回滚成本高，上线前需备份。
- **上线顺序必须是「先配环境变量、再上代码」**：否则代码先上而 env 未配，空库启动时自举因无凭据告警跳过，系统仍然进不去。
- **存量 `admin` 账号需迁移为 `super_admin`**：否则新模型下没有任何超管，用户管理模块的后台账号分支无人可用。
- **同端多处登录仍会互顶**（如超管在两台电脑登录后台）：这是刻意保留的单端语义，符合预期。
- **登录失败分两种口径**：口令错或账号不存在沿用现有的含糊提示（不暴露账号是否注册）；而**口令已通过、只是端不匹配**时可以明确告知，因为对方此时已证明自己持有该账号，含糊反而会让人误以为密码错了。
- **admin 不能停用后台账号**这条尤其关键：否则一个 admin 可以把超管停掉，把系统锁死。
- **列表可见性也是权限**：admin 的用户列表里**根本不该出现**后台账号，而不只是「不能操作」——否则会诱导操作、并泄露后台账号数量。

## 落地要点

- **后端**：`db/schema.ts`（ENUM 扩三值 + 迁移项）、`auth/userStore.ts`（`UserRole`、删自举、新增「确保超管存在」与按角色过滤的 list）、`auth/middleware.ts`（`requireAdmin` 判定改走 `ADMIN_ROLES`，并把调用者身份暴露给用户管理模块）、**新增** `routes/admin/auth.ts`、`routes/client/auth.ts`（登录加 role 判定、注册固定 `user`）、`routes/admin/users.ts`（按调用者角色分支：列表过滤、禁建/禁改后台账号、禁提权）、`routes/index.ts`（挂载 `/api/admin/auth`，须排在 `/api/admin` 总览之前）、`configuration/config.ts` 与两份 `.env`、组合根 `index.ts`（启动自举）。
- **前端**：admin-web 登录地址改为 `/api/admin/auth/login`、登录失败文案、用户管理页对 admin 隐藏后台账号并固定角色选项；agent-client 登录失败文案。
- **测试**：`authRoute.test.ts`（客户端拒 admin 账号、注册产 `user`）、后台登录新用例、自举用例（空库创建 / 已存在则跳过）、用户管理权限矩阵用例；`adminAuth.test.ts` 与 `adminRoutes.test.ts` 连带复核。
- **前端契约类型**：`role` 的三值同步到 admin-web 与 agent-client 各自的类型定义，按仓库惯例**不上提** `@repo/reusable`（跨端字段不同构）。
