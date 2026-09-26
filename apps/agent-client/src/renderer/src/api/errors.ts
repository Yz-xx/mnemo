/**
 * 统一把未知抛出值转为可展示的错误文案。
 * 请求失败与流式中断抛出的都是 unknown，非 Error 值（字符串、对象）也要有兜底内容，
 * 否则界面会渲染成空提示；集中在此可保证各调用点的降级口径一致。
 */
export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
