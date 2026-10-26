import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const apiPort = process.env.API_PORT || '8787'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': process.env.VITE_API_PROXY || `http://127.0.0.1:${apiPort}`,
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
