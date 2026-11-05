import { describe, expect, it } from 'vitest';
import { isSendEnter } from '../components/ChatWindow/useChatWindow';

// Enter 发送判定是输入条唯一与键盘语义绑定的逻辑，单独测纯函数：
// 中文输入法选词时按 Enter 属于「确认候选词」，不能触发发送。

describe('输入框 Enter 发送判定', () => {
  it('输入法组合期间的 Enter 不发送', () => {
    expect(isSendEnter({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false);
  });

  it('普通 Enter 发送', () => {
    expect(isSendEnter({ key: 'Enter', shiftKey: false, isComposing: false })).toBe(true);
  });

  it('Shift + Enter 换行，不发送', () => {
    expect(isSendEnter({ key: 'Enter', shiftKey: true, isComposing: false })).toBe(false);
  });
});
