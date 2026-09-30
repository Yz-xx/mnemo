<script lang="ts">
// 列描述放普通 <script> 块导出：props 类型里用到它，Volar 会为组件生成导出声明，
// 若类型不可见会报 TS4025（用到了私有名字）
export interface ColumnSpec {
  /** 字段名，同时作为自定义单元格的插槽名 */
  key: string;
  label: string;
  width?: string;
  align?: 'left' | 'center' | 'right';
}
</script>

<script setup lang="ts" generic="T extends object">
// 通用数据表格：列由 columns 描述，单元格默认取同名字段，需要自定义渲染时用同名具名插槽覆盖。
// 只负责展示——排序、过滤、分页都留在调用方，避免把业务规则塞进展示组件。
// 选择能力同样只做「键集合的增删」：表头复选框只作用于当前页，已选是否跨页保留由调用方决定。
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    columns: ColumnSpec[];
    rows: T[];
    /** 行唯一键用函数表达：不要求数据带索引签名，接口类型也能直接传进来 */
    rowKey: (row: T) => string | number;
    loading?: boolean;
    emptyText?: string;
    /** 开启后首列出现复选框 */
    selectable?: boolean;
    /** 已选行键，配合 v-model:selected-keys 双向绑定 */
    selectedKeys?: Array<string | number>;
  }>(),
  { loading: false, emptyText: '暂无数据', selectable: false, selectedKeys: () => [] },
);

const emit = defineEmits<{
  'update:selectedKeys': [keys: Array<string | number>];
}>();

defineSlots<{ [name: string]: (props: { row: T }) => unknown }>();

/** 默认单元格取值：只在列 key 与数据字段同名时使用，其余场景由插槽接管 */
function cellValue(row: T, key: string): string | number {
  const value = (row as Record<string, unknown>)[key];
  return typeof value === 'string' || typeof value === 'number' ? value : '';
}

/** 当前页行键：全选与半选判定都只看这一页 */
const pageKeys = computed(() => props.rows.map((row) => props.rowKey(row)));
const selectedSet = computed(() => new Set(props.selectedKeys));
const allChecked = computed(
  () => pageKeys.value.length > 0 && pageKeys.value.every((key) => selectedSet.value.has(key)),
);
const someChecked = computed(
  () => !allChecked.value && pageKeys.value.some((key) => selectedSet.value.has(key)),
);

/** 表头复选框：全选或清空当前页，其他页已选保持原样 */
function toggleAll(): void {
  const next = new Set(props.selectedKeys);
  for (const key of pageKeys.value) {
    if (allChecked.value) next.delete(key);
    else next.add(key);
  }
  emit('update:selectedKeys', [...next]);
}

/** 行复选框：切换单行 */
function toggleRow(key: string | number): void {
  const next = new Set(props.selectedKeys);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  emit('update:selectedKeys', [...next]);
}
</script>

<template>
  <div class="data-table">
    <table class="data-table__table">
      <thead>
        <tr>
          <th v-if="selectable" class="data-table__head-cell data-table__select-cell">
            <input
              type="checkbox"
              :checked="allChecked"
              :indeterminate.prop="someChecked"
              :disabled="rows.length === 0"
              aria-label="全选当前页"
              @change="toggleAll"
            />
          </th>
          <th
            v-for="column in columns"
            :key="column.key"
            class="data-table__head-cell"
            :style="{ width: column.width, textAlign: column.align ?? 'left' }"
          >
            {{ column.label }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="rowKey(row)" class="data-table__row">
          <td v-if="selectable" class="data-table__cell data-table__select-cell">
            <input
              type="checkbox"
              :checked="selectedSet.has(rowKey(row))"
              aria-label="选择该行"
              @change="toggleRow(rowKey(row))"
            />
          </td>
          <td
            v-for="column in columns"
            :key="column.key"
            class="data-table__cell"
            :style="{ textAlign: column.align ?? 'left' }"
          >
            <slot :name="column.key" :row="row">{{ cellValue(row, column.key) }}</slot>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="loading" class="data-table__hint">加载中…</p>
    <p v-else-if="rows.length === 0" class="data-table__hint">{{ emptyText }}</p>
  </div>
</template>

<style src="./DataTable.less" lang="less" scoped></style>
