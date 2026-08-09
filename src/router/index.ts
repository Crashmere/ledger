import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

// S3：概览（/overview）是应用首页（打开即速览本月）；记一笔（/add）为真实页。
// S4：账户（/accounts）为真实页（账户/分类/标签管理）。报告/搜索/设置仍用占位组件 StubPage，属后续阶段。
// S5：交易编辑（/txn/:id/edit）复用 AddTxn.vue（同组件靠 route.params.id 区分新建/编辑模式）。
// meta.title 供顶栏标题使用。
const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/overview' },
  {
    path: '/add',
    name: 'add',
    meta: { title: '记一笔' },
    component: () => import('../pages/AddTxn.vue'),
  },
  {
    path: '/txn/:id/edit',
    name: 'txn-edit',
    meta: { title: '编辑交易' },
    component: () => import('../pages/AddTxn.vue'),
  },
  {
    path: '/overview',
    name: 'overview',
    meta: { title: '概览' },
    component: () => import('../pages/Overview.vue'),
  },
  {
    path: '/accounts',
    name: 'accounts',
    meta: { title: '账户' },
    component: () => import('../pages/Accounts.vue'),
  },
  {
    path: '/reports',
    name: 'reports',
    meta: { title: '报告' },
    component: () => import('../pages/StubPage.vue'),
  },
  {
    path: '/search',
    name: 'search',
    meta: { title: '搜索' },
    component: () => import('../pages/StubPage.vue'),
  },
  {
    path: '/settings',
    name: 'settings',
    meta: { title: '设置' },
    component: () => import('../pages/StubPage.vue'),
  },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});
