<script setup lang="ts">
// ============================================================
// App.vue —— 桌面应用外壳（S2 4.2）
// 对照 设计稿/add.html 的桌面稿：左侧 .sidebar（品牌 + 记一笔主按钮 +
// 概览/账户/报告/搜索/设置 导航 + 底部"我的账本"单头像）+ 右侧 .main（顶栏 + 内容）。
// 说明：这是单人本地账本，界面不出现"记账人/成员/TA"字样（红线⑤）。
// 手机响应式塌底栏属 S9，本阶段不做。
// ============================================================
import { computed } from 'vue';
import { useRoute } from 'vue-router';

const route = useRoute();

// 顶栏标题：优先用路由 meta.title，兜底用"记账"。
const pageTitle = computed(() => (route.meta.title as string | undefined) ?? '记账');

// 主导航项（图标用内联 svg，与设计稿一致）。
const navItems = [
  { to: '/overview', label: '概览' },
  { to: '/accounts', label: '账户' },
  { to: '/reports', label: '报告' },
  { to: '/search', label: '搜索' },
  { to: '/settings', label: '设置' },
] as const;
</script>

<template>
  <div class="app">
    <!-- 侧栏 -->
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-logo">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2">
            <path d="M3 10h18M7 15h4" />
            <rect x="3" y="5" width="18" height="14" rx="2" />
          </svg>
        </div>
        <div>
          <div class="brand-name">记账</div>
          <div class="brand-sub">本地优先 · 全平台</div>
        </div>
      </div>

      <RouterLink to="/add" class="nav-add">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4">
          <path d="M12 5v14M5 12h14" />
        </svg>
        记一笔
      </RouterLink>

      <nav class="nav-list">
        <RouterLink v-for="item in navItems" :key="item.to" :to="item.to" class="nav-item">
          <!-- 概览 -->
          <svg v-if="item.to === '/overview'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
          <!-- 账户 -->
          <svg v-else-if="item.to === '/accounts'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="2" y="5" width="20" height="14" rx="2" />
            <path d="M2 10h20" />
          </svg>
          <!-- 报告 -->
          <svg v-else-if="item.to === '/reports'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 3v18h18" />
            <path d="M18 8l-5 5-3-3-4 4" />
          </svg>
          <!-- 搜索 -->
          <svg v-else-if="item.to === '/search'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4-4" />
          </svg>
          <!-- 设置 -->
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.9 1.1V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 8 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 3.6 15H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 5 8" />
          </svg>
          {{ item.label }}
        </RouterLink>
      </nav>

      <div class="sidebar-foot">
        <div class="user-chip">
          <div class="avatar-pair">
            <span class="avatar" style="background: var(--acc-salary)">本</span>
          </div>
          <div>
            <div style="font-weight: 600; font-size: 13px">我的账本</div>
            <div class="brand-sub">本地优先 · 已保存</div>
          </div>
        </div>
      </div>
    </aside>

    <!-- 主区 -->
    <div class="main">
      <div class="topbar">
        <div class="page-title">{{ pageTitle }}</div>
        <div class="topbar-search">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4-4" />
          </svg>
          <input placeholder="搜索交易…" />
        </div>
      </div>
      <RouterView />
    </div>
  </div>
</template>
