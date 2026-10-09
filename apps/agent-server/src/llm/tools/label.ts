/**
 * 工具展示标签的挂载点：标签与工具名写在同一个工具定义旁边，工具改名时不可能只改一边。
 * 单独成模块是为了让各工具工厂与 assemble 都能引用它，不形成循环依赖。
 */
export function withLabel<T extends object>(item: T, label: string): T & { label: string } {
  // 用 Object.assign 而非对象展开：工具的 invoke 等方法挂在原型上，展开会把它们丢掉
  return Object.assign(item, { label });
}
