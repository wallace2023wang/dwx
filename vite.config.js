import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, proxy: { '/api': process.env.API_TARGET || 'http://127.0.0.1:8787' } },
});
