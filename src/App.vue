<script setup lang="ts">
// ============================================================
// App.vue —— 桌面应用外壳（S2 4.2）
// 对照 设计稿/add.html 的桌面稿：左侧 .sidebar（品牌 + 记一笔主按钮 +
// 概览/账户/报告/搜索/设置 导航 + 底部"我的账本"单头像）+ 右侧 .main（顶栏 + 内容）。
// 说明：这是单人本地账本，界面不出现"记账人/成员/TA"字样（红线⑤）。
// S11：补做手机/窄屏响应式——窄屏（≤720px）下左侧栏收起、改由底部 4 tab 栏
//   （概览/账户/报告/设置）+ 中央悬浮记账 FAB 承载导航；顶栏搜索框收成放大镜图标。
//   桌面外壳完全不变。切换纯靠 CSS @media（见 tokens.css 尾部 S11 段），无 JS 判定。
//   底栏/FAB/放大镜三个手机元素在桌面下 display:none，故对桌面零影响。
// ============================================================
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';

const route = useRoute();
const router = useRouter();

// 手机端记一笔/编辑页返回：有历史则回退，否则兜底回概览（避免直达 /add 时退无可退）。
function goBack(): void {
  if (window.history.length > 1) router.back();
  else void router.push('/overview');
}

// 顶栏标题：优先用路由 meta.title，兜底用"记账"。
const pageTitle = computed(() => (route.meta.title as string | undefined) ?? '记账');

// S11：记一笔/编辑属"专注录入"流程（头号红线：手机单屏无滚动）。
// 在这两个路由下，手机底栏 tab + FAB 收起（对齐 add.html 手机稿的全屏无底栏形态），
// 避免固定底栏遮住"保存"按钮、并把整屏高度让给数字键盘。纯视图判定，不涉任何业务状态。
const isAddRoute = computed(() => route.name === 'add' || route.name === 'txn-edit');

// 主导航项（图标用内联 svg，与设计稿一致）。
const navItems = [
  { to: '/overview', label: '概览' },
  { to: '/accounts', label: '账户' },
  { to: '/reports', label: '报告' },
  { to: '/search', label: '搜索' },
  { to: '/settings', label: '设置' },
] as const;

// S11：手机底部 tab 栏的 4 格（概览/账户/报告/设置）——搜索不在底栏（顶栏放大镜承载），
// 记一笔由中央 FAB 承载。图标复用侧栏 navItems 的同款内联 SVG，不新画。
const tabItems = navItems.filter((i) => i.to !== '/search');

</script>

<template>
  <div class="app" :class="{ 'app-add-mode': isAddRoute }">
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
        <!-- 手机端记一笔/编辑页返回键：add-mode 下底栏/FAB 收起，需在顶栏提供退出入口。
             桌面下 + 非 add-mode 下 display:none（见 tokens.css S11 段），故零回归。 -->
        <button v-if="isAddRoute" class="m-back-btn" aria-label="返回" @click="goBack">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div class="page-title">{{ pageTitle }}</div>
        <div class="topbar-search">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4-4" />
          </svg>
          <input placeholder="搜索交易…" />
        </div>
        <!-- S11 手机端：桌面搜索框在窄屏收起为放大镜图标，点击进搜索页（§二.3）。桌面下 display:none。 -->
        <RouterLink to="/search" class="m-search-btn" aria-label="搜索">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4-4" />
          </svg>
        </RouterLink>
      </div>
      <RouterView />
    </div>

    <!-- S11 手机端外壳：底部 4 tab 栏 + 中央悬浮记账 FAB（参照 设计稿/overview.html 手机稿）。
         桌面下整体 display:none，仅 @media(max-width:720px) 显现，故桌面零回归。
         图标复用侧栏同款 SVG。z-index 低于页面内弹层（40~60），避免遮挡 modal 操作（坑7）。 -->
    <RouterLink to="/add" class="m-fab" aria-label="记一笔">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6">
        <path d="M12 5v14M5 12h14" />
      </svg>
    </RouterLink>
    <nav class="m-tabbar">
      <template v-for="(item, idx) in tabItems" :key="item.to">
        <RouterLink :to="item.to" class="m-tab">
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
          <!-- 设置 -->
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.9 1.1V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 8 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 3.6 15H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 5 8" />
          </svg>
          {{ item.label }}
        </RouterLink>
        <!-- 概览·账户 之后插入 FAB 让位占位（对齐设计稿 .tab-spacer） -->
        <span v-if="idx === 1" class="m-tab-spacer" aria-hidden="true"></span>
      </template>
    </nav>
  </div>
</template>
