import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { loadEnv } from 'vite';

const env = { ...loadEnv('test', fileURLToPath(new URL('../../', import.meta.url)), ''), ...process.env };

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  webServer: process.env.E2E_MANAGED === '1' ? [
    { command: 'npm run dev --workspace @nk/api', cwd: fileURLToPath(new URL('../../', import.meta.url)), url: 'http://127.0.0.1:4100/api/health', reuseExistingServer: false, timeout: 30000, gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 } },
    { command: 'npm run dev --workspace @nk/web', cwd: fileURLToPath(new URL('../../', import.meta.url)), url: env.WEB_BASE_URL ?? 'http://127.0.0.1:5174', reuseExistingServer: false, timeout: 30000, gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 } },
  ] : undefined,
  reporter: 'list',
  use: {
    baseURL: env.WEB_BASE_URL ?? `http://${env.WEB_HOST ?? '127.0.0.1'}:${env.WEB_PORT ?? 5173}`,
    launchOptions: env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {},
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
