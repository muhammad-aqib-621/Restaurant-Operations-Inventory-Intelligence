import { Router } from 'express';
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma, requireRoles, requestKey, pagination, AppError } from '../lib/core.js';
import { createOrder, changeOrderStatus, markOrderItemReady, recordPayment, refundPayment, getOrder, orderReceipt } from '../lib/order-service.js';

export const ordersRouter = Router();
/** Cost visibility is enforced on every HTTP result, including idempotent command replays. */
function visibleOrder<T>(order: T, role: string): T {
  if (role !== 'CASHIER' && role !== 'KITCHEN') return order;
  const safe = JSON.parse(JSON.stringify(order));
  delete safe.estimatedCost;
  if (Array.isArray(safe.items)) for (const item of safe.items) delete item.estimatedUnitCost;
  return safe;
}

const readers = requireRoles('OWNER', 'MANAGER', 'CASHIER', 'KITCHEN');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const filters = z.object({
  status: z.enum(['PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED']).optional(),
  from: date.optional(), to: date.optional(),
  active: z.enum(['true', 'false']).optional(),
}).passthrough();
ordersRouter.get('/orders', readers, async (req, res) => {
  const input = filters.parse(req.query);
  const page = pagination(req);
  const settings = await prisma.restaurantSettings.findUnique({ where: { id: 'primary' }, select: { timezone: true } });
  const zone = settings?.timezone ?? 'Asia/Karachi';
  const from = input.from ? DateTime.fromISO(input.from, { zone }).startOf('day') : undefined;
  const to = input.to ? DateTime.fromISO(input.to, { zone }).plus({ days: 1 }).startOf('day') : undefined;
  if ((from && !from.isValid) || (to && !to.isValid) || (from && to && from >= to)) throw new AppError(400, 'INVALID_DATE_RANGE', 'Use valid inclusive business dates with from on or before to.');
  const where: Prisma.OrderWhereInput = { status: input.active === 'true' ? { in: ['CONFIRMED', 'PREPARING', 'READY'] } : input.status, ...(from || to ? { createdAt: { ...(from ? { gte: from.toJSDate() } : {}), ...(to ? { lt: to.toJSDate() } : {}) } } : {}) };
  const [data, total] = await Promise.all([
    prisma.order.findMany({ where, orderBy: [{ createdAt: input.active === 'true' ? 'asc' : 'desc' }, { id: 'asc' }], skip: page.skip, take: page.take, include: { items: true, payments: true, customer: true } }),
    prisma.order.count({ where }),
  ]);
  res.json({ data: data.map(order => visibleOrder(order, req.user!.role)), pagination: { page: page.page, pageSize: page.pageSize, total } });
});
ordersRouter.get('/orders/:id/receipt', readers, async (req, res) => { res.json({ data: await orderReceipt(req.params.id as string) }); });
ordersRouter.get('/orders/:id', readers, async (req, res) => { res.json({ data: visibleOrder(await getOrder(req.params.id as string), req.user!.role) }); });
ordersRouter.post('/orders', requireRoles('OWNER', 'MANAGER', 'CASHIER'), async (req, res) => {
  res.status(201).json({ data: visibleOrder(await createOrder(req.user!, req.body, requestKey(req)), req.user!.role) });
});
ordersRouter.post('/orders/:id/status', readers, async (req, res) => {
  res.json({ data: visibleOrder(await changeOrderStatus(req.user!, req.params.id as string, req.body, requestKey(req)), req.user!.role) });
});
ordersRouter.post('/orders/:id/items/:itemId/ready', requireRoles('OWNER', 'MANAGER', 'KITCHEN'), async (req, res) => {
  res.json({ data: visibleOrder(await markOrderItemReady(req.user!, req.params.id as string, req.params.itemId as string, req.body, requestKey(req)), req.user!.role) });
});
ordersRouter.post('/orders/:id/payments', requireRoles('OWNER', 'MANAGER', 'CASHIER'), async (req, res) => {
  res.status(201).json({ data: visibleOrder(await recordPayment(req.user!, req.params.id as string, req.body, requestKey(req)), req.user!.role) });
});
ordersRouter.post('/orders/:id/refunds', requireRoles('OWNER', 'MANAGER'), async (req, res) => {
  res.status(201).json({ data: visibleOrder(await refundPayment(req.user!, req.params.id as string, req.body, requestKey(req)), req.user!.role) });
});
