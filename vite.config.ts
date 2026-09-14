import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'MOTIVE_');
  const port = process.env.MOTIVE_API_PORT || env.MOTIVE_API_PORT || '4318';
  if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535) throw new Error('MOTIVE_API_PORT must be between 1024 and 65535.');
  const apiTarget = `http://127.0.0.1:${Number(port)}`;
  const proxy = Object.fromEntries(['/api', '^/mcp/?(?:\\?|$)', '^/(?:authorize|token|register|revoke)(?:\\?|$)',
    '/.well-known/oauth-'].map(path => [path, apiTarget]));
  return {
  plugins: [react(), tailwindcss()],
  server: { proxy },
  preview: { proxy },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  };
});
