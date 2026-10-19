import type { AdminConversationDetail, AdminConversationSummary } from '@/api/types';
import type { Ref } from 'vue';
import { ref } from 'vue';
import { fetchAdminConversation } from '@/api';

interface ConversationsDetailDeps {
  /** 失败原因回落到列表上方的错误条 */
  errorMsg: Ref<string>;
}

export interface ConversationsDetailControls {
  detail: Ref<AdminConversationDetail | null>;
  detailLoading: Ref<boolean>;
  openDetail: (row: AdminConversationSummary) => Promise<void>;
  closeDetail: () => void;
}

/**
 * 详情抽屉：先开窗再取内容，避免点击后界面无反馈。
 * 列表的错误位经参数注入，本 hook 不反向依赖页面入口。
 */
export function useConversationsDetail({
  errorMsg,
}: ConversationsDetailDeps): ConversationsDetailControls {
  const detail = ref<AdminConversationDetail | null>(null);
  const detailLoading = ref(false);

  /** 关闭详情：两个状态必须一并复位，否则「加载中关闭」时弹窗仍挂在 v-if 上 */
  function closeDetail(): void {
    detailLoading.value = false;
    detail.value = null;
  }

  async function openDetail(row: AdminConversationSummary): Promise<void> {
    detailLoading.value = true;
    detail.value = null;
    errorMsg.value = '';
    try {
      const result = await fetchAdminConversation(row.id);
      // 请求返回前用户可能已关闭弹窗：此时不再写回，否则弹窗会自己弹回来
      if (detailLoading.value) detail.value = result;
    } catch (e) {
      errorMsg.value = (e as Error).message || '加载会话详情失败';
    } finally {
      detailLoading.value = false;
    }
  }

  return { detail, detailLoading, openDetail, closeDetail };
}
