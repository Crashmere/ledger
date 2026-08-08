import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Cross-Origin Isolation headers are required by sqlite-wasm's OPFS VFS
// (it relies on SharedArrayBuffer / cross-origin isolation).
// Dev + preview servers both need them; S6 will replicate these on the host.
const crossOriginIsolation = {
  name: 'cross-origin-isolation',
  configureServer(server: import('vite').ViteDevServer) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      next();
    });
  },
  configurePreviewServer(server: import('vite').PreviewServer) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      next();
    });
  },
};

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), crossOriginIsolation],
  // sqlite-wasm ships its own worker/wasm; keep it out of the dep pre-bundle.
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  worker: {
    format: 'es',
  },
});
