import fs from 'node:fs';
import path from 'node:path';
import { formatDay } from './format.js';
import type { LogSink } from './types.js';

/** 按天轮转的日志文件名，例如 backend-2026-09-25.log */
const FILE_NAME = /^backend-(\d{4}-\d{2}-\d{2})\.log$/;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface FileSinkOptions {
  dir: string;
  /** 保留天数：早于该天数的日志文件在启动与跨天轮转时清理 */
  retentionDays: number;
}

/**
 * 文件输出：按本地日期命名并滚动，命名可直接字符串比较出先后。
 * 写入失败（磁盘满、目录无权限）只降级提示一次，绝不让日志拖垮服务本身。
 */
export function createFileSink({ dir, retentionDays }: FileSinkOptions): LogSink {
  let currentDay = '';
  let warned = false;

  /** 清理超期文件：只删符合命名规则的文件，避免误删目录内其它内容 */
  function prune(): void {
    const cutoff = formatDay(new Date(Date.now() - retentionDays * DAY_MS));
    for (const name of fs.readdirSync(dir)) {
      const day = FILE_NAME.exec(name)?.[1];
      if (day && day < cutoff) fs.rmSync(path.join(dir, name), { force: true });
    }
  }

  /** 定位当天文件：跨天时重建目录（可能被外部清理）并顺带清理超期文件 */
  function target(): string {
    const day = formatDay(new Date());
    if (day !== currentDay) {
      currentDay = day;
      fs.mkdirSync(dir, { recursive: true });
      prune();
    }
    return path.join(dir, `backend-${day}.log`);
  }

  return {
    color: false,
    write(line) {
      try {
        fs.appendFileSync(target(), `${line}\n`, 'utf8');
      } catch (error) {
        if (warned) return;
        warned = true;
        process.stderr.write(
          `[backend] 日志文件写入失败，已降级为仅控制台输出：${String(error)}\n`,
        );
      }
    },
  };
}
