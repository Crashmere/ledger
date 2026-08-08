import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

// S0：只挂一个临时的冒烟检查页作为默认路由。
// 业务页面（概览/记一笔/账户/搜索/报告/设置）在 S2 及以后加入。
const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'smoke',
    // 临时验证入口，S0 验收后可移除。
    component: () => import('../pages/SmokeTest.vue'),
  },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});
