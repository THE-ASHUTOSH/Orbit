import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

/**
 * Dev server proxies to the API server so the browser sees one origin in
 * development too - same cookie, same WebSocket URL logic as production.
 */
export default defineConfig({
  plugins: [react(), tailwind()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false },
      '/ws': { target: 'ws://127.0.0.1:3000', ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true, target: 'es2022' },
});
