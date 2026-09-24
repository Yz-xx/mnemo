import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConversationStore } from './store.js';

// 部分环境对系统临时目录的文件删除受限，统一使用项目内的临时目录
const TEST_ROOT = path.resolve(process.cwd(), '.tmp');
fs.mkdirSync(TEST_ROOT, { recursive: true });

let dataDir: string;
let store: ConversationStore;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(TEST_ROOT, 'conversation-'));
  store = new ConversationStore(dataDir);
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('ConversationStore', () => {
  it('首次追加用户消息时自动创建会话并生成标题', () => {
    const conversation = store.append(undefined, 'user', '你好，请介绍一下你的能力');

    expect(conversation.title).toBe('你好，请介绍一下你的能力');
    expect(conversation.messages).toHaveLength(1);
    expect(store.list()).toHaveLength(1);
  });

  it('超出长度限制的标题会被截断', () => {
    const conversation = store.append(undefined, 'user', '一'.repeat(50));

    expect(conversation.title).toHaveLength(24);
    expect(conversation.title.endsWith('…')).toBe(true);
  });

  it('后续消息追加到同一会话并更新列表统计', () => {
    const created = store.append(undefined, 'user', '第一个问题');
    store.append(created.id, 'assistant', '第一个回答');

    const [summary] = store.list();
    expect(summary.id).toBe(created.id);
    expect(summary.messageCount).toBe(2);
    expect(store.get(created.id)?.messages[1].role).toBe('assistant');
  });

  it('数据写入文件后可被新实例读取', () => {
    const created = store.append(undefined, 'user', '持久化验证');

    const reloaded = new ConversationStore(dataDir);
    expect(reloaded.get(created.id)?.messages[0].content).toBe('持久化验证');
  });

  it('删除会话后列表为空', () => {
    const created = store.append(undefined, 'user', '待删除');

    expect(store.remove(created.id)).toBe(true);
    expect(store.list()).toHaveLength(0);
    expect(store.remove(created.id)).toBe(false);
  });

  it('非法 ID 不会触发文件读取', () => {
    expect(store.get('../../package.json')).toBeNull();
  });
});
