import type { ThemeMode } from '../../../../preload/types.js';
import type { ConnectionState } from '../../composables/useChat';
import type { AuthUser, ConversationSummary } from '../../types';
import type { ComputedRef, Ref } from 'vue';
import { computed } from 'vue';
import { useTheme } from '../../composables/useTheme';

/** SessionSidebar 的入参：会话列表与当前用户由 App 持有 */
export interface SessionSidebarProps {
  conversations: ConversationSummary[];
  activeId: string | null;
  connection: ConnectionState;
  user: AuthUser | null;
}

/** SessionSidebar 的上抛事件：会话增删改选、打开设置与登出 */
export interface SessionSidebarEmits {
  create: [];
  select: [id: string];
  remove: [id: string];
  settings: [];
  logout: [];
}

const CONNECTION_TEXT: Record<ConnectionState, string> = {
  idle: '检测中',
  online: '已连接',
  offline: '未连接',
};

interface SessionSidebarControls {
  theme: Ref<ThemeMode>;
  toggleTheme: () => void;
  avatarText: ComputedRef<string>;
  formatTime: (value: string) => string;
  CONNECTION_TEXT: typeof CONNECTION_TEXT;
}

/** 会话栏的展示派生：头像文字、相对时间与连接状态文案，主题复用全局单例 */
export function useSessionSidebar(props: SessionSidebarProps): SessionSidebarControls {
  // 主题是模块级单例状态，这里只负责读取与切换
  const { theme, toggleTheme } = useTheme();

  /** 头像用用户名首字，无需额外资源 */
  const avatarText = computed(() => props.user?.username.slice(0, 1) ?? '?');

  /** 会话列表按相对时间展示，减少视觉噪音 */
  function formatTime(value: string): string {
    const diff = Date.now() - new Date(value).getTime();
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    return new Date(value).toLocaleDateString('zh-CN');
  }

  return { theme, toggleTheme, avatarText, formatTime, CONNECTION_TEXT };
}
