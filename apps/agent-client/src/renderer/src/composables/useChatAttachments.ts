// 待发送附件的管理：选中即上传换取服务端 ID，发送时取走已就绪的条目。
import type { ChatAttachment } from '../types';
import { ref } from 'vue';
import { openFile } from '../api/bridge';
import { isUnauthorized, toErrorMessage } from '../api/client';
import { agentApi } from '../api/session';

/** 本轮取走的已就绪附件：文件名用于展示，服务端 ID 用于随消息提交 */
export interface ReadyAttachments {
  names: string[];
  fileIds: string[];
}

/**
 * 待发送附件的管理。上传失败的原因留在该条附件上而非整体报错，
 * 用户可以单独移除它、不影响其余附件；令牌失效的处理归登录态层管，以回调注入。
 */
export function useChatAttachments(onUnauthorized: () => Promise<void>) {
  /** 待发送附件：选中即上传，发送成功后随本轮一起清空 */
  const attachments = ref<ChatAttachment[]>([]);

  /** 更新指定附件的部分字段：整表替换触发响应式，避免逐项改对象时漏掉更新 */
  function patch(key: string, changes: Partial<ChatAttachment>): void {
    attachments.value = attachments.value.map((item) =>
      item.key === key ? { ...item, ...changes } : item,
    );
  }

  /** 选择附件：选中后立刻上传换取服务端 ID，免得等到发送时才发现类型不支持 */
  async function addAttachment(): Promise<void> {
    const selected = await openFile();
    if (!selected) return;

    const attachment: ChatAttachment = {
      key: crypto.randomUUID(),
      name: selected.name,
      size: selected.size,
    };
    attachments.value = [...attachments.value, attachment];
    try {
      const stored = await agentApi.uploadFile(selected);
      patch(attachment.key, { fileId: stored.id });
    } catch (error) {
      if (isUnauthorized(error)) {
        await onUnauthorized();
        return;
      }
      patch(attachment.key, { error: toErrorMessage(error) });
    }
  }

  function removeAttachment(key: string): void {
    attachments.value = attachments.value.filter((item) => item.key !== key);
  }

  function clearAttachments(): void {
    attachments.value = [];
  }

  /**
   * 取走已就绪的附件（上传成功、拿到服务端 ID 的条目），并把它们从待发送列表移除。
   * 上传中或上传失败的仍留在输入区由用户处理，不能被无声吞掉。
   */
  function takeReadyAttachments(): ReadyAttachments {
    const ready = attachments.value.flatMap((item) =>
      item.fileId ? [{ name: item.name, fileId: item.fileId }] : [],
    );
    attachments.value = attachments.value.filter((item) => !item.fileId);
    return { names: ready.map((item) => item.name), fileIds: ready.map((item) => item.fileId) };
  }

  return { attachments, addAttachment, removeAttachment, clearAttachments, takeReadyAttachments };
}
