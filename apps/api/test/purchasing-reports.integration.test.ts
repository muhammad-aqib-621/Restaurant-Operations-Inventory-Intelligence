import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Role } from '@prisma/client';
import { AppError, Decimal, prisma, tx } from '../src/lib/core.js';
import { purchasingRouter } from '../src/routes/purchasing.js';
import { reportsRouter } from '../src/routes/reports.js';
import { businessDateRange, reportCsv } from '../src/lib/reporting.js';

const prefix = `purchasing-${randomUUID()}`;
const users = new Map<string, { id: string; name: string; email: string; role: Role; active: boolean }>();
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = users.get(req.get('x-test-role') ?? 'MANAGER'); next(); });
app.use('/api', purchasingRouter, reportsRouter);
const errors: ErrorRequestHandler = (error, _req, res, _next) => {
  const status = error instanceof AppError ? error.status : error instanceof z.ZodError ? 400 : 500;
  res.status(status).json({ error: { code: error instanceof AppError ? error.code : 'VALIDATION_OR_INTERNAL', message: error.message } });
};
app.use(errors);
const command = (path: string, body: object, role = 'MANAGER', key = randomUUID()) => request(app).post(`/api${path}`).set('x-test-role', role).set('Idempotency-Key', key).send(body);
let supplierId: string, ingredientId: string;

beforeAll(async () => {
  for (const role of ['MANAGER', 'INVENTORY', 'CASHIER'] as Role[]) {
    const user = await prisma.user.create({ data: { name: `${prefix} ${role}`, email: `${prefix}-${role.toLowerCase()}@example.test`, passwordHash: 'unusable-test-fixture-hash', role } });
    users.set(role, user);
  }
  const supplier = await prisma.supplier.create({ data: { name: `${prefix} supplier` } }); supplierId = supplier.id;
  const ingredient = await tx(async t => {
    const row = await t.ingredient.create({ data: { name: `${prefix} flour`, sku: prefix, category: 'Test', unit: 'G', onHand: '100', unitCost: '2', minimumStock: '20' } });
    await t.inventoryMovement.create({ data: { ingredientId: row.id, type: 'OPENING', quantity: '100', unitCost: '2', reason: 'Integration fixture opening balance', actorId: users.get('MANAGER')!.id } });
    return row;
  });
  ingredientId = ingredient.id;
}, 20000);
afterAll(async () => { await prisma.$disconnect(); });

async function purchase(amount = '2') {
  const created = await command('/purchases', { supplierId, items: [{ ingredientId, quantity: amount, unit: 'KG', unitCost: '1000' }] }).expect(201);
  await command(`/purchases/${created.body.data.id}/status`, { status: 'ORDERED' }).expect(200);
  return created.body.data as { id: string; items: { id: string; unitCost: string; quantity: string }[] };
}

describe('transactional purchases and waste against PostgreSQL', () => {
  it('normalizes quoted units, receives actual quantities/costs, and prevents duplicate and excess deliveries', async () => {
    const po = await purchase();
    expect(po.items[0]!.quantity).toBe('2000'); expect(po.items[0]!.unitCost).toBe('1');
    const body = { invoiceReference: `${prefix}-invoice`, items: [{ purchaseOrderItemId: po.items[0]!.id, quantity: '0.5', unit: 'KG', unitCost: '3000' }] };
    const key = randomUUID();
    const received = await command(`/purchases/${po.id}/receipts`, body, 'INVENTORY', key).expect(201);
    expect(received.body.data.items[0].quantity).toBe('500'); expect(received.body.data.items[0].unitCost).toBe('3');
    const stock = await prisma.ingredient.findUniqueOrThrow({ where: { id: ingredientId } });
    expect(stock.onHand.toString()).toBe('600'); expect(stock.unitCost.toString()).toBe('2.833333');
    const duplicate = await command(`/purchases/${po.id}/receipts`, body, 'INVENTORY', key).expect(201);
    expect(duplicate.body.data.id).toBe(received.body.data.id);
    expect(await prisma.goodsReceipt.count({ where: { purchaseOrderId: po.id } })).toBe(1);
    await command(`/purchases/${po.id}/receipts`, { ...body, invoiceReference: `${prefix}-changed` }, 'INVENTORY', key).expect(409);
    await command(`/purchases/${po.id}/receipts`, body, 'INVENTORY').expect(409);
    await command(`/purchases/${po.id}/receipts`, { items: [{ ...body.items[0], quantity: '2' }] }, 'INVENTORY').expect(409);
    expect((await prisma.ingredient.findUniqueOrThrow({ where: { id: ingredientId } })).onHand.toString()).toBe('600');
    const remainder = await command(`/purchases/${po.id}/receipts`, { items: [{ purchaseOrderItemId: po.items[0]!.id, quantity: '1.5', unit: 'KG', unitCost: '1000' }] }, 'INVENTORY').expect(201);
    expect(remainder.body.data.purchaseOrder.status).toBe('RECEIVED');
    expect((await prisma.ingredient.findUniqueOrThrow({ where: { id: ingredientId } })).unitCost.toString()).toBe('1.523809');
  });

  it('rolls back every receipt line if any line fails and rejects incompatible units', async () => {
    const po = await purchase('1');
    const before = await prisma.ingredient.findUniqueOrThrow({ where: { id: ingredientId } });
    await command(`/purchases/${po.id}/receipts`, { items: [{ purchaseOrderItemId: po.items[0]!.id, quantity: '100', unit: 'G', unitCost: '1' }, { purchaseOrderItemId: 'zz-invalid-line', quantity: '1', unit: 'G', unitCost: '1' }] }, 'INVENTORY').expect(400);
    expect(await prisma.goodsReceipt.count({ where: { purchaseOrderId: po.id } })).toBe(0);
    expect((await prisma.ingredient.findUniqueOrThrow({ where: { id: ingredientId } })).onHand.eq(before.onHand)).toBe(true);
    await command(`/purchases/${po.id}/receipts`, { items: [{ purchaseOrderItemId: po.items[0]!.id, quantity: '1', unit: 'L', unitCost: '1' }] }, 'INVENTORY').expect(400);
    await command(`/purchases/${po.id}/receipts`, { items: [{ purchaseOrderItemId: po.items[0]!.id, quantity: '1', unit: 'KG', unitCost: '0.000001' }] }, 'INVENTORY').expect(400);
  });

  it('serializes competing receipts so the combined amount cannot exceed ordered stock', async () => {
    const po = await purchase('1');
    const responses = await Promise.all([1, 2].map(index => command(`/purchases/${po.id}/receipts`, { invoiceReference: `${prefix}-race-${index}`, items: [{ purchaseOrderItemId: po.items[0]!.id, quantity: '0.8', unit: 'KG', unitCost: '1000' }] }, 'INVENTORY')));
    expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
    expect((await prisma.purchaseOrderItem.findUniqueOrThrow({ where: { id: po.items[0]!.id } })).receivedQuantity.toString()).toBe('800');
  }, 15000);

  it('retains received stock when the outstanding remainder is cancelled', async () => {
    const po = await purchase('1');
    await command(`/purchases/${po.id}/receipts`, { items: [{ purchaseOrderItemId: po.items[0]!.id, quantity: '100', unit: 'G', unitCost: '1' }] }, 'INVENTORY').expect(201);
    const before = await prisma.ingredient.findUniqueOrThrow({ where: { id: ingredientId } });
    await command(`/purchases/${po.id}/status`, { status: 'CANCELLED' }).expect(200);
    expect((await prisma.ingredient.findUniqueOrThrow({ where: { id: ingredientId } })).onHand.eq(before.onHand)).toBe(true);
    await command(`/purchases/${po.id}/receipts`, { items: [{ purchaseOrderItemId: po.items[0]!.id, quantity: '1', unit: 'G', unitCost: '1' }] }, 'INVENTORY').expect(409);
  });

  it('leaves pending waste undeducted, authorizes approval, and consumes stock only once', async () => {
    const before = await prisma.ingredient.findUniqueOrThrow({ where: { id: ingredientId } });
    const submitted = await command('/waste', { ingredientId, quantity: '10', unit: 'G', reason: 'Spoilage during test' }, 'INVENTORY').expect(201);
    const wasteId = submitted.body.data.id;
    expect(submitted.body.data.status).toBe('PENDING');
    expect((await prisma.ingredient.findUniqueOrThrow({ where: { id: ingredientId } })).onHand.eq(before.onHand)).toBe(true);
    await command(`/waste/${wasteId}/approve`, {}, 'INVENTORY').expect(403);
    const key = randomUUID();
    const approved = await command(`/waste/${wasteId}/approve`, {}, 'MANAGER', key).expect(200);
    expect(approved.body.data.estimatedCost).toBe(new Decimal(10).mul(before.unitCost).toDecimalPlaces(2).toString());
    await command(`/waste/${wasteId}/approve`, {}, 'MANAGER', key).expect(200);
    await command(`/waste/${wasteId}/approve`, {}, 'MANAGER').expect(409);
    expect((await prisma.ingredient.findUniqueOrThrow({ where: { id: ingredientId } })).onHand.eq(before.onHand.minus(10))).toBe(true);
    expect(await prisma.inventoryMovement.count({ where: { type: 'WASTE', reference: wasteId } })).toBe(1);
    await command('/waste', { ingredientId, quantity: before.onHand.plus(1).toString(), unit: 'G', reason: 'Cannot overdraw stock' }, 'INVENTORY').expect(409);
    await command('/waste', { ingredientId, quantity: '1', unit: 'G', reason: 'Unauthorized record' }, 'CASHIER').expect(403);
  });
});

describe('accurate financial reporting and exports', () => {
  beforeAll(async () => {
    const actorId = users.get('MANAGER')!.id;
    const category = await prisma.menuCategory.create({ data: { name: `${prefix} menu` } });
    const menuItem = await prisma.menuItem.create({ data: { name: '=Unsafe spreadsheet name', categoryId: category.id, price: '900' } });
    const recipe = await prisma.recipe.create({ data: { menuItemId: menuItem.id, versions: { create: { version: 1, createdById: actorId } } }, include: { versions: true } });
    const order = await prisma.order.create({ data: { status: 'COMPLETED', subtotal: '200', discount: '20', tax: '18', total: '198', estimatedCost: '80', createdById: actorId, createdAt: new Date('2040-01-01T00:00:00Z'), items: { create: { menuItemId: menuItem.id, recipeVersionId: recipe.versions[0]!.id, name: '=Unsafe spreadsheet name', quantity: 2, unitPrice: '100', estimatedUnitCost: '40' } } } });
    await prisma.payment.createMany({ data: [
      { orderId: order.id, amount: '198', method: 'CASH', createdById: actorId, createdAt: new Date('2040-05-10T19:00:00Z') },
      { orderId: order.id, type: 'REFUND', amount: '49.50', method: 'CASH', createdById: actorId, createdAt: new Date('2040-05-11T18:59:59.999Z') },
      // Next business day: must be excluded despite sharing the same UTC date.
      { orderId: order.id, type: 'REFUND', amount: '49.50', method: 'CASH', createdById: actorId, createdAt: new Date('2040-05-11T19:00:00Z') },
    ] });
    await prisma.order.create({ data: { subtotal: '9999', total: '9999', estimatedCost: '3000', createdById: actorId, createdAt: new Date('2040-05-11T01:00:00Z') } });
    await tx(async t => {
      await t.ingredient.update({ where: { id: ingredientId }, data: { onHand: { decrement: '7' } } });
      await t.inventoryMovement.createMany({ data: [
        { ingredientId, type: 'CONSUMPTION', quantity: '-5', unitCost: '2', reason: 'Historical prepared order fixture', actorId, orderId: order.id, createdAt: new Date('2040-05-11T00:00:00Z') },
        { ingredientId, type: 'WASTE', quantity: '-2', unitCost: '2', reason: 'Historical approved spoilage fixture', actorId, createdAt: new Date('2040-05-11T00:00:00Z') },
      ] });
      await t.wasteRecord.create({ data: { ingredientId, quantity: '2', estimatedCost: '4', reason: 'Historical approved spoilage fixture', status: 'APPROVED', createdById: actorId, approvedById: actorId, approvedAt: new Date('2040-05-11T00:00:00Z'), createdAt: new Date('2040-05-11T00:00:00Z') } });
    });
    const splitOrder = await prisma.order.create({ data: { subtotal: '100.01', tax: '16', total: '116.01', estimatedCost: '31', createdById: actorId, items: { create: { menuItemId: menuItem.id, recipeVersionId: recipe.versions[0]!.id, name: 'Split payment rounding fixture', quantity: 1, unitPrice: '100.01', estimatedUnitCost: '31' } } } });
    await prisma.payment.createMany({ data: [1, 2, 3].map(second => ({ orderId: splitOrder.id, amount: '38.67', method: 'CASH', createdById: actorId, createdAt: new Date(`2040-06-02T00:00:0${second}Z`) })) });
    // Current menu prices deliberately differ from the historical order snapshots.
    await prisma.menuItem.update({ where: { id: menuItem.id }, data: { price: '999' } });
  });

  it('uses business payment dates, discounts, tax, refunds and historical costs; excludes unpaid orders', async () => {
    const response = await request(app).get('/api/reports/dashboard?from=2040-05-11&to=2040-05-11').expect(200);
    expect(response.body.data).toMatchObject({ sales: '135.00', tax: '13.50', collected: '198.00', refunds: '49.50', estimatedCogs: '60.00', grossProfit: '75.00', orderCount: 1, averageOrderValue: '135.00', wasteCost: '4.00' });
    expect(response.body.data.bestSellers[0]).toMatchObject({ name: '=Unsafe spreadsheet name', quantity: '1.5', sales: '135.00' });
    expect(response.body.data.recentOrders).toHaveLength(1);
    const report = await request(app).get('/api/reports/sales?from=2040-05-11&to=2040-05-11').expect(200);
    expect(report.body.data.rows[0]).toMatchObject({ date: '2040-05-11', sales: '135.00', grossProfit: '75.00' });
    const monthly = await request(app).get('/api/reports/sales?from=2040-05-01&to=2040-05-31&granularity=month').expect(200);
    expect(monthly.body.data.rows[0]).toMatchObject({ date: '2040-05', sales: '90.00', refunds: '99.00' });
  });

  it('allocates split-payment rounding cumulatively so recognized revenue, tax and cost reconcile exactly', async () => {
    const response = await request(app).get('/api/reports/dashboard?from=2040-06-02&to=2040-06-02').expect(200);
    expect(response.body.data).toMatchObject({ sales: '100.01', tax: '16.00', estimatedCogs: '31.00', collected: '116.01', grossProfit: '69.01' });
  });

  it('exports all matching rows with formula protection, paginates JSON, and restricts financial reports', async () => {
    const response = await request(app).get('/api/reports/items?from=2040-05-11&to=2040-05-11&format=csv').expect(200);
    expect(response.type).toBe('text/csv'); expect(response.text).toContain("\"'=Unsafe spreadsheet name\""); expect(response.text).toContain('"135.00"');
    const paged = await request(app).get('/api/reports/hourly?from=2040-05-11&to=2040-05-11&page=2&pageSize=5').expect(200);
    expect(paged.body.data.rows).toHaveLength(5); expect(paged.body.pagination.total).toBe(24);
    await request(app).get('/api/reports/dashboard').set('x-test-role', 'INVENTORY').expect(403);
    await request(app).get('/api/reports/sales?from=2040-02-30&to=2040-03-01').expect(400);
  });

  it('reconciles consumption and approved waste to immutable ledger costs and returns genuine current valuation', async () => {
    const consumed = await request(app).get('/api/reports/consumption?from=2040-05-11&to=2040-05-11').expect(200);
    expect(consumed.body.data.rows).toContainEqual(expect.objectContaining({ ingredientId, quantity: '5', cost: '10.00' }));
    expect(consumed.body.data.summary.consumptionCost).toBe('10.00');
    const waste = await request(app).get('/api/reports/waste?from=2040-05-11&to=2040-05-11').expect(200);
    expect(waste.body.data.summary.approvedWasteCost).toBe('4.00');
    const valuation = await request(app).get('/api/reports/valuation?pageSize=100').expect(200);
    const stock = await prisma.ingredient.findUniqueOrThrow({ where: { id: ingredientId } });
    expect(valuation.body.data.rows).toContainEqual(expect.objectContaining({ ingredientId, onHand: stock.onHand.toString(), value: stock.onHand.mul(stock.unitCost).toFixed(2) }));
    for (const type of ['movements', 'purchases', 'reorder']) {
      const report = await request(app).get(`/api/reports/${type}?pageSize=100`).expect(200);
      expect(report.body.data.rows.length).toBeGreaterThan(0);
      expect(report.body.data.definitions.length).toBeGreaterThan(0);
    }
  });

  it('uses inclusive Asia/Karachi business dates and protects every CSV formula entrypoint', () => {
    const range = businessDateRange({ from: '2040-05-11', to: '2040-05-11' }, 'Asia/Karachi');
    expect(range.start.toISOString()).toBe('2040-05-10T19:00:00.000Z'); expect(range.end.toISOString()).toBe('2040-05-11T19:00:00.000Z');
    const csv = reportCsv(['name'], [{ name: '@SUM(1)' }, { name: '  +cmd' }, { name: '\t=1' }, { name: 'a,"b"' }]);
    expect(csv).toContain("\"'@SUM(1)\""); expect(csv).toContain("\"'  +cmd\""); expect(csv).toContain('"a,""b"""');
  });
});
