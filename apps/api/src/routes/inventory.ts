import { Router } from 'express';
import { z } from 'zod';
import { DateTime } from 'luxon';
import type { Prisma } from '@prisma/client';
import { AppError, Decimal, audit, idempotent, notify, pagination, prisma, publish, quantity, requestKey, requireRoles, tx } from '../lib/core.js';
import { approveStockAdjustment, approveStockCount, reverseStockMovement } from '../lib/inventory.js';

export const inventoryRouter = Router();
const readers = ['OWNER', 'MANAGER', 'INVENTORY'] as const;
const decimal = z.string().regex(/^\d{1,12}(\.\d{1,6})?$/, 'Use a nonnegative decimal string with at most six decimal places.');
const signedDecimal = z.string().regex(/^-?\d{1,12}(\.\d{1,6})?$/, 'Use a signed decimal string with at most six decimal places.').refine(value => !new Decimal(value).isZero(), 'Adjustment quantity cannot be zero.');
const unit = z.enum(['G', 'KG', 'ML', 'L', 'PIECE']);
const reasonInput = z.object({ reason: z.string().trim().min(3).max(2000) }).strict();
const adjustmentInput = z.object({ ingredientId: z.string().min(1).max(100), quantity: signedDecimal, unit, reason: z.string().trim().min(3).max(2000) }).strict();
const countInput = z.object({ notes: z.string().trim().max(2000).optional(), items: z.array(z.object({ ingredientId: z.string().min(1).max(100), quantity: decimal, unit }).strict()).min(1).max(500) }).strict();
const movementTypes = z.enum(['OPENING', 'PURCHASE', 'CONSUMPTION', 'WASTE', 'ADJUSTMENT', 'COUNT', 'REVERSAL']);
const approvalStates = z.enum(['PENDING', 'APPROVED', 'REJECTED']);
const emptyInput = z.object({}).strict();

function dateRange(query: Record<string, unknown>, timezone: string): { gte?: Date; lt?: Date; lte?: Date } | undefined {
  const parse = (value: unknown, end: boolean) => {
    if (value === undefined) return undefined;
    const input = z.union([z.iso.date(), z.iso.datetime()]).parse(value);
    const date = DateTime.fromISO(input, { zone: timezone });
    if (!date.isValid) throw new AppError(400, 'INVALID_DATE', 'Invalid date filter.');
    return (end && input.length === 10 ? date.plus({ days: 1 }) : date).toUTC().toJSDate();
  };
  const from = parse(query.from, false);
  const to = parse(query.to, true);
  if (from && to && from > to) throw new AppError(400, 'INVALID_DATE_RANGE', 'The end date must follow the start date.');
  return from || to ? { ...(from ? { gte: from } : {}), ...(to ? (String(query.to).length === 10 ? { lt: to } : { lte: to }) : {}) } : undefined;
}

inventoryRouter.get('/inventory/movements', requireRoles(...readers), async (req, res) => {
  const page = pagination(req);
  const settings = await prisma.restaurantSettings.findUnique({ where: { id: 'primary' }, select: { timezone: true } });
  const where: Prisma.InventoryMovementWhereInput = { ...(typeof req.query.ingredientId === 'string' ? { ingredientId: req.query.ingredientId } : {}), ...(req.query.type !== undefined ? { type: movementTypes.parse(req.query.type) } : {}), createdAt: dateRange(req.query, settings?.timezone ?? 'Asia/Karachi') };
  const [rows, total] = await Promise.all([prisma.inventoryMovement.findMany({ where, include: { ingredient: { select: { id: true, name: true, sku: true, unit: true } }, actor: { select: { id: true, name: true } }, reversedBy: { select: { id: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: page.skip, take: page.take }), prisma.inventoryMovement.count({ where })]);
  res.json({ data: rows, pagination: { page: page.page, pageSize: page.pageSize, total } });
});

inventoryRouter.get('/inventory/reservations', requireRoles(...readers), async (req, res) => {
  const page = pagination(req);
  const status = req.query.status === undefined ? 'ACTIVE' : z.enum(['ACTIVE', 'CONSUMED', 'RELEASED']).parse(req.query.status);
  const where = { status, ...(typeof req.query.ingredientId === 'string' ? { ingredientId: req.query.ingredientId } : {}) };
  const [rows, total] = await Promise.all([prisma.inventoryReservation.findMany({ where, include: { ingredient: { select: { id: true, name: true, sku: true, unit: true } }, order: { select: { id: true, number: true, status: true } } }, orderBy: { createdAt: 'desc' }, skip: page.skip, take: page.take }), prisma.inventoryReservation.count({ where })]);
  res.json({ data: rows, pagination: { page: page.page, pageSize: page.pageSize, total } });
});

inventoryRouter.get('/inventory/alerts', requireRoles(...readers), async (_req, res) => {
  const asOf = new Date();
  const since = new Date(asOf.getTime() - 30 * 86400000);
  const soon = new Date(asOf.getTime() + 7 * 86400000);
  const [ingredients, consumptions] = await Promise.all([
    prisma.ingredient.findMany({ where: { active: true }, include: { preferredSupplier: { select: { id: true, name: true } } }, orderBy: { name: 'asc' } }),
    prisma.inventoryMovement.findMany({ where: { type: 'CONSUMPTION', createdAt: { gte: since }, quantity: { lt: 0 } }, select: { ingredientId: true, quantity: true, createdAt: true } }),
  ]);
  const rows = ingredients.map(row => ({ ...row, available: row.onHand.minus(row.reserved).toString() }));
  const lowStock = rows.filter(row => new Decimal(row.available).lte(row.minimumStock));
  const expiring = rows.filter(row => row.expiresAt && row.expiresAt <= soon && row.onHand.gt(0));
  const forecasts = ingredients.map(ingredient => {
    const records = consumptions.filter(movement => movement.ingredientId === ingredient.id);
    const first = records.reduce((earliest, movement) => Math.min(earliest, movement.createdAt.getTime()), asOf.getTime());
    const historyDays = records.length ? Math.min(30, Math.max(1, Math.ceil((asOf.getTime() - first) / 86400000))) : 0;
    const insufficientHistory = historyDays < 7;
    const available = ingredient.onHand.minus(ingredient.reserved);
    const consumed = records.reduce((sum, movement) => sum.minus(movement.quantity), new Decimal(0));
    const dailyUsage = insufficientHistory ? null : consumed.div(historyDays);
    const daysUntilStockout = dailyUsage && dailyUsage.gt(0) ? available.div(dailyUsage).floor().toNumber() : null;
    const suggestedReorder = dailyUsage ? Decimal.max(0, dailyUsage.mul(7).plus(ingredient.minimumStock).minus(available)).toFixed(6) : null;
    return { ingredientId: ingredient.id, name: ingredient.name, unit: ingredient.unit, available: available.toString(), dailyUsage: dailyUsage?.toFixed(6) ?? null, daysUntilStockout, suggestedReorder, historyDays, insufficientHistory };
  });
  res.json({ data: { lowStock, expiring, forecasts, asOf, forecastDescription: 'Estimate from up to 30 days of recorded recipe consumption; seven days of history are required. Reorder suggestion covers seven forecast days plus minimum stock. Pending purchases are not deducted.' } });
});

inventoryRouter.get('/inventory/counts', requireRoles(...readers), async (req, res) => {
  const page = pagination(req);
  const where = req.query.status === undefined ? {} : { status: approvalStates.parse(req.query.status) };
  const [rows, total] = await Promise.all([prisma.stockCount.findMany({ where, include: { items: { include: { ingredient: true } }, createdBy: { select: { id: true, name: true } }, approvedBy: { select: { id: true, name: true } } }, orderBy: { createdAt: 'desc' }, skip: page.skip, take: page.take }), prisma.stockCount.count({ where })]);
  res.json({ data: rows, pagination: { page: page.page, pageSize: page.pageSize, total } });
});

inventoryRouter.post('/inventory/counts', requireRoles(...readers), async (req, res) => {
  const data = countInput.parse(req.body);
  const key = requestKey(req);
  if (new Set(data.items.map(line => line.ingredientId)).size !== data.items.length) throw new AppError(400, 'DUPLICATE_INGREDIENT', 'An ingredient may appear only once in a count.');
  const result = await tx(transaction => idempotent(transaction, req.user!.id, 'inventory.count.create', key, data, async () => {
    const ingredients = await transaction.ingredient.findMany({ where: { id: { in: data.items.map(line => line.ingredientId) }, active: true } });
    if (ingredients.length !== data.items.length) throw new AppError(400, 'INVALID_INGREDIENT', 'Every counted ingredient must exist and be active.');
    const row = await transaction.stockCount.create({ data: { createdById: req.user!.id, notes: data.notes, items: { create: data.items.map(line => { const ingredient = ingredients.find(item => item.id === line.ingredientId)!; return { ingredientId: ingredient.id, expectedQuantity: ingredient.onHand, countedQuantity: quantity(line.quantity, line.unit, ingredient.unit) }; }) } }, include: { items: { include: { ingredient: true } } } });
    await audit(transaction, req.user!.id, 'inventory.count_submitted', 'StockCount', row.id, data);
    await notify(transaction, 'APPROVAL_REQUIRED', 'Stock count awaiting approval', 'A physical stock count requires manager approval.', ['OWNER', 'MANAGER']);
    return row;
  }));
  publish('inventory:changed', { countId: result.id }, [...readers]);
  res.status(201).json({ data: result });
});

inventoryRouter.post('/inventory/counts/:id/approve', requireRoles('OWNER', 'MANAGER'), async (req, res) => {
  emptyInput.parse(req.body ?? {});
  const key = requestKey(req);
  const id = String(req.params.id);
  const result = await tx(transaction => idempotent(transaction, req.user!.id, 'inventory.count.approve', key, { id }, () => approveStockCount(transaction, req.user!.id, id)));
  publish('inventory:changed', { countId: id });
  res.json({ data: result });
});

inventoryRouter.post('/inventory/counts/:id/reject', requireRoles('OWNER', 'MANAGER'), async (req, res) => {
  const data = reasonInput.parse(req.body);
  const key = requestKey(req);
  const id = String(req.params.id);
  const result = await tx(transaction => idempotent(transaction, req.user!.id, 'inventory.count.reject', key, { id, ...data }, async () => {
    const count = await transaction.stockCount.findUnique({ where: { id } });
    if (!count) throw new AppError(404, 'NOT_FOUND', 'Stock count not found.');
    if (count.status !== 'PENDING') throw new AppError(409, 'ALREADY_REVIEWED', 'This count has already been reviewed.');
    const row = await transaction.stockCount.update({ where: { id }, data: { status: 'REJECTED', approvedById: req.user!.id, approvedAt: new Date() } });
    await audit(transaction, req.user!.id, 'inventory.count_rejected', 'StockCount', id, data);
    return row;
  }));
  publish('inventory:changed', { countId: id }, [...readers]);
  res.json({ data: result });
});

inventoryRouter.get('/inventory/adjustments', requireRoles(...readers), async (req, res) => {
  const page = pagination(req);
  const where = { ...(req.query.status !== undefined ? { status: approvalStates.parse(req.query.status) } : {}), ...(typeof req.query.ingredientId === 'string' ? { ingredientId: req.query.ingredientId } : {}) };
  const [rows, total] = await Promise.all([prisma.stockAdjustment.findMany({ where, include: { ingredient: true, createdBy: { select: { id: true, name: true } }, approvedBy: { select: { id: true, name: true } } }, orderBy: { createdAt: 'desc' }, skip: page.skip, take: page.take }), prisma.stockAdjustment.count({ where })]);
  res.json({ data: rows, pagination: { page: page.page, pageSize: page.pageSize, total } });
});

inventoryRouter.post('/inventory/adjustments', requireRoles(...readers), async (req, res) => {
  const data = adjustmentInput.parse(req.body);
  const key = requestKey(req);
  const result = await tx(transaction => idempotent(transaction, req.user!.id, 'inventory.adjustment.create', key, data, async () => {
    const ingredient = await transaction.ingredient.findUnique({ where: { id: data.ingredientId, active: true } });
    if (!ingredient) throw new AppError(400, 'INVALID_INGREDIENT', 'Ingredient must exist and be active.');
    const row = await transaction.stockAdjustment.create({ data: { ingredientId: ingredient.id, quantity: quantity(data.quantity, data.unit, ingredient.unit), reason: data.reason, createdById: req.user!.id }, include: { ingredient: true } });
    await audit(transaction, req.user!.id, 'inventory.adjustment_submitted', 'StockAdjustment', row.id, data);
    await notify(transaction, 'APPROVAL_REQUIRED', 'Stock adjustment awaiting approval', `${ingredient.name} has a stock adjustment requiring manager approval.`, ['OWNER', 'MANAGER']);
    return row;
  }));
  publish('inventory:changed', { adjustmentId: result.id }, [...readers]);
  res.status(201).json({ data: result });
});

inventoryRouter.post('/inventory/adjustments/:id/approve', requireRoles('OWNER', 'MANAGER'), async (req, res) => {
  emptyInput.parse(req.body ?? {});
  const key = requestKey(req);
  const id = String(req.params.id);
  const result = await tx(transaction => idempotent(transaction, req.user!.id, 'inventory.adjustment.approve', key, { id }, () => approveStockAdjustment(transaction, req.user!.id, id)));
  publish('inventory:changed', { adjustmentId: id });
  res.json({ data: result });
});

inventoryRouter.post('/inventory/adjustments/:id/reject', requireRoles('OWNER', 'MANAGER'), async (req, res) => {
  const data = reasonInput.parse(req.body);
  const key = requestKey(req);
  const id = String(req.params.id);
  const result = await tx(transaction => idempotent(transaction, req.user!.id, 'inventory.adjustment.reject', key, { id, ...data }, async () => {
    const adjustment = await transaction.stockAdjustment.findUnique({ where: { id } });
    if (!adjustment) throw new AppError(404, 'NOT_FOUND', 'Stock adjustment not found.');
    if (adjustment.status !== 'PENDING') throw new AppError(409, 'ALREADY_REVIEWED', 'This adjustment has already been reviewed.');
    const row = await transaction.stockAdjustment.update({ where: { id }, data: { status: 'REJECTED', approvedById: req.user!.id, approvedAt: new Date() } });
    await audit(transaction, req.user!.id, 'inventory.adjustment_rejected', 'StockAdjustment', id, data);
    return row;
  }));
  publish('inventory:changed', { adjustmentId: id }, [...readers]);
  res.json({ data: result });
});

inventoryRouter.post('/inventory/movements/:id/reverse', requireRoles('OWNER'), async (req, res) => {
  const data = reasonInput.parse(req.body);
  const key = requestKey(req);
  const id = String(req.params.id);
  const result = await tx(transaction => idempotent(transaction, req.user!.id, 'inventory.movement.reverse', key, { id, ...data }, () => reverseStockMovement(transaction, req.user!.id, id, data.reason)));
  publish('inventory:changed', { movementId: result.id });
  res.status(201).json({ data: result });
});
