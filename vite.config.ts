import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { VitePWA } from 'vite-plugin-pwa';

// ------------------------------------------------------------
// 部署 base（S6 §四.4）：
//   本地开发/预览默认 '/'; 部署到 GitHub Pages 项目页
//   https://<user>.github.io/<repo>/ 时，构建前设 DEPLOY_BASE=/<repo>/
//   例：DEPLOY_BASE=/ivy-wallet/ npm run build
//   —— 否则子路径下 JS/CSS/wasm 全部 404。manifest 的 start_url/scope、
//   SW 的 scope 都跟随此 base（下方 PWA 配置里同步）。
// ------------------------------------------------------------
const base = process.env.DEPLOY_BASE ?? '/';

// 注意（S6）：已移除旧的 crossOriginIsolation 插件（不再注入 COOP/COEP）。
// 新的 OPFS-SAHPool VFS 基于 createSyncAccessHandle，不依赖 SharedArrayBuffer，
// 因此纯静态托管（GitHub Pages）无需跨源隔离头即可持久化。

// https://vite.dev/config/
export default defineConfig({
  base,
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate', // 个人自用：下次打开自动用新版。
      // 额外需被 SW 预缓存、但不在构建输出清单里的静态资产（放 public/）。
      // 字体已自托管在 src/assets/fonts，经 Vite 打包进产物清单，无需在此列出。
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: '记账 · 本地优先',
        short_name: '记账',
        description: '本地优先的个人记账应用，数据存于设备、断网可用。',
        lang: 'zh-CN',
        display: 'standalone',
        start_url: base,
        scope: base,
        theme_color: '#1a73e8', // tokens.css --primary
        background_color: '#f6f8fc', // tokens.css --bg
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'pwa-maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // 预缓存应用外壳：务必覆盖 wasm/字体，否则断网首开取不到 wasm 会白屏。
        globPatterns: ['**/*.{js,css,html,wasm,woff2,svg,png,ico}'],
        // sqlite wasm ~856KB、index chunk 数百 KB；默认 ~2MB 上限可能漏掉，调大到 4MB。
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
      devOptions: {
        // 开发期不启用 SW，避免缓存干扰 HMR。
        enabled: false,
      },
    }),
  ],
  // sqlite-wasm ships its own wasm; keep it out of the dep pre-bundle.
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  // SQLite 跑在专用 Worker（src/db/sqlite.worker.ts，SAHPool VFS）。
  // sqlite-wasm 的 bundler-friendly 模块是 ESM 且用动态 import，故 Worker 必须 ES 格式。
  worker: {
    format: 'es',
  },
});
