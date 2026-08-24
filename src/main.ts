import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import { initDb } from './db/client';
import { seedIfEmpty } from './db/seed';
import { runStartupSync, type SyncResult } from './services/sync';
import { startAutoSync } from './services/sync/scheduler';
import { initialAutoSyncEnabled, registerAutoSyncHandle } from './composables/useAutoSync';
import { pushToast } from './composables/useToast';
import { registerSW } from 'virtual:pwa-register';
import './styles/base.css';

// S6：注册 Service Worker（autoUpdate：有新版下次打开自动生效）。
// dev 环境默认不启用（见 vite.config.ts devOptions.enabled=false），不干扰 HMR。
registerSW({ immediate: true });

/**
 * 把「后台自动同步」的结果翻译成页面顶部小提示。
 * 只在"确实发生了值得知会的事"时弹：
 *   - error → 弹红色「同步失败」；
 *   - pushed（推了本地新增）/ 吸收了云端新记录 → 弹绿色成功；
 *   - up-to-date 且没吸收任何远端变化 / created / skipped → 静默（不打扰）。
 */
function toastAutoSync(res: SyncResult): void {
  if (res.status === 'error') {
    pushToast('error', res.message ?? '同步失败，请稍后重试。');
    return;
  }
  const r = res.report;
  const pulled = r
    ? r.account.fromRemoteOnly + r.category.fromRemoteOnly + r.txn.fromRemoteOnly + r.tag.fromRemoteOnly
    : 0;
  if (res.status === 'pushed') {
    pushToast(
      'success',
      pulled > 0 ? `同步成功：上传本地改动，并吸收云端 ${pulled} 条新记录。` : '同步成功：本地改动已上传云端。',
    );
  } else if (res.status === 'up-to-date' && pulled > 0) {
    pushToast('success', `同步成功：已吸收云端 ${pulled} 条新记录。`);
  }
  // created / up-to-date(无吸收) / skipped：无需打扰，静默。
}

// S2 4.2：先初始化数据库（OPFS + 迁移到最新），再注入开发种子（仅 dev 空库）。
// P4（L2 同步）：种子后、挂载前**阻塞式**跑一轮启动同步——先把远端变更合并进来
//   再开门，避免"看到旧数据 → 改 → 覆盖远端"。同步有 10s 上限，死网不卡启动。
//   挂载后再挂上"写库防抖自动推送"，本地新增静默 3s 后自动合并推送到远端；
//   每次后台自动同步的结果经 onResult/onError 转成页面顶部小提示。
async function bootstrap(): Promise<void> {
  await initDb();
  await seedIfEmpty();
  await runStartupSync();
  createApp(App).use(createPinia()).use(router).mount('#app');
  const handle = startAutoSync({
    enabled: initialAutoSyncEnabled(),
    onResult: (r) => toastAutoSync(r as SyncResult),
    onError: () => pushToast('error', '同步失败，请检查网络或 Token。'),
  });
  // 把调度器句柄登记给「自动同步」开关（侧栏底部），使开关能真正开/关后台推送。
  registerAutoSyncHandle(handle);
}

void bootstrap();
