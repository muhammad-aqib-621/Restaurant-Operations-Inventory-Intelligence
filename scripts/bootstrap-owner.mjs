import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';
import { z } from 'zod';

// Deliberately do not load .env: production provisioning uses explicitly injected secrets.
class BootstrapError extends Error {}
const config = z.object({
  NODE_ENV: z.literal('production'),
  DATABASE_URL: z.url().refine(value => value.startsWith('postgresql://') || value.startsWith('postgres://')),
  OWNER_EMAIL: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  OWNER_NAME: z.string().trim().min(1).max(100),
  OWNER_PASSWORD: z.string().min(14).refine(value => Buffer.byteLength(value, 'utf8') <= 72),
});
let prisma;
try {
  const parsed = config.safeParse(process.env);
  if (!parsed.success) {
    throw new BootstrapError(`Owner bootstrap requires explicit production configuration; invalid or missing fields: ${[...new Set(parsed.error.issues.map(issue => issue.path.join('.')))].join(', ')}. Passwords must have at least 14 characters and at most 72 UTF-8 bytes.`);
  }
  const env = parsed.data;
  const databaseUrl = new URL(env.DATABASE_URL);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname)
      && databaseUrl.searchParams.get('sslmode') !== 'verify-full') {
    throw new BootstrapError('A non-loopback production database requires sslmode=verify-full and a trusted certificate. Configure the database URL and certificate trust securely before provisioning.');
  }
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
  const passwordHash = await bcrypt.hash(env.OWNER_PASSWORD, 12);
  await prisma.$transaction(async db => {
    if (await db.user.findFirst({ where: { role: 'OWNER' }, select: { id: true } })) {
      throw new BootstrapError('A restaurant owner already exists. Bootstrap made no changes; use authenticated owner user management.');
    }
    const settings = await db.restaurantSettings.findUnique({ where: { id: 'primary' } });
    if (settings?.isDemo) throw new BootstrapError('Refusing to bootstrap a production owner into demonstration data. Use the intended production database.');
    if (!settings) await db.restaurantSettings.create({ data: {
      id: 'primary', name: 'New Karachi Fast Food', currency: 'PKR', timezone: 'Asia/Karachi',
      taxRate: '0', isDemo: false,
    } });
    const owner = await db.user.create({ data: { name: env.OWNER_NAME, email: env.OWNER_EMAIL, passwordHash, role: 'OWNER' } });
    await db.auditLog.create({ data: { actorId: owner.id, action: 'OWNER_BOOTSTRAPPED', entityType: 'User', entityId: owner.id, details: { note: 'First production owner securely provisioned; configure real tax/payment policies before recording operations.' } } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 });
  console.log('First production owner created. Configure the applicable restaurant tax, discount and payment policies before recording business activity.');
} catch (error) {
  console.error(error instanceof BootstrapError ? error.message : 'Owner bootstrap failed. Check the database connection, applied migrations, unique email and concurrent provisioning. No credentials are printed.');
  process.exitCode = 1;
} finally {
  if (prisma) await prisma.$disconnect();
}
