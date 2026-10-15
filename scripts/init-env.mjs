import { randomBytes } from 'node:crypto';
import { writeFile, readFile, appendFile, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

if (process.env.NODE_ENV === 'production') {
  throw new Error('Development environment initialization is disabled in production.');
}
const password = randomBytes(32).toString('hex');
const contents = `# Generated local development configuration. Never commit this file.
NODE_ENV=development
POSTGRES_USER=nk_dev
POSTGRES_PASSWORD=${password}
POSTGRES_DB=nk_operations
POSTGRES_PORT=5432
DATABASE_URL=postgresql://nk_dev:${password}@127.0.0.1:5432/nk_operations?schema=public
API_HOST=127.0.0.1
API_PORT=4000
WEB_HOST=127.0.0.1
WEB_PORT=5173
APP_ORIGIN=http://127.0.0.1:5173
SESSION_SECRET=${randomBytes(32).toString('hex')}
DEMO_PASSWORD=${randomBytes(24).toString('base64url')}
`;
const path = fileURLToPath(new URL('../.env', import.meta.url));
try {
  await writeFile(path, contents, { flag: 'wx', mode: 0o600 });
  console.log('Created ignored local .env with random database, session, and development seed credentials.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  const existing = await readFile(path, 'utf8');
  const missing = [
    ['SESSION_SECRET', randomBytes(32).toString('hex')],
    ['DEMO_PASSWORD', randomBytes(24).toString('base64url')],
    ['APP_ORIGIN', 'http://127.0.0.1:5173'],
  ].filter(([name]) => !new RegExp(`^(?:export\\s+)?${name}\\s*=`, 'm').test(existing));
  if (missing.length) await appendFile(path, `\n${missing.map(([name, value]) => `${name}=${value}`).join('\n')}\n`);
  await chmod(path, 0o600);
  console.log('Existing values preserved; missing development-only configuration added if needed.');
}
