import type { ChatCitation } from '../../types';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Ref } from 'vue';
import { computed, nextTick, ref, watch } from 'vue';
import { toErrorMessage } from '../../api/client';
import { agentApi } from '../../api/session';
import { splitHighlight } from './highlight';
import { loadPdf, renderPdfPage } from './pdf';

/** 抽屉当前展示的原文形态：null 表示尚在加载 */
export type PreviewKind = 'text' | 'pdf' | 'unsupported' | null;

/** 抽屉的展示状态与翻页动作，模板只负责装配 */
export interface CitationDrawerControls {
  kind: Ref<PreviewKind>;
  loading: Ref<boolean>;
  errorMessage: Ref<string>;
  /** 文本类全文按摘要命中切成高亮段 */
  segments: Ref<ReturnType<typeof splitHighlight>>;
  pageNumber: Ref<number>;
  pageCount: Ref<number>;
  changePage: (delta: number) => Promise<void>;
}

/**
 * 引用抽屉的数据加载：按引用取原始文件，文本类切高亮段，PDF 类交给 pdfjs 渲染。
 * 切换引用时用请求序号丢弃过期响应——快速连点两条引用时，先发的请求可能后到。
 */
export function useCitationDrawer(
  citation: Ref<ChatCitation>,
  canvas: Ref<HTMLCanvasElement | null>,
): CitationDrawerControls {
  const kind = ref<PreviewKind>(null);
  const loading = ref(false);
  const errorMessage = ref('');
  const textContent = ref('');
  const pageNumber = ref(1);
  const pageCount = ref(0);

  const segments = computed(() => splitHighlight(textContent.value, citation.value.snippet));
  // 每次加载递增：只有最后一次发出的请求可以写状态
  let loadSeq = 0;
  let pdfDocument: PDFDocumentProxy | null = null;

  const renderCurrentPage = async (): Promise<void> => {
    if (!pdfDocument || !canvas.value) return;
    await renderPdfPage(pdfDocument, pageNumber.value, canvas.value);
  };

  const changePage = async (delta: number): Promise<void> => {
    const next = Math.min(Math.max(1, pageNumber.value + delta), pageCount.value);
    if (next === pageNumber.value) return;
    pageNumber.value = next;
    await renderCurrentPage();
  };

  watch(
    citation,
    async (target) => {
      const requestId = ++loadSeq;
      // 切换引用先清空上一次的形态，避免新标题下短暂显示旧文档
      kind.value = null;
      loading.value = true;
      errorMessage.value = '';
      textContent.value = '';
      pageCount.value = 0;
      pageNumber.value = 1;
      // 只释放页面缓存：worker 由加载任务统一管理，文档代理没有 destroy。
      // 释放失败不影响后续加载（下次加载会新建文档），故只吞掉错误，不打断切换
      pdfDocument?.cleanup().catch(() => undefined);
      pdfDocument = null;

      try {
        const preview = await agentApi.previewDocument(target.documentId);
        if (requestId !== loadSeq) return;

        if (preview.kind === 'text') {
          kind.value = 'text';
          textContent.value = preview.content;
          return;
        }
        if (preview.blob.type !== 'application/pdf') {
          // DOCX / XLSX 的内容是压缩包，无法直接展示；不提供下载入口，避免半成品交互
          kind.value = 'unsupported';
          return;
        }

        const document = await loadPdf(preview.blob);
        if (requestId !== loadSeq) {
          // 过期响应：释放刚加载的文档缓存，不写状态
          await document.cleanup();
          return;
        }
        pdfDocument = document;
        pageCount.value = document.numPages;
        // 页码越界时回落到第一页：旧数据或解析差异可能给出不存在的页
        pageNumber.value = target.page && target.page <= document.numPages ? target.page : 1;
        kind.value = 'pdf';
        // 等 canvas 随 kind 渲染出来后再画
        await nextTick();
        await renderCurrentPage();
      } catch (error) {
        if (requestId === loadSeq) errorMessage.value = toErrorMessage(error);
      } finally {
        if (requestId === loadSeq) loading.value = false;
      }
    },
    { immediate: true },
  );

  return { kind, loading, errorMessage, segments, pageNumber, pageCount, changePage };
}
