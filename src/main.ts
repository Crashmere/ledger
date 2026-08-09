import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import { initDb } from './db/client';
import { seedIfEmpty } from './db/seed';
import './styles/base.css';

// S2 4.2：先初始化数据库（OPFS + 迁移到最新），再注入开发种子（仅 dev 空库），
// 全部就绪后再挂载，避免页面先渲染却拿不到 db 而报错。
async function bootstrap(): Promise<void> {
  await initDb();
  await seedIfEmpty();
  createApp(App).use(createPinia()).use(router).mount('#app');
}

void bootstrap();
