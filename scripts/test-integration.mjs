import 'dotenv/config';
import { Client } from 'pg';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

if (process.env.NODE_ENV === 'production') throw new Error('Integration database provisioning is development-only.');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const root = fileURLToPath(new URL('../', import.meta.url));
const mode = process.argv[2] ?? 'integration';
if (!['integration', 'e2e'].includes(mode)) throw new Error('Unknown test mode.');
const name = `nk_test_${Date.now()}_${randomBytes(4).toString('hex')}`;
const original = new URL(process.env.DATABASE_URL);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(original.hostname)) throw new Error('Disposable integration runner requires a local PostgreSQL instance.');
const adminUrl = new URL(original); adminUrl.pathname = '/postgres';
const testUrl = new URL(original); testUrl.pathname = `/${name}`;
const admin = new Client({ connectionString: adminUrl.toString() });
const testEnv = { ...process.env, NODE_ENV: 'test', DATABASE_URL: testUrl.toString(), ...(mode === 'e2e' ? {
  API_PORT: '4100', WEB_PORT: '5174', APP_ORIGIN: 'http://127.0.0.1:5174', WEB_BASE_URL: 'http://127.0.0.1:5174', E2E_MANAGED: '1',
  ...(existsSync('/usr/bin/chromium') ? { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/usr/bin/chromium' } : {}),
} : {}) };
const run = (script, args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [script, ...args], { cwd: root, env: testEnv, stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Integration step exited with status ${code}`)));
});
await admin.connect();
let created = false;
try {
  await admin.query(`CREATE DATABASE "${name}"`); created = true;
  await run('node_modules/prisma/build/index.js', ['migrate', 'deploy']);
  await run('node_modules/tsx/dist/cli.mjs', ['prisma/seed.ts']);
  if (mode === 'e2e') await run('node_modules/@playwright/test/cli.js', ['test', '--config', 'apps/web/playwright.config.ts']);
  else await run('node_modules/vitest/vitest.mjs', ['run', '--root', 'apps/api', '--no-file-parallelism', 'test/database.integration.test.ts', 'test/auth.integration.test.ts', 'test/catalog-inventory.integration.test.ts', 'test/orders.integration.test.ts', 'test/purchasing-reports.integration.test.ts']);
} finally {
  if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
}
