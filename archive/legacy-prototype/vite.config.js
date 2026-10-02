import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const legacyRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(path.dirname(legacyRoot));

export default defineConfig({
  root: legacyRoot,
  server: {
    port: 5174,
    fs: { allow: [repoRoot] },
    proxy: { '/api': process.env.API_TARGET || 'http://127.0.0.1:8787' },
  },
});
