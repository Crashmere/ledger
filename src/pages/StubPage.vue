<script setup lang="ts">
// ============================================================
// StubPage.vue —— 占位页（S2 4.2）
// 概览/账户/报告/搜索/设置在本阶段只占位，真正实现属后续阶段。
// 用路由 meta.title 作为标题，避免每个占位页各写一份。
// ============================================================
import { computed } from 'vue';
import { useRoute } from 'vue-router';

const route = useRoute();
const title = computed(() => (route.meta.title as string | undefined) ?? '页面');
</script>

<template>
  <div class="content">
    <div class="card card-pad">
      <div class="empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 9h18M8 14h8" />
        </svg>
        <div style="font-weight: 700; font-size: var(--fs-h3); color: var(--fg-2)">{{ title }}</div>
        <div class="mt-2">此页面将在后续阶段实现。</div>
      </div>
    </div>
  </div>
</template>
