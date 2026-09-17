import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Defaults are the mandated 5173 -> 3001 pair. Both are overridable so the app
// can be exercised alongside another project that already owns those ports.
const WEB_PORT = Number(process.env.BPD_WEB_PORT ?? 5173);
const API_PORT = Number(process.env.BPD_API_PORT ?? 3001);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@bpd/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: WEB_PORT,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
});