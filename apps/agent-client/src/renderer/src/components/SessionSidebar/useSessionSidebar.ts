import type { ThemeMode } from '../../../../preload/types.js';
import type { ConnectionState } from '../../composables/useChat';
import type { AuthUser, ConversationSummary, KnowledgeBaseView } from '../../types';
import type { ComputedRef, Ref } from 'vue';
import { computed, ref } from 'vue';
import { useTheme } from '../../composables/useTheme';

/** 会话标题长度上限：与服务端校验同口径，超限在本地就不提交 */
const TITLE_MAX_LENGTH = 24;

/** SessionSidebar 的入参：会话列表、库清单与当前用户由 App 持有 */
export interface SessionSidebarProps {
  conversations: ConversationSummary[];
  activeId: string | null;
  connection: ConnectionState;
  user: AuthUser | null;
  /** 可见知识库：会话条目的绑定库按 id 在此查名 */
  knowledgeBases: KnowledgeBaseView[];
}

/** SessionSidebar 的上抛事件：会话增删改选、打开知识库与设置、登出 */
export interface SessionSidebarEmits {
  create: [];
  select: [id: string];
  remove: [id: string];
  rename: [id: string, title: string];
  /** 打开知识库管理页（设置抽屉的知识库分页） */
  knowledge: [];
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
  /** 绑定库的展示名：库已被删除时给出明确文案，而不是留空 */
  baseName: (id: string) => string;
  editingId: Ref<string | null>;
  draftTitle: Ref<string>;
  startRename: (item: ConversationSummary) => void;
  submitRename: () => void;
  cancelRename: () => void;
  finishRename: () => void;
  CONNECTION_TEXT: typeof CONNECTION_TEXT;
}

/**
 * 会话栏的展示派生：头像文字、相对时间、绑定库名，以及标题内联重命名的本地状态。
 * 重命名只在本组件内编辑，提交经 emit 交回 App，由会话组落库。
 */
export function useSessionSidebar(
  props: SessionSidebarProps,
  emit: (event: 'rename', id: string, title: string) => void,
): SessionSidebarControls {
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

  function baseName(id: string): string {
    return props.knowledgeBases.find((base) => base.id === id)?.name ?? '已删除的知识库';
  }

  /** 内联重命名：同一时刻只编辑一条，草稿独立于列表数据以免输入时抖动 */
  const editingId = ref<string | null>(null);
  const draftTitle = ref('');

  function startRename(item: ConversationSummary): void {
    editingId.value = item.id;
    draftTitle.value = item.title;
  }

  function cancelRename(): void {
    editingId.value = null;
    draftTitle.value = '';
  }

  function submitRename(): void {
    const id = editingId.value;
    const title = draftTitle.value.trim();
    // 空标题与超长不提交：留在编辑态让用户改，而不是发一个必然 400 的请求
    if (!id || !title || title.length > TITLE_MAX_LENGTH) return;
    cancelRename();
    emit('rename', id, title);
  }

  /** 失焦收尾：合法就提交，非法就退出编辑，避免输入框永远挂在列表上 */
  function finishRename(): void {
    const title = draftTitle.value.trim();
    if (title && title.length <= TITLE_MAX_LENGTH) submitRename();
    else cancelRename();
  }

  return {
    theme,
    toggleTheme,
    avatarText,
    formatTime,
    baseName,
    editingId,
    draftTitle,
    startRename,
    submitRename,
    cancelRename,
    finishRename,
    CONNECTION_TEXT,
  };
}
