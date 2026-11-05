import type { PDFDocumentProxy } from 'pdfjs-dist';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';

// worker 走打包后的独立文件：PDF 解析在主线程会卡住滚动与输入。
// legacy build 与 Electron 的 Chromium 版本更兼容，避免现代语法在旧内核上报错
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** 从字节加载 PDF：直接交内存，避免 blob: URL 的生命周期与鉴权问题 */
export async function loadPdf(blob: Blob): Promise<PDFDocumentProxy> {
  const data = new Uint8Array(await blob.arrayBuffer());
  return pdfjs.getDocument({ data }).promise;
}

/**
 * 把指定页画到 canvas：宽度跟随容器，高度按页面原始比例推算。
 * 按设备像素比放大后备缓冲，再把 CSS 尺寸收回逻辑像素，高分屏下文字才不糊。
 */
export async function renderPdfPage(
  document: PDFDocumentProxy,
  pageNumber: number,
  canvas: HTMLCanvasElement,
): Promise<void> {
  const page = await document.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  // clientWidth 含容器左右内边距（与 .citation__canvas-wrap 的 padding 同步扣除），
  // 否则画布按内容宽度铺满后会横向溢出，把翻页栏挤出视口
  const width = Math.max(240, (canvas.parentElement?.clientWidth ?? 672) - 32);
  const pixelRatio = window.devicePixelRatio || 1;
  const scale = width / baseViewport.width;
  const viewport = page.getViewport({ scale: scale * pixelRatio });

  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${Math.floor(width)}px`;
  canvas.style.height = `${Math.floor(viewport.height / pixelRatio)}px`;

  await page.render({ canvas, viewport }).promise;
}
