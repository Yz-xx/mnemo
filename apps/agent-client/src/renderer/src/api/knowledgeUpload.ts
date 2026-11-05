import type { KnowledgeDocument } from '../types';

/** 上传可选项：进度与取消；标题留空时服务端取原始文件名 */
export interface KnowledgeUploadOptions {
  /** 自定义文档标题 */
  title?: string;
  /** 上传字节进度百分比（0–100）：到 100 只代表发送完毕，解析另有状态 */
  onProgress?: (percent: number) => void;
  /** 取消上传：请求被中止时服务端不会留下文档记录 */
  signal?: AbortSignal;
}

/** XHR 上传的入参：地址与令牌由 AgentApi 解析后传入，本模块不感知会话 */
interface UploadKnowledgeFileDeps {
  /** 已归一化（无末尾斜杠）的服务地址 */
  baseUrl: string;
  token: string;
  knowledgeBaseId: string;
  file: File;
  options?: KnowledgeUploadOptions;
}

/**
 * 知识库文件上传：用 XMLHttpRequest 而不是 fetch——只有 XHR 能拿到上传进度并支持中途取消，
 * 浏览器没有 fetch 的上传进度事件。响应返回只代表文件已落盘，解析完成由文档状态体现。
 */
export function uploadKnowledgeFile({
  baseUrl,
  token,
  knowledgeBaseId,
  file,
  options = {},
}: UploadKnowledgeFileDeps): Promise<KnowledgeDocument> {
  const form = new FormData();
  form.append('file', file, file.name);
  const title = options.title?.trim();
  if (title) form.append('title', title);
  const url = `${baseUrl}/api/knowledge/bases/${knowledgeBaseId}/documents/file`;

  return new Promise<KnowledgeDocument>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      options.onProgress?.(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      const body = parseBody(xhr.responseText);
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(readMessage(body) ?? '文件上传失败，请稍后重试'));
        return;
      }
      if (!isDocument(body)) {
        reject(new Error('上传响应格式异常，请稍后重试'));
        return;
      }
      resolve(body);
    };
    xhr.onerror = () => reject(new Error('网络不可达，请检查后端服务地址'));
    // AbortError 是标准名：调用方据此区分「用户取消」与真实失败
    xhr.onabort = () => reject(new DOMException('已取消上传', 'AbortError'));

    // 取消信号只在本次请求存活期间监听，结束即摘除，避免长期持有外部 signal
    const abort = (): void => xhr.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    xhr.onloadend = () => options.signal?.removeEventListener('abort', abort);
    xhr.send(form);
  });
}

/** JSON 响应体：解析失败不抛错，交给调用方按状态码补通用文案 */
function parseBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** 读服务端错误文案：错误响应固定为 { message } 形状 */
function readMessage(body: unknown): string | null {
  if (!isRecord(body) || typeof body.message !== 'string') return null;
  return body.message;
}

/** 上传成功返回的是文档记录：只校验最小形状，字段缺失留给类型层兜底 */
function isDocument(value: unknown): value is KnowledgeDocument {
  return isRecord(value) && typeof value.id === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
