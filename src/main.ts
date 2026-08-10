import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import { initDb } from './db/client';
import { seedIfEmpty } from './db/seed';
import { runStartupSync } from './services/sync';
import { startAutoSync } from './services/sync/scheduler';
import { registerSW } from 'virtual:pwa-register';
import './styles/base.css';

// S6：注册 Service Worker（autoUpdate：有新版下次打开自动生效）。
// dev 环境默认不启用（见 vite.config.ts devOptions.enabled=false），不干扰 HMR。
registerSW({ immediate: true });

// S2 4.2：先初始化数据库（OPFS + 迁移到最新），再注入开发种子（仅 dev 空库）。
// P4（L2 同步）：种子后、挂载前**阻塞式**跑一轮启动同步——先把远端变更合并进来
//   再开门，避免"看到旧数据 → 改 → 覆盖远端"。同步有 10s 上限，死网不卡启动。
//   挂载后再挂上"写库防抖自动推送"，本地新增静默 3s 后自动合并推送到远端。
async function bootstrap(): Promise<void> {
  await initDb();
  await seedIfEmpty();
  await runStartupSync();
  createApp(App).use(createPinia()).use(router).mount('#app');
  startAutoSync();
}

void bootstrap();
