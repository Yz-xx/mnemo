import type { Component } from 'vue';
import {
  BookOpen,
  FileText,
  LayoutDashboard,
  MessageSquare,
  ScrollText,
  Settings,
  Users,
  Wrench,
} from 'lucide-vue-next';

export interface NavItem {
  path: string;
  label: string;
  icon: Component;
}

/** 导航分组：按「看板 / 数据 / 运维 / 系统」分层，九个入口不再是一列等权项 */
export interface NavGroup {
  /** 分组小标：用英文疏排，与中文条目标签形成层级差 */
  title: string;
  items: NavItem[];
}

/** 全部导航项；未实现的页面会落到 pages/[...all].vue 占位 */
export const NAV_GROUPS: NavGroup[] = [
  { title: 'OVERVIEW', items: [{ path: '/', label: '总览', icon: LayoutDashboard }] },
  {
    title: 'DATA',
    items: [
      { path: '/users', label: '用户管理', icon: Users },
      { path: '/knowledge', label: '知识库管理', icon: BookOpen },
      { path: '/conversations', label: '会话管理', icon: MessageSquare },
      { path: '/files', label: '文件管理', icon: FileText },
    ],
  },
  {
    title: 'OPS',
    items: [
      { path: '/logs', label: 'API 日志', icon: ScrollText },
      { path: '/audit', label: '操作审计', icon: ScrollText },
    ],
  },
  {
    title: 'SYSTEM',
    items: [
      { path: '/tools', label: 'LLM 工具', icon: Wrench },
      { path: '/config', label: '系统配置', icon: Settings },
    ],
  },
];

/** 拍平后的条目：标题查找与激活判定都只需一份清单 */
const NAV_ITEMS = NAV_GROUPS.flatMap((group) => group.items);

/** 当前页标题：'/' 精确匹配避免误命中所有页，其他项按前缀匹配 */
export function resolveTitle(path: string): string {
  const exact = NAV_ITEMS.find((item) => item.path === path);
  if (exact) return exact.label;
  const prefix = NAV_ITEMS.filter((item) => item.path !== '/').find((item) =>
    path.startsWith(item.path),
  );
  return prefix?.label ?? '';
}

/** 导航项是否激活：'/' 只精确匹配，其余允许子路径（如 /knowledge/xxx 仍高亮知识库） */
export function isItemActive(itemPath: string, currentPath: string): boolean {
  if (itemPath === '/') return currentPath === '/';
  return currentPath === itemPath || currentPath.startsWith(`${itemPath}/`);
}
