import type { ToolBudget } from './context/index.js';
import type { FileSource } from './tools/index.js';
import type { VisionReader } from './vision.js';
import type { ParseRunner } from '../../infrastructure/files/parseGovernance.js';
import type { BaseMessage } from '@langchain/core/messages';
import type { Logger } from '@repo/logger';
import { SystemMessage } from '@langchain/core/messages';
import { toErrorMessage } from '@repo/shared';
import { BUDGET_EXHAUSTED_NOTE } from './context/index.js';
import { readAttachmentText } from './tools/index.js';

/**
 * 本轮附件在模型作答前预读成文本并注入对话（见 docs/adr/0010 的上下文与额度口径）。
 * 不依赖模型自行调用 read_file：实测同一张图在「我上传了一张图片…」这类强措辞下能触发读取，
 * 换成「图片里是什么」则 6 轮一次都不读、直接编造答案——小模型对工具调用指令的遵循率撑不起主链路。
 * 预读把「附件有没有被读到」从模型决策变成确定行为，内容直接摆在提问旁边。
 * 单个附件读不到（文件失效、视觉模型不可用）只如实注明，不因此中断整轮对话；
 * 预读正文与检索 / 读取共用本轮的上下文额度，超额度即截断或只留抬头行。
 *
 * messages 是调用方持有的组装结果的副本：直接就地追加一条附件提示，不改动调用方那一份。
 */
export async function appendAttachmentHints(input: {
  messages: BaseMessage[];
  files: FileSource;
  vision: VisionReader;
  parse: ParseRunner;
  userId: number;
  fileIds: string[];
  budget: ToolBudget;
  logger?: Logger;
}): Promise<void> {
  const { messages, files, vision, parse, userId, fileIds, budget, logger } = input;
  if (fileIds.length === 0) return;
  const attachments = await files.list(userId, fileIds);
  if (attachments.length === 0) return;

  // 逐个读取而非并发：本机视觉模型同时处理多张图会明显拖慢，且并发日志难以归因
  const sections: string[] = [];
  for (const file of attachments) {
    const heading = `【${file.name}｜${file.id}】`;
    try {
      const text = await readAttachmentText(files, vision, parse, userId, file.id, logger);
      // 读不到要让模型知道原因并如实转达，不因此中断整轮对话
      if (text === null) {
        sections.push(`${heading}读取失败：文件不存在或已失效，请如实告知用户。`);
        continue;
      }
      // 预读正文与工具结果共用同一份额度：一份超长附件不能把窗口挤爆
      const admitted = budget.admit(text);
      // 额度耗尽时仍保留抬头行：模型至少知道有这份附件，只是内容没进来
      sections.push(
        admitted ? `${heading}\n${admitted.text}` : `${heading}${BUDGET_EXHAUSTED_NOTE}`,
      );
    } catch (error) {
      sections.push(`${heading}读取失败：${toErrorMessage(error)}`);
    }
  }

  messages.push(
    new SystemMessage(
      [
        '本轮用户附带了以下附件，其内容已由系统预先读取，请直接据此回答，不要编造内容：',
        ...sections,
      ].join('\n\n'),
    ),
  );
}
