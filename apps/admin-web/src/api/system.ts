// 系统信息接口：LLM 工具清单与系统配置，均为只读。
// 统一经 adminApi 发请求，鉴权由请求头里的 Bearer 令牌承担，此处不再重复拼装。
import type { AdminSystemConfig, AdminToolItem } from './types';
import { adminApi } from './client';

/** LLM 工具清单：只读，取自服务端运行时注入 Agent 的同一份工具定义 */
export function listAdminTools(): Promise<AdminToolItem[]> {
  // 服务端与其他列表接口统一返回 { items } 信封，这里就地解包，页面拿到的就是清单本身
  return adminApi
    .request<{ items: AdminToolItem[] }>('/api/admin/system/tools')
    .then((result) => result.items);
}

/** 系统配置：只读，密钥类配置只回是否已配置 */
export function fetchSystemConfig(): Promise<AdminSystemConfig> {
  return adminApi.request<AdminSystemConfig>('/api/admin/system/config');
}
