import { Router } from 'express';
import { hash } from 'bcryptjs';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma, tx, audit, requireRoles, AppError, disconnectUser, pagination, publish } from '../lib/core.js';

export const adminRouter = Router();
const safeUser = { id: true, name: true, email: true, role: true, active: true, createdAt: true } as const;
const role = z.enum(['OWNER', 'MANAGER', 'CASHIER', 'KITCHEN', 'INVENTORY']);
const password = z.string().min(12).max(72).refine(value => Buffer.byteLength(value) <= 72, 'Password must fit within 72 UTF-8 bytes.');
const userSchema = z.object({ name: z.string().trim().min(1).max(100), email: z.email().trim().toLowerCase().max(254), password, role, active: z.boolean().default(true) }).strict();
adminRouter.get('/users', requireRoles('OWNER'), async (req, res) => {
  const p = pagination(req);
  const [users, total] = await Promise.all([prisma.user.findMany({ select: safeUser, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take }), prisma.user.count()]);
  res.json({ data: users, pagination: { page: p.page, pageSize: p.pageSize, total } });
});
adminRouter.post('/users', requireRoles('OWNER'), async (req, res) => {
  const input = userSchema.parse(req.body);
  const passwordHash = await hash(input.password, 12);
  const user = await tx(async t => {
    const created = await t.user.create({ data: { name: input.name, email: input.email, passwordHash, role: input.role, active: input.active }, select: safeUser });
    await audit(t, req.user!.id, 'USER_CREATED', 'User', created.id, { role: created.role });
    return created;
  });
  res.status(201).json({ data: user });
});
adminRouter.patch('/users/:id', requireRoles('OWNER'), async (req, res) => {
  const id = String(req.params.id);
  const input = userSchema.omit({ email: true, active: true }).partial().extend({ active: z.boolean().optional() }).strict().parse(req.body);
  const passwordHash = input.password ? await hash(input.password, 12) : undefined;
  const user = await tx(async t => {
    const existing = await t.user.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, 'NOT_FOUND', 'User not found.');
    if (id === req.user!.id && (input.active === false || (input.role && input.role !== 'OWNER'))) throw new AppError(409, 'SELF_LOCKOUT', 'Another owner must change your access.');
    if (existing.role === 'OWNER' && existing.active && (input.active === false || (input.role && input.role !== 'OWNER')) && await t.user.count({ where: { role: 'OWNER', active: true } }) <= 1) throw new AppError(409, 'LAST_OWNER', 'Keep at least one active owner.');
    const updated = await t.user.update({ where: { id }, data: { name: input.name, active: input.active, role: input.role, passwordHash }, select: safeUser });
    if (passwordHash || input.active === false || input.role) await t.session.deleteMany({ where: { sess: { path: ['userId'], equals: id } } });
    await audit(t, req.user!.id, 'USER_UPDATED', 'User', id, { name: input.name, active: input.active, role: input.role, passwordChanged: !!passwordHash });
    return updated;
  });
  disconnectUser(id);
  res.json({ data: user });
});
adminRouter.get('/settings', async (_req, res) => { res.json({ data: await prisma.restaurantSettings.findUniqueOrThrow({ where: { id: 'primary' } }) }); });
const fraction = z.string().regex(/^(?:0(?:\.\d{1,6})?|1(?:\.0{1,6})?)$/);
adminRouter.patch('/settings', requireRoles('OWNER'), async (req, res) => {
  const input = z.object({ name: z.string().trim().min(1).max(120), currency: z.string().regex(/^[A-Z]{3}$/), timezone: z.string().refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }), taxRate: fraction, cashierDiscountLimit: fraction, paymentMethods: z.array(z.string().regex(/^[A-Z_]{2,32}$/)).min(1).max(10).refine(values => new Set(values).size === values.length) }).partial().strict().parse(req.body);
  const settings = await tx(async t => {
    const result = await t.restaurantSettings.update({ where: { id: 'primary' }, data: input });
    await audit(t, req.user!.id, 'SETTINGS_UPDATED', 'RestaurantSettings', 'primary', input);
    return result;
  });
  publish('settings:changed', { id: 'primary' });
  res.json({ data: settings });
});
adminRouter.get('/audit', requireRoles('OWNER'), async (req, res) => {
  const p = pagination(req);
  const query = z.object({ action: z.string().max(80).optional(), entityType: z.string().max(80).optional() }).parse(req.query);
  const where: Prisma.AuditLogWhereInput = { action: query.action, entityType: query.entityType };
  const [rows, total] = await Promise.all([prisma.auditLog.findMany({ where, include: { actor: { select: { name: true, role: true } } }, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take }), prisma.auditLog.count({ where })]);
  res.json({ data: rows, pagination: { page: p.page, pageSize: p.pageSize, total } });
});
adminRouter.get('/notifications', async (req, res) => {
  const p = pagination(req);
  const where: Prisma.NotificationWhereInput = { OR: [{ userId: req.user!.id }, { userId: null, roles: { has: req.user!.role } }] };
  const [rows, total] = await Promise.all([prisma.notification.findMany({ where, include: { reads: { where: { userId: req.user!.id } } }, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take }), prisma.notification.count({ where })]);
  res.json({ data: rows.map(row => ({ ...row, read: row.reads.length > 0, reads: undefined })), pagination: { page: p.page, pageSize: p.pageSize, total } });
});
adminRouter.post('/notifications/:id/read', async (req, res) => {
  const id = String(req.params.id);
  const notification = await prisma.notification.findFirst({ where: { id, OR: [{ userId: req.user!.id }, { userId: null, roles: { has: req.user!.role } }] } });
  if (!notification) throw new AppError(404, 'NOT_FOUND', 'Notification not found.');
  await prisma.notificationRead.upsert({ where: { notificationId_userId: { notificationId: id, userId: req.user!.id } }, create: { notificationId: id, userId: req.user!.id }, update: {} });
  res.json({ data: { read: true } });
});
