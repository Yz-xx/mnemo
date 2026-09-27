# @repo/logger Node 端日志库

Node 环境的结构化日志库，供后端服务共用。包定位：**依赖进程与文件系统，只在 Node 端使用**；纯粹的通用工具请放 `@repo/shared`，与业务约定绑定的可复用代码请放 `@repo/reusable`，`apps/*` 之间禁止互相 import。

仓库整体架构、统一命令与跨端约束见根 [README](../../README.md)。

---

## 一、导出能力

统一出口为 `src/index.ts`，业务方只需从 `@repo/logger` 引入。

| 导出                                                                            | 说明                                                                                                                                                  |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createLogger(options)`                                                         | 组装日志实例：`name` / `level` 必填，`dir` 决定文件输出（留空只输出控制台），`retentionDays` 默认 14 天，`stdio` 默认开启，`sinks` 供注入额外输出目标 |
| `Logger` / `LoggerOptions` / `LogLevel` / `LogFields` / `LogRecord` / `LogSink` | 类型定义；业务只依赖 `Logger`，不感知输出实现                                                                                                         |
| `preview(value, maxLength)`                                                     | 压成单行并截断，用于入参出参摘要                                                                                                                      |
| `redactValue(value)` / `redactFields(fields)`                                   | 按字段名遮蔽密码 / 令牌，递归上限 4 层                                                                                                                |
| `formatRecord(record, options)` / `formatDay(time)`                             | 文本渲染（含颜色开关）与本地日期（`YYYY-MM-DD`）                                                                                                      |

### 使用

```ts
import { createLogger } from '@repo/logger';

const logger = createLogger({
  name: 'agent-server',
  level: 'info',
  dir: 'logs',
  retentionDays: 14,
});

// 派生带固定字段的子日志，避免每条重复传 requestId
logger.child({ requestId: 'abcd1234' }).info('请求完成', { method: 'POST', status: 200 });
```

`name` 用于日志文件名前缀与写入失败时的降级提示：同日同目录下不同服务各写各的文件（`agent-server-2026-09-26.log`），清理超期文件时只处理自己前缀且日期格式合法的文件，不会误删他人内容。

被写入记录先经 `redactFields` 遮蔽敏感字段，再由 `formatRecord` 渲染：标量字段与消息同处首行便于 grep，多行文本与错误堆栈折叠成缩进块；字段中的 `path` 单独摘出固定渲染为第三列（时间、级别之后），既不与行尾重复，也便于按接口竖向扫读。文件输出不带 ANSI 颜色。

## 二、引用方式

跨包引用统一写 workspace 包名，不用相对路径穿透到其他包：

```ts
import { createLogger } from '@repo/logger';
import type { Logger } from '@repo/logger';
```

包已声明 `exports` 条件导出：`types` → `dist/index.d.ts`、`import` → `dist/index.mjs`、`require` → `dist/index.cjs`。本包无第三方运行时依赖，Node 内置模块在打包时外置。

> 跨包引用读取的是 `dist` 产物，改动本包后需先 `pnpm --filter @repo/logger run build`，使用方才能拿到最新类型与实现。

## 三、构建与测试

- `pnpm --filter @repo/logger run build`：先 `tsc --noEmit` 做类型检查，再由 `vite build`（库模式）产出 `dist/index.mjs`、`dist/index.cjs` 与 `dist/index.d.ts` 等类型声明；
- 产物保留空格与注释、开启 sourcemap，便于使用方调试。
- `pnpm --filter @repo/logger run test`：vitest 运行单测，用例位于 `src/__vitest__/`（覆盖级别过滤、格式化、脱敏、会话绑定、文件轮转与超期清理）。
