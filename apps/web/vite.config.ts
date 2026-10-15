import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, workspaceRoot, ''), ...process.env };
  const host = env.WEB_HOST ?? '127.0.0.1';
  const port = Number(env.WEB_PORT ?? 5173);
  return {
    envDir: workspaceRoot,
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    server: {
      host,
      port,
      strictPort: true,
      proxy: {
        '/socket.io': { target: `http://127.0.0.1:${env.API_PORT ?? 4000}`, ws: true, changeOrigin: true },
        '/api': {
          target: `http://127.0.0.1:${env.API_PORT ?? 4000}`,
          changeOrigin: true,
        },
      },
    },
    preview: { host, port, strictPort: true, proxy: { '/api': { target: `http://127.0.0.1:${env.API_PORT ?? 4000}`, changeOrigin: true }, '/socket.io': { target: `http://127.0.0.1:${env.API_PORT ?? 4000}`, ws: true, changeOrigin: true } } },
  };
});
