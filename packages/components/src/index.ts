// 组件库统一出口：具名导出支持按需引入，默认导出支持 app.use() 全局注册
import type { App, Component } from 'vue';
import BatchBar from './components/BatchBar';
import DataTable from './components/DataTable';
import ModalDialog from './components/ModalDialog';
import PageBar from './components/PageBar';
import SearchBar from './components/SearchBar';
import './styles/tokens.less';

export type { ColumnSpec } from './components/DataTable';
export { BatchBar, DataTable, ModalDialog, PageBar, SearchBar };

export default {
  install(app: App): void {
    // 逐个注册而非遍历对象：各组件类型互不相同，遍历会退化成联合类型，
    // 与 app.component(name, component) 的签名不兼容（TS2345）
    app.component('BatchBar', BatchBar);
    // DataTable 是泛型组件，其类型与 Component 签名不兼容，仅全局注册这一处需要断言；
    // 具名导出不受影响，消费方仍能拿到完整的泛型类型
    app.component('DataTable', DataTable as Component);
    app.component('ModalDialog', ModalDialog);
    app.component('PageBar', PageBar);
    app.component('SearchBar', SearchBar);
  },
};
