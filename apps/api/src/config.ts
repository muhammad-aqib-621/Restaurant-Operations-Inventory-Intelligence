import { config } from 'dotenv';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';

config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });
const schema = z.object({
  DATABASE_URL: z.url().refine(value => value.startsWith('postgresql://') || value.startsWith('postgres://')),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_HOST: z.string().default('127.0.0.1'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SESSION_SECRET: z.string().min(32),
  APP_ORIGIN: z.url().default('http://127.0.0.1:5173'),
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
}).superRefine((value, context) => {
  if (value.NODE_ENV !== 'production') return;
  let origin: URL, database: URL;
  try { origin = new URL(value.APP_ORIGIN); database = new URL(value.DATABASE_URL); } catch { return; }
  if (origin.protocol !== 'https:') context.addIssue({ code: 'custom', path: ['APP_ORIGIN'], message: 'Production requires HTTPS.' });
  if (!['localhost', '127.0.0.1', '[::1]'].includes(database.hostname) && database.searchParams.get('sslmode') !== 'verify-full') context.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'Remote production PostgreSQL requires verified TLS.' });
});
const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Print field names only: malformed credential-bearing URLs must not reach logs.
  throw new Error(`Invalid environment configuration: ${parsed.error.issues.map(issue => issue.path.join('.')).join(', ')}`);
}
export const env = parsed.data;
