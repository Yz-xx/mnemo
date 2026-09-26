import { ref, watch } from 'vue';
import type { Ref } from 'vue';
import type { ThemeMode } from '../../../preload/types.js';
import { initialSettings, saveSettings } from '../api/bridge';

interface ThemeControls {
  theme: Ref<ThemeMode>;
  toggleTheme: () => void;
}

/** 与 less 中的 @theme-transition 保持一致：调用方在过渡结束后即撤销临时类 */
const TRANSITION_MS = 240;

// 主题真源在主进程设置中，preload 已同步注入，首个渲染帧即可拿到正确主题
const theme = ref<ThemeMode>(initialSettings.theme);

// 初始主题直接落到根节点，不加过渡，避免启动时出现一次颜色渐变
document.documentElement.dataset['theme'] = theme.value;

// 过渡结束前撤销临时类，防止连续切换时被前一次的定时器提前取消
let transitionTimer: number | undefined;

/**
 * 仅在切换瞬间临时开启全局颜色过渡：常驻 transition 会影响其它交互动画，
 * 也会让列表滚动、hover 等变得迟钝。
 */
function withThemeTransition(apply: () => void): void {
  const root = document.documentElement;
  root.classList.add('theme-transition');
  apply();
  window.clearTimeout(transitionTimer);
  transitionTimer = window.setTimeout(
    () => root.classList.remove('theme-transition'),
    TRANSITION_MS,
  );
}

watch(theme, (value) => {
  withThemeTransition(() => {
    document.documentElement.dataset['theme'] = value;
  });
  // 交给主进程持久化，同时让窗口底色与 themeSource 跟随，避免下次启动闪烁
  void saveSettings({ theme: value }).catch(() => {
    // 持久化失败不影响本次会话的主题切换
  });
});

export function useTheme(): ThemeControls {
  function toggleTheme(): void {
    theme.value = theme.value === 'dark' ? 'light' : 'dark';
  }

  return { theme, toggleTheme };
}
