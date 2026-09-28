<script setup lang="ts">
// 消息趋势折线图：echarts 的初始化、尺寸自适应与销毁都收在组件内，
// 调用方只提供数据点，不接触实例，也不必在页面里写 onUnmounted。
import type { MessageTrendPoint } from '@/api/types';
import type { ECharts, EChartsCoreOption } from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

// 按需注册：只引入折线图与用到的组件，避免整包 echarts 进产物
echarts.use([LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

const props = withDefaults(defineProps<{ points: MessageTrendPoint[]; loading?: boolean }>(), {
  loading: false,
});

const container = ref<HTMLDivElement | null>(null);
let chart: ECharts | null = null;
let observer: ResizeObserver | null = null;

/** 读取设计令牌：canvas 取不到 CSS 变量，统一自 :root 读一次，避免在组件里写死色值 */
function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function buildOption(points: MessageTrendPoint[]): EChartsCoreOption {
  return {
    grid: { left: 8, right: 16, top: 16, bottom: 4, containLabel: true },
    tooltip: { trigger: 'axis' },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      // 只显示月-日：完整年份对近 7 天的趋势是噪声
      data: points.map((point) => point.date.slice(5)),
      axisLine: { lineStyle: { color: token('--border') } },
      axisTick: { show: false },
      axisLabel: { color: token('--text-muted') },
    },
    yAxis: {
      type: 'value',
      // 消息量是整数，避免出现 0.5 这样的刻度
      minInterval: 1,
      axisLabel: { color: token('--text-muted') },
      splitLine: { lineStyle: { color: token('--border') } },
    },
    series: [
      {
        type: 'line',
        name: '消息量',
        smooth: true,
        symbolSize: 6,
        data: points.map((point) => point.count),
        itemStyle: { color: token('--primary') },
        lineStyle: { color: token('--primary'), width: 2 },
        areaStyle: { color: token('--primary-soft') },
      },
    ],
  };
}

onMounted(() => {
  if (!container.value) return;
  chart = echarts.init(container.value);
  chart.setOption(buildOption(props.points));
  // 监听容器尺寸：折叠侧边栏也会改变宽度，只听 window 会漏掉这一种
  observer = new ResizeObserver(() => chart?.resize());
  observer.observe(container.value);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
  chart?.dispose();
  chart = null;
});

watch(
  () => props.points,
  (points) => chart?.setOption(buildOption(points)),
);
</script>

<template>
  <div class="trend-chart">
    <div ref="container" class="trend-chart__canvas"></div>
    <p v-if="loading" class="trend-chart__hint">加载中…</p>
  </div>
</template>

<style src="./MessageTrendChart.less" lang="less" scoped></style>
