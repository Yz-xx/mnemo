// 通用工具库统一出口，业务方只需从 '@mnemo/shared' 引入。
// 本包只放与业务无关的纯工具；与业务约定绑定的可复用代码（HTTP 契约、对话协议类型、
// 跨端固定文案）放 '@mnemo/reusable'，边界见各包 README。
// 包根只导出不含第三方依赖的模块：第三方包常无自己的 sideEffects 声明，打包器无法证明
// 导入它无副作用，只能为保留副作用而整包引入，引包根就会连带把那些依赖拖进产物。
export * from './strings.js';
export * from './common.js';
export * from './bytes.js';
export * from './time.js';
export * from './http/index.js';
