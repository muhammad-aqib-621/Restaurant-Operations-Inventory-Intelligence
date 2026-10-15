import { randomBytes, timingSafeEqual } from 'node:crypto';
import session from 'express-session';
import pgSession from 'connect-pg-simple';
import pg from 'pg';
import type { RequestHandler } from 'express';
import { env } from '../config.js';
import { prisma } from '../db.js';
import { AppError } from './core.js';

const Store = pgSession(session);
export const sessionPool = new pg.Pool({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 3000, max: 5 });
export const sessionMiddleware = session({
  name: 'nk.sid', secret: env.SESSION_SECRET,
  store: new Store({ pool: sessionPool, tableName: 'Session', createTableIfMissing: false, pruneSessionInterval: false }),
  resave: false, saveUninitialized: false, rolling: true,
  cookie: { httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 },
});
export function csrfToken(req: Express.Request & { session: session.Session & Partial<session.SessionData> }) {
  return req.session.csrfToken ??= randomBytes(32).toString('hex');
}
export const csrfProtection: RequestHandler = (req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('Origin');
  if (origin && origin !== new URL(env.APP_ORIGIN).origin) return next(new AppError(403, 'ORIGIN_REJECTED', 'Request origin is not allowed.'));
  const token = req.get('x-csrf-token');
  const expected = req.session.csrfToken;
  if (!token || !expected || !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(expected))) return next(new AppError(403, 'CSRF_REJECTED', 'Refresh your session before making changes.'));
  if (!req.is('application/json')) return next(new AppError(415, 'JSON_REQUIRED', 'Send an application/json request.'));
  next();
};
export const authenticate: RequestHandler = async (req, _res, next) => {
  try {
    if (!req.session.userId) throw new AppError(401, 'UNAUTHENTICATED', 'Please sign in.');
    const user = await prisma.user.findUnique({ where: { id: req.session.userId }, select: { id: true, name: true, email: true, role: true, active: true } });
    if (!user?.active) {
      req.session.destroy(() => {});
      throw new AppError(401, 'ACCOUNT_UNAVAILABLE', 'This account is unavailable.');
    }
    req.user = user;
    next();
  } catch (error) { next(error); }
};
