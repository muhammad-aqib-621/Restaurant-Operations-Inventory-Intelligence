import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import request from 'supertest';
import { ZodError } from 'zod';
import type { Role } from '@prisma/client';
import { beforeAll, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { AppError, Decimal, prisma, quantity, tx } from '../src/lib/core.js';
import { approveStockAdjustment, approveStockCount, reverseStockMovement } from '../src/lib/inventory.js';
import { catalogRouter } from '../src/routes/catalog.js';
import { inventoryRouter } from '../src/routes/inventory.js';

let actorId: string;
beforeAll(async () => {
  const user = await prisma.user.create({ data: { name: 'Inventory integration actor', email: `inventory-${randomUUID()}@test.invalid`, passwordHash: 'not-a-login-hash', role: 'OWNER' } });
  actorId = user.id;
});

async function ingredient(initial = '20') {
  return tx(async transaction => {
    const row = await transaction.ingredient.create({ data: { name: 'Integration flour', sku: `TEST-${randomUUID()}`, category: 'Test', unit: 'G', unitCost: '0.5', onHand: initial } });
    await transaction.inventoryMovement.create({ data: { ingredientId: row.id, type: 'OPENING', quantity: initial, unitCost: '0.5', reason: 'Isolated integration fixture', actorId } });
    return row;
  });
}
async function adjustment(ingredientId: string, amount: string) {
  return prisma.stockAdjustment.create({ data: { ingredientId, quantity: amount, reason: 'Integration variance', createdById: actorId } });
}
async function reserve(ingredientId: string, amount: string) {
  return tx(async transaction => {
    const order = await transaction.order.create({ data: { createdById: actorId } });
    await transaction.inventoryReservation.create({ data: { ingredientId, orderId: order.id, quantity: amount } });
    await transaction.ingredient.update({ where: { id: ingredientId }, data: { reserved: amount } });
    return order;
  });
}

// Feature harness isolates router RBAC/validation; session and CSRF are covered by auth integration tests.
function featureApp(role: Role = 'OWNER') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: actorId, name: 'Test actor', email: 'test@test.invalid', active: true, role }; next(); });
  app.use(catalogRouter, inventoryRouter);
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    res.status(error instanceof AppError ? error.status : error instanceof ZodError ? 400 : 500).json({ error: { code: error instanceof AppError ? error.code : error instanceof ZodError ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR' } });
  };
  app.use(errors);
  return app;
}

// These tests run in the disposable integration database. History intentionally remains immutable.
describe('catalog units and transactionally reconciled inventory', () => {
  it('converts compatible units precisely and rejects incompatible dimensions', () => {
    expect(quantity('1.125', 'KG', 'G').toString()).toBe('1125');
    expect(quantity('0.25', 'L', 'ML').toString()).toBe('250');
    expect(quantity('3', 'PIECE', 'PIECE').toString()).toBe('3');
    expect(() => quantity('1', 'KG', 'ML')).toThrow();
  });

  it('keeps a submitted adjustment pending and posts exactly one audited movement on approval', async () => {
    const stock = await ingredient();
    const pending = await adjustment(stock.id, '-3.25');
    expect((await prisma.ingredient.findUniqueOrThrow({ where: { id: stock.id } })).onHand.toString()).toBe('20');
    expect(await prisma.inventoryMovement.count({ where: { reference: pending.id } })).toBe(0);
    const approved = await tx(transaction => approveStockAdjustment(transaction, actorId, pending.id));
    expect(approved.status).toBe('APPROVED');
    expect(approved.ingredient.onHand.toString()).toBe('16.75');
    const movements = await prisma.inventoryMovement.findMany({ where: { reference: pending.id } });
    expect(movements).toHaveLength(1);
    expect(movements[0].quantity.toString()).toBe('-3.25');
    expect(await prisma.auditLog.count({ where: { entityId: pending.id, action: 'inventory.adjustment_approved' } })).toBe(1);
    await expect(tx(transaction => approveStockAdjustment(transaction, actorId, pending.id))).rejects.toMatchObject({ code: 'ALREADY_REVIEWED' });
  });

  it('refuses to consume stock reserved for an order and rolls back every approval change', async () => {
    const stock = await ingredient();
    await reserve(stock.id, '10');
    const pending = await adjustment(stock.id, '-11');
    await expect(tx(transaction => approveStockAdjustment(transaction, actorId, pending.id))).rejects.toMatchObject({ code: 'INSUFFICIENT_AVAILABLE_STOCK' });
    expect((await prisma.ingredient.findUniqueOrThrow({ where: { id: stock.id } })).onHand.toString()).toBe('20');
    expect((await prisma.stockAdjustment.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('PENDING');
    expect(await prisma.inventoryMovement.count({ where: { reference: pending.id } })).toBe(0);
  });

  it('rejects a stale count after an intervening approved stock movement', async () => {
    const stock = await ingredient();
    const count = await prisma.stockCount.create({ data: { createdById: actorId, items: { create: { ingredientId: stock.id, expectedQuantity: '20', countedQuantity: '15' } } } });
    const later = await adjustment(stock.id, '-1');
    await tx(transaction => approveStockAdjustment(transaction, actorId, later.id));
    await expect(tx(transaction => approveStockCount(transaction, actorId, count.id))).rejects.toMatchObject({ code: 'STALE_STOCK_COUNT' });
    expect((await prisma.ingredient.findUniqueOrThrow({ where: { id: stock.id } })).onHand.toString()).toBe('19');
    expect((await prisma.stockCount.findUniqueOrThrow({ where: { id: count.id } })).status).toBe('PENDING');
    expect(await prisma.inventoryMovement.count({ where: { reference: count.id } })).toBe(0);
  });

  it('posts the count variance rather than the counted balance as a ledger movement', async () => {
    const stock = await ingredient();
    const count = await prisma.stockCount.create({ data: { notes: 'Physical recount', createdById: actorId, items: { create: { ingredientId: stock.id, expectedQuantity: '20', countedQuantity: '18.5' } } } });
    const approved = await tx(transaction => approveStockCount(transaction, actorId, count.id));
    expect(approved.status).toBe('APPROVED');
    const movement = await prisma.inventoryMovement.findFirstOrThrow({ where: { reference: count.id } });
    expect(movement.type).toBe('COUNT');
    expect(movement.quantity.toString()).toBe('-1.5');
    expect((await prisma.ingredient.findUniqueOrThrow({ where: { id: stock.id } })).onHand.toString()).toBe('18.5');
  });

  it('rejects a count below reserved stock without changing the snapshot or balance', async () => {
    const stock = await ingredient();
    await reserve(stock.id, '10');
    const count = await prisma.stockCount.create({ data: { createdById: actorId, items: { create: { ingredientId: stock.id, expectedQuantity: '20', countedQuantity: '7' } } } });
    await expect(tx(transaction => approveStockCount(transaction, actorId, count.id))).rejects.toMatchObject({ code: 'INSUFFICIENT_AVAILABLE_STOCK' });
    expect((await prisma.ingredient.findUniqueOrThrow({ where: { id: stock.id } })).onHand.toString()).toBe('20');
    expect(await prisma.inventoryMovement.count({ where: { reference: count.id } })).toBe(0);
  });

  it('reverses a manual movement once by appending a compensation and retaining the original', async () => {
    const stock = await ingredient();
    const pending = await adjustment(stock.id, '-4');
    await tx(transaction => approveStockAdjustment(transaction, actorId, pending.id));
    const original = await prisma.inventoryMovement.findFirstOrThrow({ where: { reference: pending.id } });
    const reversal = await tx(transaction => reverseStockMovement(transaction, actorId, original.id, 'Correction after recount'));
    expect(reversal.type).toBe('REVERSAL');
    expect(reversal.quantity.toString()).toBe('4');
    expect(reversal.reversalOfId).toBe(original.id);
    expect((await prisma.ingredient.findUniqueOrThrow({ where: { id: stock.id } })).onHand.toString()).toBe('20');
    expect((await prisma.inventoryMovement.findUniqueOrThrow({ where: { id: original.id } })).quantity.toString()).toBe('-4');
    await expect(tx(transaction => reverseStockMovement(transaction, actorId, original.id, 'Duplicate attempt'))).rejects.toMatchObject({ code: 'ALREADY_REVERSED' });
    const opening = await prisma.inventoryMovement.findFirstOrThrow({ where: { ingredientId: stock.id, type: 'OPENING' } });
    await expect(tx(transaction => reverseStockMovement(transaction, actorId, opening.id, 'Invalid reversal'))).rejects.toMatchObject({ code: 'REVERSAL_NOT_ALLOWED' });
  });

  it('prevents direct balance edits and denies cashier stock commands at the router boundary', async () => {
    const stock = await ingredient();
    await request(featureApp()).patch(`/ingredients/${stock.id}`).send({ onHand: '999', reserved: '0' }).expect(400);
    await request(featureApp('CASHIER')).post('/inventory/adjustments').set('Idempotency-Key', randomUUID()).send({ ingredientId: stock.id, quantity: '-1', unit: 'G', reason: 'Unauthorized variance' }).expect(403);
    expect((await prisma.ingredient.findUniqueOrThrow({ where: { id: stock.id } })).onHand.toString()).toBe('20');
  });

  it('preserves prior recipe versions and stores explicit conversions in canonical units', async () => {
    const stock = await ingredient();
    const category = await prisma.menuCategory.create({ data: { name: `Recipe test ${randomUUID()}` } });
    const item = await prisma.menuItem.create({ data: { categoryId: category.id, name: 'Recipe test dish', price: '100' } });
    const app = featureApp();
    const first = await request(app).post(`/menu/${item.id}/recipes`).send({ ingredients: [{ ingredientId: stock.id, quantity: '0.01', unit: 'KG' }] }).expect(201);
    const second = await request(app).post(`/menu/${item.id}/recipes`).send({ ingredients: [{ ingredientId: stock.id, quantity: '12', unit: 'G' }] }).expect(201);
    expect(first.body.data.version).toBe(1);
    expect(first.body.data.ingredients[0].quantity).toBe('10');
    expect(second.body.data.version).toBe(2);
    const old = await prisma.recipeVersion.findUniqueOrThrow({ where: { id: first.body.data.id }, include: { ingredients: true } });
    expect(old.ingredients[0].quantity.toString()).toBe('10');
    const detail = await request(app).get(`/menu/${item.id}`).expect(200);
    expect(detail.body.data.estimatedCost).toBe('6.00');
    expect(detail.body.data.availablePortions).toBe(1);
    const cashierView = await request(featureApp('CASHIER')).get(`/menu/${item.id}`).expect(200);
    expect(cashierView.body.data.estimatedCost).toBeUndefined();
    expect(cashierView.body.data.margin).toBeUndefined();
    expect(cashierView.body.data.recipe.versions[0].ingredients[0].ingredient.unitCost).toBeUndefined();
    expect(cashierView.body.data.recipe.versions[0].ingredients[0].ingredient.onHand).toBeUndefined();
    expect(cashierView.body.data.price).toBe('100');
    const kitchenHistory = await request(featureApp('KITCHEN')).get(`/menu/${item.id}/recipes`).expect(200);
    expect(kitchenHistory.body.data[0].ingredients[0].ingredient.unitCost).toBeUndefined();
  });

  it('rejects duplicate recipe ingredients and incompatible units without creating versions', async () => {
    const stock = await ingredient();
    const category = await prisma.menuCategory.create({ data: { name: `Invalid recipe ${randomUUID()}` } });
    const item = await prisma.menuItem.create({ data: { categoryId: category.id, name: 'Invalid recipe dish', price: '100' } });
    const app = featureApp();
    const duplicate = { ingredientId: stock.id, quantity: '1', unit: 'G' };
    await request(app).post(`/menu/${item.id}/recipes`).send({ ingredients: [duplicate, duplicate] }).expect(400);
    await request(app).post(`/menu/${item.id}/recipes`).send({ ingredients: [{ ingredientId: stock.id, quantity: '1', unit: 'L' }] }).expect(400);
    expect(await prisma.recipe.count({ where: { menuItemId: item.id } })).toBe(0);
  });

  it('deduplicates submitted stock requests and rejects key reuse with a different quantity', async () => {
    const stock = await ingredient();
    const app = featureApp('INVENTORY');
    const key = randomUUID();
    const payload = { ingredientId: stock.id, quantity: '2', unit: 'G', reason: 'Observed discrepancy' };
    const first = await request(app).post('/inventory/adjustments').set('Idempotency-Key', key).send(payload).expect(201);
    const replay = await request(app).post('/inventory/adjustments').set('Idempotency-Key', key).send(payload).expect(201);
    expect(replay.body.data.id).toBe(first.body.data.id);
    await request(app).post('/inventory/adjustments').set('Idempotency-Key', key).send({ ...payload, quantity: '3' }).expect(409);
    expect(await prisma.stockAdjustment.count({ where: { ingredientId: stock.id } })).toBe(1);
    expect((await prisma.ingredient.findUniqueOrThrow({ where: { id: stock.id } })).onHand.toString()).toBe('20');
  });

  it('enforces immutable history and reconciled balances at the database boundary', async () => {
    const stock = await ingredient();
    const opening = await prisma.inventoryMovement.findFirstOrThrow({ where: { ingredientId: stock.id, type: 'OPENING' } });
    await expect(prisma.inventoryMovement.update({ where: { id: opening.id }, data: { reason: 'Illegal history edit' } })).rejects.toThrow();
    await expect(prisma.inventoryMovement.delete({ where: { id: opening.id } })).rejects.toThrow();
    await expect(prisma.$transaction(async transaction => {
      await transaction.ingredient.update({ where: { id: stock.id }, data: { onHand: new Decimal('999') } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })).rejects.toThrow();
    expect((await prisma.ingredient.findUniqueOrThrow({ where: { id: stock.id } })).onHand.toString()).toBe('20');
  });
});
