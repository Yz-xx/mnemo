import type { ApiLogFlushOptions } from './batch.js';
import type { ApiLogEntry, ApiLogPage, ApiLogQuery } from '../../entities/apiLog.js';
import type { DbPool } from '../../infrastructure/db/pool.js';
import { writeApiLogBatch } from './batch.js';
import { listApiLogs } from './query.js';

/**
 * 接口请求日志：由请求日志中间件在响应结束时投递，管理端按路径、方法与状态档位查询。
 * 只追加不修改；写入改批量刷写——先入内存缓冲，攒够一批或定时到点再一次性落库，
 * 把「每请求一条 INSERT」的单轮基线降下来（见 docs/adr/0010 决策 13）。
 * 写入失败不影响已返回的响应，告警由 onError 兜底。
 * 查询 SQL 与批量写语句分别外提在 query.ts 与 batch.ts。
 */
export class ApiLogStore {
  private readonly buffer: ApiLogEntry[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** 刷写串行链：停机 flush() 会等上前一次在途刷写，避免 pool 先被关掉、日志没写完 */
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly pool: DbPool,
    private readonly options: ApiLogFlushOptions,
  ) {}

  /** 追加一条请求日志：只入内存缓冲，攒够批量或定时到点再落库 */
  record(entry: ApiLogEntry): void {
    this.buffer.push(entry);
    if (this.buffer.length >= this.options.batchSize) {
      void this.flush();
      return;
    }
    // 定时器 unref：批量刷写不该拖住进程退出；停机时由 flush() 兜底把剩余缓冲落尽
    this.timer ??= setTimeout(() => void this.flush(), this.options.flushIntervalMs).unref();
  }

  /**
   * 批量落库并清空缓冲。停机前 await 它即可确保已入队的日志全部写入——
   * 定时器被 unref 后不会自己触发，这条是「停机落尽」的唯一保证。
   * 写入排在串行链上：既不会与在途刷写并发写同一批，也让停机调用能等到它们收尾。
   */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = this.pending.then(() => this.writeBatch());
    return this.pending;
  }

  /** 取当前缓冲一次性写入；失败只回调 onError，不向上抛（不阻断后续刷写与停机） */
  private async writeBatch(): Promise<void> {
    if (this.buffer.length === 0) return;
    // 先取出再清空：写入期间新到的日志留在缓冲里等下一批，不会被本次误清
    const rows = this.buffer.splice(0, this.buffer.length);
    try {
      await writeApiLogBatch(this.pool, rows);
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  /** 管理端列表：按条件过滤 + 分页；实现见 query.ts */
  async list(query: ApiLogQuery): Promise<ApiLogPage> {
    return listApiLogs(this.pool, query);
  }
}
