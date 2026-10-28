import MarkdownIt from 'markdown-it';

// 模块级单例：实例不持有渲染状态，所有消息共用一份，避免每条消息重复构建规则表
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });

// 链接一律标记为外部打开，交由主进程的 setWindowOpenHandler 用系统浏览器处理
markdown.renderer.rules.link_open = (tokens, index, options, _env, self) => {
  tokens[index].attrSet('target', '_blank');
  return self.renderToken(tokens, index, options);
};

// 从实例方法推导 token 类型：@types/markdown-it 走 export = 导出构造函数，
// 默认导入的 MarkdownIt 只有值含义，不能出现在类型位置（ts2749）
type MarkdownToken = ReturnType<typeof markdown.parse>[number];

/**
 * 按顶层块切分渲染，返回每块的 HTML。
 *
 * 不走「按文本空行切分再逐段 render」：那样会把松散列表、引用块等跨空行结构切开，
 * 输出与整体渲染不一致。这里先用 parse 拿到整体 token 流，再按顶层块边界分组，
 * 逐组 renderer.render，拼起来与 markdown.render 逐字一致。
 *
 * 未变化的块产出相同字符串，调用方以 v-for + index 作 key 复用 DOM，只重建正在增长的末块。
 */
export function renderBlocks(text: string): string[] {
  const env: Record<string, unknown> = {};
  const tokens = markdown.parse(text, env);
  const groups: MarkdownToken[][] = [];

  for (const token of tokens) {
    // 顶层开启或自闭合标记（level 0 且非闭合）是新块的起点；闭合标记与更深层级归入当前块
    const startsBlock = token.level === 0 && token.nesting !== -1;
    if (startsBlock || groups.length === 0) groups.push([token]);
    else groups[groups.length - 1].push(token);
  }

  return groups.map((group) => markdown.renderer.render(group, markdown.options, env));
}
