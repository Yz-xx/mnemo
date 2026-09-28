import type { AppConfig } from '../configuration/config/index.js';
import { HumanMessage } from '@langchain/core/messages';
import { ChatOllama } from '@langchain/ollama';

/**
 * 图片理解能力：对话模型是纯文本模型，看不到图，
 * 图片附件必须先由多模态模型转述成文字再交给它。
 */
export interface VisionReader {
  /** 是否已配置视觉模型：未配置时工具据此给出明确提示，而不是让模型凭空猜图 */
  enabled: boolean;
  /** 让视觉模型描述图片内容并返回文本 */
  describe(input: { bytes: Buffer; mime: string }): Promise<string>;
}

/** 未配置视觉模型时的统一提示：工具层与测试都引用同一句，避免两处措辞漂移 */
export const VISION_DISABLED_MESSAGE = '服务端未配置视觉模型，暂时无法读取图片内容。';

/** 转述指令：要求原样抄录图内文字，避免模型把图里的关键信息“概括”掉 */
const VISION_PROMPT =
  '请用简体中文客观描述这张图片：先说明它是什么，再列出其中的关键信息；' +
  '若图片中有文字，请原样抄录，不要翻译也不要改写。';

/** 视觉模型留空即关闭图片理解：部署环境没装多模态模型时不必报错，按能力缺失处理 */
function isVisionEnabled(config: AppConfig): boolean {
  return config.ollama.visionModel.trim() !== '';
}

/** 关闭状态的理解器：不接视觉能力的调用方（如工具测试）直接复用它 */
export const DISABLED_VISION: VisionReader = {
  enabled: false,
  describe: async () => VISION_DISABLED_MESSAGE,
};

export function createVisionReader(config: AppConfig): VisionReader {
  const enabled = isVisionEnabled(config);
  return {
    enabled,
    async describe({ bytes, mime }) {
      if (!enabled) return VISION_DISABLED_MESSAGE;

      const model = new ChatOllama({
        model: config.ollama.visionModel,
        baseUrl: config.ollama.baseUrl,
        // 描述图片要的是稳定复现，不要创作
        temperature: 0,
      });
      const reply = await model.invoke([
        new HumanMessage({
          content: [
            { type: 'text', text: VISION_PROMPT },
            // Ollama 接受 data URI 形式的内联图片，图片无需先上传到任何第三方
            {
              type: 'image_url',
              image_url: { url: `data:${mime};base64,${bytes.toString('base64')}` },
            },
          ],
        }),
      ]);
      return extractReplyText(reply.content);
    },
  };
}

/** 回复正文可能是字符串或内容块数组，统一取其中的文本 */
function extractReplyText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') parts.push(block);
    else if (block && typeof block === 'object' && 'text' in block) {
      const { text } = block as { text?: unknown };
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('').trim();
}
