import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listAuditLogs } from '@/api/audit';
import { setSessionExpiredHandler } from '@/api/client';
import { listAdminConversations } from '@/api/conversations';
import { listAdminFiles } from '@/api/files';
import { listKnowledgeDocuments } from '@/api/knowledge';
import { listApiLogs } from '@/api/logs';
import { listUsers } from '@/api/users';
import { installMemoryStorage } from './storageStub';

// 特征化测试：锁住 6 个列表接口当前产出的查询串与键序。
// 迁移到通用客户端的 params 后，查询串必须逐字不变（含空串 keyword 不被丢弃），
// 否则服务端「keyword 为空 = 不过滤」的口径会从「空参」变成「缺参」。

/** 用真实 Response 顶替 fetch，返回替身供断言请求地址 */
function stubFetch() {
  const mock = vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify({ items: [], total: 0, page: 1, pageSize: 20 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('管理端列表接口的查询串', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    installMemoryStorage();
    vi.clearAllMocks();
    // 失效回调是模块级状态，先换成空实现，免得被本组用例意外触发
    setSessionExpiredHandler(() => {});
  });

  it('用户列表：keyword / page / pageSize 顺序不变，空串照常产出 keyword=', async () => {
    const fetchMock = stubFetch();

    await listUsers({ keyword: '', page: 1, pageSize: 20 });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/users?keyword=&page=1&pageSize=20',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('文件列表：查询串同形', async () => {
    const fetchMock = stubFetch();

    await listAdminFiles({ keyword: '', page: 2, pageSize: 10 });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/files?keyword=&page=2&pageSize=10',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('知识库文档列表：查询串同形', async () => {
    const fetchMock = stubFetch();

    await listKnowledgeDocuments({ keyword: '', page: 2, pageSize: 10 });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/knowledge/documents?keyword=&page=2&pageSize=10',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('会话列表：查询串同形', async () => {
    const fetchMock = stubFetch();

    await listAdminConversations({ keyword: '', page: 2, pageSize: 10 });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/conversations?keyword=&page=2&pageSize=10',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('审计列表：查询串同形', async () => {
    const fetchMock = stubFetch();

    await listAuditLogs({ keyword: '', page: 2, pageSize: 10 });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/audit?keyword=&page=2&pageSize=10',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('接口日志列表：method / status 也参与，键序不变', async () => {
    const fetchMock = stubFetch();

    await listApiLogs({ keyword: '', method: 'GET', status: 'all', page: 3, pageSize: 5 });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/logs?keyword=&method=GET&status=all&page=3&pageSize=5',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});
