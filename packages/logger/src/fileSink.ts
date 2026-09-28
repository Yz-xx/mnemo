import type { LogSink } from './types.js';
import fs from 'node:fs';
import path from 'node:path';
import { formatDay } from './format.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const FILE_SUFFIX = '.log';

/** 日期部分格式：只有「前缀 + 合法日期」命名的文件才参与清理，避免误删目录内其它内容 */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface FileSinkOptions {
  dir: string;
  /** 服务名：决定文件名前缀，如 agent-server-2026-09-25.log */
  name: string;
  /** 保留天数：早于该天数的日志文件在启动与跨天轮转时清理 */
  retentionDays: number;
}

/**
 * 文件输出：按本地日期命名并滚动，命名可直接字符串比较出先后。
 * 前缀取服务名，同目录下多服务各写各的文件，清理时互不干扰；
 * 写入失败（磁盘满、目录无权限）只降级提示一次，绝不让日志拖垮服务本身。
 */
export function createFileSink({ dir, name, retentionDays }: FileSinkOptions): LogSink {
  const prefix = `${name}-`;
  let currentDay = '';
  let warned = false;

  /** 清理超期文件：只删自己前缀且日期合法的文件，避免误删同目录下其它内容 */
  function prune(): void {
    const cutoff = formatDay(new Date(Date.now() - retentionDays * DAY_MS));
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.startsWith(prefix) || !entry.endsWith(FILE_SUFFIX)) continue;
      const day = entry.slice(prefix.length, -FILE_SUFFIX.length);
      if (DAY_PATTERN.test(day) && day < cutoff) fs.rmSync(path.join(dir, entry), { force: true });
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
    return path.join(dir, `${prefix}${day}${FILE_SUFFIX}`);
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
          `[${name}] 日志文件写入失败，已降级为仅控制台输出：${String(error)}\n`,
        );
      }
    },
  };
}
