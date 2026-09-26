import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatDay } from '../format.js';
import { createLogger } from '../index.js';
import { preview } from '../preview.js';
import { redactValue } from '../redact.js';
import type { LogSink } from '../types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// 部分环境对系统临时目录的文件删除受限，统一使用包目录内的临时目录
const TEST_ROOT = path.resolve(process.cwd(), '.tmp');
fs.mkdirSync(TEST_ROOT, { recursive: true });

/** 内存输出目标：不落盘、不带颜色，便于直接断言格式化后的文本 */
function memorySink(): { lines: string[]; sink: LogSink } {
  const lines: string[] = [];
  return { lines, sink: { color: false, write: (line) => void lines.push(line) } };
}

const createdDirs: string[] = [];

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(TEST_ROOT, `logger-${label}-`));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('日志级别', () => {
  it('低于当前级别的记录不输出', () => {
    const { lines, sink } = memorySink();
    const logger = createLogger({ name: 'test', level: 'warn', stdio: false, sinks: [sink] });

    logger.debug('调试信息');
    logger.info('普通信息');
    logger.warn('告警信息');
    logger.error('错误信息');

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('告警信息');
    expect(lines[1]).toContain('错误信息');
  });
});

describe('日志格式', () => {
  it('消息与标量字段同处一行，未赋值字段不输出', () => {
    const { lines, sink } = memorySink();
    const logger = createLogger({ name: 'test', level: 'info', stdio: false, sinks: [sink] });

    logger.info('请求完成', { method: 'POST', status: 200, userId: undefined });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} INFO\s+请求完成 method=POST status=200$/,
    );
    expect(lines[0]).not.toContain('userId');
  });

  it('错误字段展开为带堆栈的缩进块，便于直接阅读', () => {
    const { lines, sink } = memorySink();
    const logger = createLogger({ name: 'test', level: 'info', stdio: false, sinks: [sink] });

    logger.error('请求处理失败', { path: '/api/chat', error: new Error('连接被拒绝') });

    expect(lines).toHaveLength(1);
    expect(lines[0].split('\n')[0]).toContain('/api/chat 请求处理失败');
    expect(lines[0]).toContain('\n    error:\n');
    expect(lines[0]).toContain('Error: 连接被拒绝');
  });

  it('超长字段折叠为缩进块，首行只留短字段', () => {
    const { lines, sink } = memorySink();
    const logger = createLogger({ name: 'test', level: 'info', stdio: false, sinks: [sink] });

    logger.info('请求完成', {
      path: '/api/chat',
      requestBody: `{"content":"${'长'.repeat(120)}"}`,
    });

    const [header, ...rest] = lines[0].split('\n');
    expect(header).toContain('/api/chat 请求完成');
    expect(header).not.toContain('requestBody');
    expect(rest[0]).toBe('    requestBody:');
    expect(rest[1].trimStart().startsWith('{"content"')).toBe(true);
  });

  it('接口路径固定为第三列，且不在行尾重复出现', () => {
    const { lines, sink } = memorySink();
    const logger = createLogger({ name: 'test', level: 'info', stdio: false, sinks: [sink] });

    logger.info('请求完成', { method: 'GET', path: '/api/health', status: 200 });

    expect(lines[0]).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} INFO\s+\/api\/health 请求完成 method=GET status=200$/,
    );
    expect(lines[0]).not.toContain('path=/api/health');
  });
});

describe('报文预览', () => {
  it('超长报文截断并标注原始长度', () => {
    const text = preview({ content: 'x'.repeat(600) }, 100);

    expect(text).toContain('已截断');
    expect(text).toMatch(/共 \d+ 字符/);
    expect(text.length).toBeLessThan(140);
  });

  it('多行文本压成一行，短内容原样返回', () => {
    expect(preview('a\nb\n\nc', 50)).toBe('a b c');
    expect(preview({ id: 1 }, 50)).toBe('{"id":1}');
  });
});

describe('敏感信息脱敏', () => {
  it('密码与令牌被遮蔽，原文不进入输出', () => {
    const { lines, sink } = memorySink();
    const logger = createLogger({ name: 'test', level: 'info', stdio: false, sinks: [sink] });

    logger.info('登录请求', {
      username: 'alice',
      password: 'p@ssw0rd',
      authorization: 'Bearer secret-token',
      extra: { apiKey: 'sk-1234' },
    });

    expect(lines[0]).toContain('username=alice');
    expect(lines[0]).toContain('***');
    expect(lines[0]).not.toContain('p@ssw0rd');
    expect(lines[0]).not.toContain('secret-token');
    expect(lines[0]).not.toContain('sk-1234');
  });

  it('数组形态的报文同样被脱敏', () => {
    expect(redactValue([{ token: 't-1' }, { name: 'ok' }])).toEqual([
      { token: '***' },
      { name: 'ok' },
    ]);
  });
});

describe('子日志', () => {
  it('绑定字段随每条记录输出，并支持逐层累加', () => {
    const { lines, sink } = memorySink();
    const logger = createLogger({ name: 'test', level: 'info', stdio: false, sinks: [sink] });

    logger.child({ requestId: 'abcd1234' }).child({ conversationId: 'c-1' }).info('本轮对话完成');

    expect(lines[0]).toContain('requestId=abcd1234');
    expect(lines[0]).toContain('conversationId=c-1');
  });
});

describe('日志文件', () => {
  it('按天写入以服务名作前缀的文件，且不含颜色转义码', () => {
    const dir = tempDir('file');
    const logger = createLogger({
      name: 'test',
      level: 'info',
      dir,
      retentionDays: 14,
      stdio: false,
    });

    logger.info('智能体服务已启动', { port: 3000 });

    const file = path.join(dir, `test-${formatDay(new Date())}.log`);
    expect(fs.existsSync(file)).toBe(true);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('智能体服务已启动 port=3000');
    expect(text).not.toContain('\u001b[');
  });

  it('清理超期文件，但保留其它前缀与不符合命名规则的文件', () => {
    const dir = tempDir('prune');
    const staleDay = formatDay(new Date(Date.now() - 3 * DAY_MS));
    const stale = path.join(dir, `test-${staleDay}.log`);
    // 同目录下其它服务写入的文件，以及命名不符合规则的文件，都不应被清理
    const otherService = path.join(dir, `api-${staleDay}.log`);
    const unrelated = path.join(dir, 'other.log');
    fs.writeFileSync(stale, '旧日志\n');
    fs.writeFileSync(otherService, '其它服务的日志\n');
    fs.writeFileSync(unrelated, '无关文件\n');

    const logger = createLogger({
      name: 'test',
      level: 'info',
      dir,
      retentionDays: 1,
      stdio: false,
    });
    logger.info('触发清理');

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(otherService)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
  });
});
