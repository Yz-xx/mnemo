import type { AgentApi } from '../../api/client';
import type { Ref } from 'vue';
import { ref } from 'vue';
import { toErrorMessage } from '../../api/client';

interface KnowledgeUploadDeps {
  /** 操作提示位：上传结果与失败原因都写这里，与列表侧同源 */
  notice: Ref<string>;
  /** 地址取抽屉草稿、令牌取当前登录态的实例 */
  api: AgentApi;
  /** 入库目标库 ID 取值器：详情页当前库，为空表示还在库列表页 */
  getBaseId: () => string | null;
  /** 上传成功后回读列表：新文档要立刻出现，并触发解析中的轮询 */
  loadDocuments: () => Promise<void>;
}

export interface KnowledgeUploadControls {
  /** 已选中的本地文件：为空时上传按钮不可用 */
  file: Ref<File | null>;
  /** 上传字节进度（0–100） */
  progress: Ref<number>;
  uploading: Ref<boolean>;
  selectFile: (event: Event) => void;
  dropFile: (event: DragEvent) => void;
  upload: () => Promise<void>;
  cancel: () => void;
}

/** 服务端白名单的扩展名：前端先拦一次，免得把必然被拒的文件传上去 */
const ACCEPTED_EXTENSIONS = ['.txt', '.md', '.pdf', '.docx', '.xlsx'];

/**
 * 文件上传：进度与取消走 XHR，上传结束只代表文件已落盘；
 * 解析状态由列表轮询展示，这里不等待解析完成。拖拽投放与选择文件共用同一上传入口。
 */
export function useKnowledgeUpload({
  notice,
  api,
  getBaseId,
  loadDocuments,
}: KnowledgeUploadDeps): KnowledgeUploadControls {
  const file = ref<File | null>(null);
  const progress = ref(0);
  const uploading = ref(false);
  /** 当前上传的取消入口：同一时刻只允许一个上传，结束即置空 */
  let controller: AbortController | null = null;

  /** 选文件：只做本地暂存，点上传按钮才真正提交 */
  function selectFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const selected = input.files?.[0] ?? null;
    input.value = '';
    if (!selected) return;
    if (!isAccepted(selected)) {
      notice.value = '仅支持 txt / md / pdf / docx / xlsx 文件';
      return;
    }
    file.value = selected;
    progress.value = 0;
    notice.value = '';
  }

  /** 拖拽投放：取第一个文件并直接上传，少一次「还要再点按钮」的停顿 */
  function dropFile(event: DragEvent): void {
    if (uploading.value) return;
    const dropped = event.dataTransfer?.files?.[0];
    if (!dropped) return;
    if (!isAccepted(dropped)) {
      notice.value = '仅支持 txt / md / pdf / docx / xlsx 文件';
      return;
    }
    file.value = dropped;
    progress.value = 0;
    notice.value = '';
    void upload();
  }

  async function upload(): Promise<void> {
    const targetBase = getBaseId();
    const selected = file.value;
    if (!selected || uploading.value) return;
    if (!targetBase) {
      notice.value = '请先进入一个知识库';
      return;
    }

    const current = new AbortController();
    controller = current;
    uploading.value = true;
    progress.value = 0;
    notice.value = '';
    try {
      const document = await api.uploadKnowledgeFile(targetBase, selected, {
        onProgress: (percent) => {
          progress.value = percent;
        },
        signal: current.signal,
      });
      file.value = null;
      notice.value = `「${document.title}」已上传，正在解析`;
      // 刚上传的文档处于 processing：刷新一次后由列表轮询接管后续状态
      await loadDocuments();
    } catch (error) {
      progress.value = 0;
      // 用户主动取消不算失败，提示要与真实错误区分
      notice.value = isAborted(error) ? '已取消上传' : toErrorMessage(error);
    } finally {
      uploading.value = false;
      controller = null;
    }
  }

  function cancel(): void {
    controller?.abort();
  }

  return { file, progress, uploading, selectFile, dropFile, upload, cancel };
}

/** 扩展名初筛：服务端仍会按文件头复核，这里只是省掉一次必然失败的请求 */
function isAccepted(file: File): boolean {
  const name = file.name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/** XHR 取消以标准 AbortError 收尾，据此与真实上传失败区分 */
function isAborted(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
