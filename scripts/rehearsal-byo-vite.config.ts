import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { BYO_VITE_DENY } from './lib/byo-rehearsal.ts';

export default defineConfig({
  root: resolve(import.meta.dirname, '..'),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': resolve(import.meta.dirname, '../src') } },
  server: {
    host: '127.0.0.1',
    port: 4335,
    strictPort: true,
    fs: { strict: true, deny: [...BYO_VITE_DENY] },
    proxy: { '/api': 'http://127.0.0.1:4336' },
  },
});
