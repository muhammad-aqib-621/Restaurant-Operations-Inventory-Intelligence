import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { hash, compare } from 'bcryptjs';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { prisma, tx, audit, notify, publish, AppError, disconnectUser } from '../lib/core.js';
import { csrfToken } from '../lib/session.js';

export const authRouter = Router();
const safeSelect = { id: true, name: true, email: true, role: true, active: true } as const;
const dummyHash = await hash(randomBytes(32).toString('hex'), 12);
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 15, standardHeaders: 'draft-8', legacyHeaders: false,
  handler: (req, res) => { res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many sign-in attempts. Try again later.', requestId: req.id } }); },
});
const registrationLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false,
  handler: (req, res) => { res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many account requests. Try again later.', requestId: req.id } }); },
});
const registrationResponse = { message: 'If this email can be registered, the account request has been submitted for owner review.' };
authRouter.get('/me', async (req, res) => {
  const user = req.session.userId ? await prisma.user.findUnique({ where: { id: req.session.userId }, select: safeSelect }) : null;
  res.json({ data: { user: user?.active ? user : null, csrfToken: csrfToken(req) } });
});
authRouter.post('/register', registrationLimiter, async (req, res) => {
  const input = z.object({
    name: z.string().trim().min(2).max(100),
    email: z.email().trim().toLowerCase().max(254),
    password: z.string().min(12).max(72).refine(value => Buffer.byteLength(value) <= 72, 'Password must fit within 72 UTF-8 bytes.'),
  }).strict().parse(req.body);
  const passwordHash = await hash(input.password, 12);
  let created = false;
  try {
    created = await tx(async t => {
      const existing = await t.user.findUnique({ where: { email: input.email }, select: { id: true } });
      if (existing) return false;
      const user = await t.user.create({
        data: { name: input.name, email: input.email, passwordHash, role: 'CASHIER', active: false },
        select: { id: true, email: true },
      });
      await audit(t, null, 'ACCOUNT_REGISTRATION_REQUESTED', 'User', user.id, { email: user.email });
      await notify(t, 'ACCOUNT_REGISTRATION_REQUESTED', 'Account request', `Review the account request from ${input.name} (${input.email}) under Team members.`, ['OWNER']);
      return true;
    });
  } catch (error) {
    if ((error as { code?: string }).code !== 'P2002') throw error;
  }
  if (created) publish('notifications:changed', { type: 'ACCOUNT_REGISTRATION_REQUESTED' }, ['OWNER']);
  res.status(202).json({ data: registrationResponse });
});
authRouter.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = z.object({ email: z.email().trim().toLowerCase().max(254), password: z.string().min(1).max(72).refine(value => Buffer.byteLength(value) <= 72, 'Password must fit within 72 UTF-8 bytes.') }).strict().parse(req.body);
  const account = await prisma.user.findUnique({ where: { email } });
  const matches = await compare(password, account?.passwordHash ?? dummyHash);
  if (!matches || !account?.active) throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
  await new Promise<void>((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
  req.session.userId = account.id;
  const token = csrfToken(req);
  await tx(t => audit(t, account.id, 'LOGIN', 'User', account.id));
  await new Promise<void>((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
  const { passwordHash: _passwordHash, ...user } = account;
  res.json({ data: { user, csrfToken: token } });
});
authRouter.post('/logout', async (req, res) => {
  const userId = req.session.userId;
  if (req.session.userId) await tx(t => audit(t, req.session.userId!, 'LOGOUT', 'User', req.session.userId));
  await new Promise<void>((resolve, reject) => req.session.destroy(error => error ? reject(error) : resolve()));
  if (userId) disconnectUser(userId);
  res.clearCookie('nk.sid', { path: '/' });
  res.json({ data: { loggedOut: true } });
});
