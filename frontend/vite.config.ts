import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': 'http://127.0.0.1:8789',
      '/build-api': {
        target: 'http://127.0.0.1:8788',
        rewrite: (path) => path.replace(/^\/build-api/, ''),
      },
      '/res-api': {
        target: 'http://127.0.0.1:8790',
        rewrite: (path) => path.replace(/^\/res-api/, ''),
      },
    },
  },
})
