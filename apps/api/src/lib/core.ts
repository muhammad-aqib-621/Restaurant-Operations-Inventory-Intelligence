import { createHash } from 'node:crypto';
import { Prisma, type Role, type Unit } from '@prisma/client';
import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
export { prisma } from '../db.js';
import { prisma } from '../db.js';

export const Decimal = Prisma.Decimal;
export class AppError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function requireRoles(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) return next(new AppError(401, 'UNAUTHENTICATED', 'Please sign in.'));
    if (!roles.includes(req.user.role)) return next(new AppError(403, 'FORBIDDEN', 'Your role cannot perform this operation.'));
    next();
  };
}
export async function tx<T>(operation: (transaction: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10000, timeout: 20000 });
    } catch (error) {
      const code = (error as { code?: string }).code;
      const adapter = error as { kind?: string; originalCode?: string; cause?: { kind?: string; originalCode?: string } };
      const retryable = code === 'P2034' || code === 'P2002' || adapter.kind === 'TransactionWriteConflict' || adapter.cause?.kind === 'TransactionWriteConflict' || ['40001', '40P01'].includes(adapter.originalCode ?? adapter.cause?.originalCode ?? '');
      if (!retryable || attempt >= 4) throw error;
      await new Promise(resolve => setTimeout(resolve, 10 * 2 ** attempt + Math.random() * 20));
    }
  }
}
function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}
export async function idempotent<T>(t: Prisma.TransactionClient, actorId: string, scope: string, key: string, payload: unknown, operation: () => Promise<T>): Promise<T> {
  const requestHash = createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
  const previous = await t.idempotencyRecord.findUnique({ where: { actorId_scope_key: { actorId, scope, key } } });
  if (previous) {
    if (previous.requestHash !== requestHash) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'This request key was already used with different contents.');
    return previous.response as T;
  }
  const result = await operation();
  const serialized = JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue;
  await t.idempotencyRecord.create({ data: { actorId, scope, key, requestHash, response: serialized } });
  return result;
}
export function requestKey(req: Request): string {
  const parsed = z.string().min(8).max(128).regex(/^[\w.-]+$/).safeParse(req.get('Idempotency-Key'));
  if (!parsed.success) throw new AppError(400, 'IDEMPOTENCY_REQUIRED', 'A valid Idempotency-Key header is required.');
  return parsed.data;
}
export async function audit(t: Prisma.TransactionClient, actorId: string | null, action: string, entityType: string, entityId?: string, details?: unknown) {
  await t.auditLog.create({ data: { actorId, action, entityType, entityId, ...(details === undefined ? {} : { details: JSON.parse(JSON.stringify(details)) as Prisma.InputJsonValue }) } });
}
export async function notify(t: Prisma.TransactionClient, type: string, title: string, message: string, roles: Role[]) {
  return t.notification.create({ data: { type, title, message, roles } });
}
type Emitter = (event: string, payload: unknown, roles: Role[]) => void;
let emitter: Emitter = () => {};
let disconnector: (userId: string) => void = () => {};
export function configureRealtime(send: Emitter, disconnect: (userId: string) => void) { emitter = send; disconnector = disconnect; }
export function publish(event: string, payload: unknown, roles: Role[] = ['OWNER', 'MANAGER', 'CASHIER', 'KITCHEN', 'INVENTORY']) { emitter(event, payload, roles); }
export function disconnectUser(userId: string) { disconnector(userId); }
export function quantity(value: Prisma.Decimal.Value, fromUnit: Unit, canonicalUnit: Unit): Prisma.Decimal {
  const units: Record<Unit, { kind: string; factor: number }> = { G: { kind: 'mass', factor: 1 }, KG: { kind: 'mass', factor: 1000 }, ML: { kind: 'volume', factor: 1 }, L: { kind: 'volume', factor: 1000 }, PIECE: { kind: 'count', factor: 1 } };
  const from = units[fromUnit], to = units[canonicalUnit];
  if (!from || !to || from.kind !== to.kind) throw new AppError(400, 'INCOMPATIBLE_UNIT', 'Use compatible mass, volume, or piece units.');
  let result: Prisma.Decimal;
  try { result = new Decimal(value).mul(from.factor).div(to.factor); }
  catch { throw new AppError(400, 'INVALID_QUANTITY', 'Enter a valid decimal quantity.'); }
  if (!result.isFinite() || result.decimalPlaces() > 6 || result.abs().gte('1000000000000')) throw new AppError(400, 'INVALID_QUANTITY', 'Quantity exceeds supported precision or range.');
  return result;
}
export function pagination(req: Request) {
  const { page, pageSize } = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(30) }).parse(req.query);
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}
