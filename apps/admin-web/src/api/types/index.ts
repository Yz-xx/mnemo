// 与后端约定的接口返回结构：按 api/ 下的模块拆分，本文件只做统一出口，
// 调用方仍从 '@/api/types' 取用，拆分对调用方不可见。
// 这里刻意不从 @mnemo/reusable 复用，理由见 docs/adr/0002：两端的同名字段并不真正同构，
// 合并只会让桌面端看到管理端专属字段。代价是需要两侧同步——本目录对应 agent-server 的
// routes/{auth,admin,admin*}.ts 返回结构，后端改字段时同步这里。
export * from './audit.js';
export * from './auth.js';
export * from './common.js';
export * from './conversations.js';
export * from './files.js';
export * from './knowledge.js';
export * from './logs.js';
export * from './overview.js';
export * from './system.js';
export * from './users.js';
