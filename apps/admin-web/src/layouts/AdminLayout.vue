<script setup lang="ts">
// 管理后台主布局：顶栏 + 侧边栏 + 内容区。
// 路由驱动的页面在 <router-view/> 渲染；login 页不经此布局（App.vue 按 meta.layout 分流）。
import {
  BookOpen,
  FileText,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquare,
  ScrollText,
  Settings,
  Users,
  Wrench,
} from 'lucide-vue-next';
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const collapsed = ref(false);

interface NavItem {
  path: string;
  label: string;
  icon: typeof LayoutDashboard;
}

/** 导航分组：按「看板 / 数据 / 运维 / 系统」分层，九个入口不再是一列等权项 */
interface NavGroup {
  /** 分组小标：用英文疏排，与中文条目标签形成层级差 */
  title: string;
  items: NavItem[];
}

// 全部导航项；未实现的页面会落到 pages/[...all].vue 占位
const navGroups: NavGroup[] = [
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
const navItems = navGroups.flatMap((group) => group.items);

// 当前页标题：用于顶栏展示。'/' 精确匹配避免误命中所有页，其他项前缀匹配。
const currentTitle = computed(() => {
  const exact = navItems.find((n) => n.path === route.path);
  if (exact) return exact.label;
  const prefix = navItems.filter((n) => n.path !== '/').find((n) => route.path.startsWith(n.path));
  return prefix?.label ?? '';
});

function isItemActive(path: string): boolean {
  if (path === '/') return route.path === '/';
  return route.path === path || route.path.startsWith(`${path}/`);
}

async function handleLogout(): Promise<void> {
  await auth.logout();
  await router.push('/login');
}
</script>

<template>
  <div class="admin-layout">
    <aside class="admin-layout__sidebar" :class="{ 'admin-layout__sidebar--collapsed': collapsed }">
      <div class="admin-layout__brand">
        <span class="admin-layout__brand-mark">AC</span>
        <span class="admin-layout__brand-text">
          <span class="admin-layout__brand-title">智能体管理</span>
          <span class="admin-layout__brand-sub">AGENT CONSOLE</span>
        </span>
      </div>
      <nav class="admin-layout__nav">
        <div v-for="group in navGroups" :key="group.title" class="admin-layout__nav-group">
          <p class="admin-layout__nav-title">{{ group.title }}</p>
          <router-link
            v-for="item in group.items"
            :key="item.path"
            :to="item.path"
            class="admin-layout__nav-item"
            :class="{ 'admin-layout__nav-item--active': isItemActive(item.path) }"
          >
            <component :is="item.icon" :size="16" class="admin-layout__nav-icon" />
            <span class="admin-layout__nav-label">{{ item.label }}</span>
          </router-link>
        </div>
      </nav>
    </aside>
    <div class="admin-layout__main">
      <header class="admin-layout__header">
        <button
          class="admin-layout__toggle"
          :aria-label="collapsed ? '展开侧边栏' : '收起侧边栏'"
          @click="collapsed = !collapsed"
        >
          <Menu :size="18" />
        </button>
        <h1 class="admin-layout__title">{{ currentTitle }}</h1>
        <span class="admin-layout__tag">ADMIN</span>
        <div class="admin-layout__user">
          <span class="admin-layout__username">{{ auth.user?.username ?? '未登录' }}</span>
          <button class="admin-layout__logout" @click="handleLogout">
            <LogOut :size="14" />
            <span>退出</span>
          </button>
        </div>
      </header>
      <main class="admin-layout__content">
        <router-view />
      </main>
    </div>
  </div>
</template>

<style scoped lang="less">
.admin-layout {
  display: flex;
  height: 100vh;
  background-color: var(--bg-panel);

  &__sidebar {
    width: var(--sidebar-width);
    background-color: var(--bg);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    transition: width var(--transition);
  }

  &__sidebar--collapsed {
    width: var(--sidebar-collapsed-width);

    .admin-layout__brand-text,
    .admin-layout__nav-title,
    .admin-layout__nav-label {
      display: none;
    }

    .admin-layout__brand {
      justify-content: center;
      padding: 0;
    }
  }

  // 品牌区与侧边栏同底、只用一条细线分层：整页是浅色「编辑台」，单独压一块重墨会成孤岛
  // （深底只留给登录页），这里的层级改由字号与金色标记承担
  &__brand {
    height: var(--header-height);
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 16px;
    border-bottom: 1px solid var(--border);
    background-color: var(--bg);
    color: var(--text);
  }

  // 白底小字取 --primary-strong（约 5.9:1）；--primary 在白底只有约 3.9:1，达不到 4.5:1
  &__brand-mark {
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: var(--tracking-label);
    color: var(--primary-strong);
  }

  &__brand-text {
    display: flex;
    flex-direction: column;
    line-height: 1.2;
  }

  &__brand-title {
    font-family: var(--font-display);
    font-size: 14px;
    letter-spacing: var(--tracking-display);
  }

  &__brand-sub {
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: var(--tracking-label);
  }

  &__nav {
    flex: 1;
    padding: 14px 10px;
    display: flex;
    flex-direction: column;
    gap: 18px;
    overflow-y: auto;
  }

  &__nav-group {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  &__nav-title {
    margin: 0 0 4px;
    padding: 0 10px;
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: var(--tracking-label);
  }

  &__nav-item {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 10px;
    border-radius: var(--radius);
    color: var(--text-muted);
    font-size: 13px;
    transition:
      color var(--transition),
      background-color var(--transition);

    &:hover {
      background-color: var(--bg-hover);
      color: var(--text);
    }

    &--active {
      background-color: var(--primary-soft);
      color: var(--primary-strong);
      font-weight: 500;

      // 激活指示条走朱红点缀：金色已用于底色与文字，再用金色就分不出层级
      &::before {
        content: '';
        position: absolute;
        left: 0;
        top: 5px;
        bottom: 5px;
        width: 2px;
        background-color: var(--accent);
        border-radius: 1px;
      }
    }
  }

  &__nav-icon {
    flex-shrink: 0;
  }

  &__main {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  &__header {
    height: var(--header-height);
    background-color: var(--bg);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    padding: 0 24px;
    gap: 14px;
  }

  &__toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background-color: var(--bg);
    color: var(--text-muted);
    transition:
      color var(--transition),
      border-color var(--transition);

    &:hover {
      border-color: var(--border-strong);
      color: var(--text);
    }
  }

  &__title {
    flex: 1;
    margin: 0;
    font-size: 19px;
    color: var(--text);
  }

  &__tag {
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: var(--tracking-label);
  }

  &__user {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  &__username {
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 12px;
    letter-spacing: var(--tracking-mono);
  }

  &__logout {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 5px 11px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background-color: var(--bg);
    color: var(--text-muted);
    font-size: 12px;
    transition:
      color var(--transition),
      border-color var(--transition);

    &:hover {
      border-color: var(--danger);
      color: var(--danger-strong);
    }
  }

  &__content {
    flex: 1;
    padding: 24px 28px 32px;
    overflow-y: auto;
  }
}
</style>
