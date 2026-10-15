// 业务可复用代码的统一出口。
// 判据是「是否与业务约定绑定」：HTTP 状态码契约、SSE 对话协议类型、必须两端一字不差的
// 文案放这里；纯粹的通用工具（strings / common / crypto）留在 @repo/shared。
// 两者的边界见本包 README，新增能力时先问一句「换一个业务它还用得上吗」。
export * from './http.js';
export * from './chat.js';
export * from './messages.js';
export * from './errors.js';
export * from './sse.js';
export * from './password.js';
