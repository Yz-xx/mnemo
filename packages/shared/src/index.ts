// 公共库统一出口，业务方只需从 '@repo/shared' 引入。
// DES 加解密刻意不在这里 re-export：它依赖 crypto-js，而 crypto-js 在库构建中被
// external、且自身没有 sideEffects 声明，打包器无法证明其无副作用，只能为"保留副作用"
// 而整包保留（实测 Electron 渲染产物因此多出约 215 kB，且 electron-vite 不认 sideEffects）。
// 需要加密能力时显式从 '@repo/shared/crypto' 引入，其余场景就不会被牵连。
export * from './strings.js';
export * from './common.js';
export * from './http.js';
