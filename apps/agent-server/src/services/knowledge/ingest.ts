import type { KnowledgeStore } from './store.js';
import type { KnowledgeDocument } from '../../entities/knowledge.js';
import type { BoundedGate } from '../../infrastructure/concurrency/gate.js';
import type { Logger } from '@mnemo/logger';
import fs from 'node:fs/promises';
import path from 'node:path';
import { toErrorMessage } from '@mnemo/shared';
import { extractText } from '../../infrastructure/files/parser.js';
import { isTextExtension } from './fileInput.js';

/** 知识库原始文件子在线上传根目录下的子目录名 */
export const KNOWLEDGE_FILE_SUBDIR = 'knowledge';

/** 解析任务失败时给用户看的中文原因上限：过长的底层报错截断，避免撑爆列表排版 */
const FAILURE_REASON_MAX_LENGTH = 200;

/** 闸门排队超时后的重试间隔：后台任务没有请求可失败，忙就等下一轮而不是把文档判死 */
const GATE_RETRY_MS = 5_000;

/** 异步解析的依赖：存储、并发闸门、日志与落盘目录 */
export interface KnowledgeIngestDeps {
  knowledge: KnowledgeStore;
  /** 解析档闸门：大文件并发解析不得挤占对话与上传 */
  gate: BoundedGate;
  logger: Logger;
  /** 上传根目录（config.upload.dir） */
  uploadDir: string;
}

/** 异步解析任务：入队即返回，解析结果由状态机与轮询体现 */
export interface KnowledgeIngest {
  /** 入队一篇待解析文档；同一文档重复入队合并为一次 */
  enqueue(document: KnowledgeDocument): void;
  /** 启动恢复：把仍为 processing 的文档重新入队（上次进程中断遗留） */
  recover(): Promise<void>;
  /** 删除文档时取消在途任务并清理原始文件 */
  discard(documentId: string): Promise<void>;
  /** 等待当前在途任务全部收口：测试与优雅退出用 */
  drain(): Promise<void>;
}

/** 知识库原始文件落盘路径：按文档 ID 命名，原始文件名只入库展示 */
export function knowledgeFilePath(uploadDir: string, documentId: string): string {
  return path.join(uploadDir, KNOWLEDGE_FILE_SUBDIR, documentId);
}

/**
 * 解析失败的对外中文原因：常见的文件系统错误翻成可读文案，其余保留原始消息并截断。
 * 原始 error 另由调用方落日志，落库文案只给用户看。
 */
export function describeIngestFailure(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return '原始文件不存在或已被删除';
  if (code === 'EACCES' || code === 'EPERM') return '原始文件无法读取';
  return toErrorMessage(error).slice(0, FAILURE_REASON_MAX_LENGTH);
}

/**
 * 文件解析任务：读盘 → 提取文本 → 切分向量化 → 回写状态。
 * 任务顶层自吞异常并如实落 failed，绝不把拒绝逃逸到进程（同轮次任务纪律）。
 */
export function createKnowledgeIngest({
  knowledge,
  gate,
  logger,
  uploadDir,
}: KnowledgeIngestDeps): KnowledgeIngest {
  /** 进程内注册表：同一文档只跑一个任务，重复入队直接忽略 */
  const inflight = new Map<string, Promise<void>>();
  /** 已被删除的文档：任务读到标记即提前收手，不白跑向量化 */
  const canceled = new Set<string>();

  /** 按扩展名分派：TXT/MD 直读 UTF-8（去 BOM），其余走解析器 */
  async function readContent(document: KnowledgeDocument): Promise<string> {
    const filePath = knowledgeFilePath(uploadDir, document.id);
    const ext = path
      .extname(document.fileName ?? '')
      .slice(1)
      .toLowerCase();
    const bytes = await fs.readFile(filePath);

    if (isTextExtension(ext)) {
      // BOM 会混进首个片段并影响向量相似度，读入即剥掉
      return bytes.toString('utf8').replace(/^\uFEFF/, '');
    }
    return extractText({ ext, name: document.fileName ?? document.title, bytes });
  }

  /**
   * 申请解析额度：后台任务没有「快速失败」的语义——闸门排队超时只说明此刻繁忙，
   * 隔几秒再申请即可，不该把文档直接判为 failed（否则批量上传 / 启动恢复会误伤大半文档）。
   * 返回 false 表示等待期间文档已被删（此时没拿到额度，调用方不得 release）。
   */
  async function acquireSlot(documentId: string): Promise<boolean> {
    let admitted = false;
    while (!admitted) {
      if (canceled.has(documentId)) return false;
      admitted = (await gate.acquire()) === 'admitted';
      if (!admitted) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, GATE_RETRY_MS);
        });
      }
    }
    return true;
  }

  /** 单个文档的完整解析流程：所有失败都落到 failed + 原因，便于前端重试 */
  async function run(document: KnowledgeDocument): Promise<void> {
    const admitted = await acquireSlot(document.id);
    // 排队期间文档被删：没拿到额度，直接收手
    if (!admitted) {
      canceled.delete(document.id);
      logger.info('解析任务已取消', { documentId: document.id });
      return;
    }

    try {
      // 拿到额度再到真正读盘之间还有窗口：先判一次，避免为已删文档读文件
      if (canceled.has(document.id)) {
        logger.info('解析任务已取消', { documentId: document.id });
        return;
      }
      const content = await readContent(document);
      // 读文件期间文档可能被删：向量化前再判一次，不白跑昂贵的 embedding
      if (canceled.has(document.id)) {
        logger.info('解析任务已取消', { documentId: document.id });
        return;
      }
      // 回写可能因「解析期间文档被删」返回 false：此时放弃片段写入，不复活已删文档
      const written = await knowledge.ingestContent(document.id, content);
      if (written) {
        logger.info('文档解析完成', { documentId: document.id, title: document.title });
      } else {
        logger.info('文档已删除，解析结果丢弃', { documentId: document.id });
      }
    } catch (error) {
      const reason = describeIngestFailure(error);
      // 标记失败本身也可能因数据库不可用而抛错：再吞一层，确保任务永远不会逃逸
      await knowledge.markFailed(document.id, reason).catch(() => undefined);
      logger.error('文档解析失败', { documentId: document.id, reason, error });
    } finally {
      gate.release();
      canceled.delete(document.id);
    }
  }

  function enqueue(document: KnowledgeDocument): void {
    if (inflight.has(document.id)) return;
    const task = run(document)
      // 兜底：run 内部已自吞异常，这里再包一层防御性收口
      .catch((error: unknown) => logger.error('解析任务异常逃逸', { error }))
      .finally(() => inflight.delete(document.id));
    inflight.set(document.id, task);
    // 入队即返回：调用方是 HTTP 处理链路或启动恢复，不等解析完成
    void task;
  }

  async function recover(): Promise<void> {
    const pending = await knowledge.listProcessing();
    if (pending.length > 0) {
      logger.info('恢复未完成的解析任务', { count: pending.length });
      for (const document of pending) enqueue(document);
    }
  }

  async function discard(documentId: string): Promise<void> {
    // 在途任务先标取消：拿到额度后与向量化前各判一次，避免删完还白跑解析
    if (inflight.has(documentId)) canceled.add(documentId);
    // 文件可能尚未落盘或已清理：ENOENT 不是错误；
    // 其余失败（权限等）只留日志，行已删的业务结果不该被磁盘清理拖成 500
    await fs
      .rm(knowledgeFilePath(uploadDir, documentId), { force: true })
      .catch((error: unknown) => {
        logger.warn('知识库原始文件清理失败', { documentId, error });
      });
  }

  async function drain(): Promise<void> {
    while (inflight.size > 0) {
      await Promise.all([...inflight.values()]);
    }
  }

  return { enqueue, recover, discard, drain };
}
