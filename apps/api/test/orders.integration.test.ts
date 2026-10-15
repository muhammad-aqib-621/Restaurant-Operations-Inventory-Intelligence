import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import request from 'supertest';
import { ordersRouter } from '../src/routes/orders.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, Decimal, tx } from '../src/lib/core.js';
import { createOrder, changeOrderStatus, markOrderItemReady, recordPayment, refundPayment, orderReceipt } from '../src/lib/order-service.js';

const key = () => randomUUID();
let owner: { id: string; role: 'OWNER' };
let cashier: { id: string; role: 'CASHIER' };
let kitchen: { id: string; role: 'KITCHEN' };
let inventory: { id: string; role: 'INVENTORY' };

// Each fixture has isolated stock and immutable history. Run these against a dedicated test database.
async function fixture(stock = '20', required = '2', price = '100') {
  const label = `order-test-${randomUUID()}`;
  return tx(async transaction => {
    const ingredient = await transaction.ingredient.create({ data: { name: label, sku: label, category: 'TEST', unit: 'PIECE', onHand: stock, unitCost: '5', minimumStock: '1' } });
    await transaction.inventoryMovement.create({ data: { ingredientId: ingredient.id, quantity: stock, unitCost: '5', type: 'OPENING', reason: 'Isolated automated test fixture', actorId: owner.id } });
    const category = await transaction.menuCategory.create({ data: { name: label } });
    const menu = await transaction.menuItem.create({ data: { name: label, categoryId: category.id, price, recipe: { create: { versions: { create: { version: 1, createdById: owner.id, ingredients: { create: { ingredientId: ingredient.id, quantity: required } } } } } } }, include: { recipe: { include: { versions: true } } } });
    return { ingredient, menu, version: menu.recipe!.versions[0] };
  });
}
const orderInput = (menuItemId: string, extra: Record<string, unknown> = {}) => ({ items: [{ menuItemId, quantity: 1 }], ...extra });
async function prepareOrder(menuItemId: string) {
  const order = await createOrder(owner, orderInput(menuItemId), key());
  await changeOrderStatus(kitchen, order.id, { status: 'PREPARING' }, key());
  return markOrderItemReady(kitchen, order.id, order.items[0].id, { quantity: 1 }, key());
}

beforeAll(async () => {
  for (const role of ['OWNER', 'CASHIER', 'KITCHEN', 'INVENTORY'] as const) {
    const user = await prisma.user.create({ data: { name: `Order integration ${role}`, email: `${randomUUID()}@orders-integration.test`, passwordHash: 'test-service-account-no-password-login', role } });
    const actor = { id: user.id, role };
    if (role === 'OWNER') owner = actor as typeof owner;
    if (role === 'CASHIER') cashier = actor as typeof cashier;
    if (role === 'KITCHEN') kitchen = actor as typeof kitchen;
    if (role === 'INVENTORY') inventory = actor as typeof inventory;
  }
}, 20000);
afterAll(async () => { await prisma.$disconnect(); });

function orderApp(actor?: { id: string; role: 'OWNER' | 'CASHIER' | 'KITCHEN' | 'INVENTORY' }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (actor) req.user = { ...actor, name: 'Integration actor', email: 'actor@integration.test', active: true }; next(); });
  app.use('/api', ordersRouter);
  const errors: ErrorRequestHandler = (error, _req, res, _next) => { res.status(error.status ?? 500).json({ error: { code: error.code, message: error.message } }); };
  app.use(errors);
  return app;
}

describe('transactional POS and kitchen business rules (real PostgreSQL)', () => {
  it('calculates prices, discount, tax, historical recipe and cost on the server', async () => {
    const { menu, ingredient, version } = await fixture();
    const settings = await prisma.restaurantSettings.findUniqueOrThrow({ where: { id: 'primary' } });
    const order = await createOrder(owner, { items: [{ menuItemId: menu.id, quantity: 2 }], discount: '5', customer: { name: 'Test customer', phone: '+92 555' } }, key());
    expect(new Decimal(order.subtotal).equals('200')).toBe(true);
    expect(new Decimal(order.tax).equals(new Decimal(195).mul(settings.taxRate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP))).toBe(true);
    expect(new Decimal(order.total).equals(new Decimal(195).plus(order.tax))).toBe(true);
    expect(new Decimal(order.estimatedCost).equals('20')).toBe(true);
    expect(order.items[0].recipeVersionId).toBe(version.id);
    expect(order.customer.name).toBe('Test customer');
    const stock = await prisma.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } });
    expect(stock.reserved.equals(4)).toBe(true);
    expect(stock.onHand.equals(20)).toBe(true);
    await expect(createOrder(owner, { ...orderInput(menu.id), total: '0.01' }, key())).rejects.toThrow();
  });

  it('enforces HTTP permissions and hides internal costs from cashier/kitchen and all printable receipts', async () => {
    const { menu } = await fixture();
    const order = await createOrder(owner, orderInput(menu.id), key());
    await request(orderApp()).get(`/api/orders/${order.id}`).expect(401);
    await request(orderApp(inventory)).get(`/api/orders/${order.id}`).expect(403);
    await request(orderApp(kitchen)).post('/api/orders').set('Idempotency-Key', key()).send(orderInput(menu.id)).expect(403);
    await request(orderApp(cashier)).post(`/api/orders/${order.id}/refunds`).set('Idempotency-Key', key()).send({ amount: '1', method: 'CASH', reason: 'Permission test' }).expect(403);
    const own = await request(orderApp(owner)).get(`/api/orders/${order.id}`).expect(200);
    expect(own.body.data.estimatedCost).toBeDefined();
    for (const actor of [cashier, kitchen]) {
      const detail = await request(orderApp(actor)).get(`/api/orders/${order.id}`).expect(200);
      expect(detail.body.data.estimatedCost).toBeUndefined();
      expect(detail.body.data.items[0].estimatedUnitCost).toBeUndefined();
      const list = await request(orderApp(actor)).get('/api/orders').expect(200);
      expect(JSON.stringify(list.body)).not.toContain('estimatedCost');
      expect(JSON.stringify(list.body)).not.toContain('estimatedUnitCost');
    }
    const posted = await request(orderApp(cashier)).post('/api/orders').set('Idempotency-Key', key()).send(orderInput(menu.id)).expect(201);
    expect(posted.body.data.estimatedCost).toBeUndefined();
    expect(posted.body.data.items[0].estimatedUnitCost).toBeUndefined();
    const cashierOrder = posted.body.data;
    const started = await request(orderApp(kitchen)).post(`/api/orders/${cashierOrder.id}/status`).set('Idempotency-Key', key()).send({ status: 'PREPARING' }).expect(200);
    expect(JSON.stringify(started.body)).not.toMatch(/estimatedCost|estimatedUnitCost/);
    const ready = await request(orderApp(kitchen)).post(`/api/orders/${cashierOrder.id}/items/${cashierOrder.items[0].id}/ready`).set('Idempotency-Key', key()).send({ quantity: 1 }).expect(200);
    expect(ready.body.data.status).toBe('READY');
    expect(JSON.stringify(ready.body)).not.toMatch(/estimatedCost|estimatedUnitCost/);
    const paid = await request(orderApp(cashier)).post(`/api/orders/${cashierOrder.id}/payments`).set('Idempotency-Key', key()).send({ amount: new Decimal(cashierOrder.total).toFixed(2), method: 'CASH' }).expect(201);
    expect(JSON.stringify(paid.body)).not.toMatch(/estimatedCost|estimatedUnitCost/);
    const completed = await request(orderApp(cashier)).post(`/api/orders/${cashierOrder.id}/status`).set('Idempotency-Key', key()).send({ status: 'COMPLETED' }).expect(200);
    expect(JSON.stringify(completed.body)).not.toMatch(/estimatedCost|estimatedUnitCost/);
    const receipt = await request(orderApp(owner)).get(`/api/orders/${order.id}/receipt`).expect(200);
    expect(JSON.stringify(receipt.body)).not.toMatch(/estimatedCost|estimatedUnitCost|createdById|recipeVersionId/);
    expect(receipt.body.data.items[0].lineTotal).toBe('100');
  });

  it('rejects numeric money inputs and out-of-range recipe costs before database writes', async () => {
    const { menu } = await fixture();
    await expect(createOrder(owner, orderInput(menu.id, { discount: 1 }), key())).rejects.toThrow();
    const expensive = await fixture('20', '999999999999');
    await expect(createOrder(owner, orderInput(expensive.menu.id, { confirm: false }), key())).rejects.toMatchObject({ code: 'MONEY_OUT_OF_RANGE' });
  });

  it('enforces cashier discounts and backend role permissions', async () => {
    const { menu } = await fixture();
    const settings = await prisma.restaurantSettings.findUniqueOrThrow({ where: { id: 'primary' } });
    const beyond = Decimal.min(new Decimal('100'), new Decimal('100').mul(settings.cashierDiscountLimit).plus('0.01')).toFixed(2);
    if (settings.cashierDiscountLimit.lt(1)) await expect(createOrder(cashier, orderInput(menu.id, { discount: beyond }), key())).rejects.toMatchObject({ code: 'DISCOUNT_LIMIT' });
    await expect(createOrder(kitchen, orderInput(menu.id), key())).rejects.toMatchObject({ status: 403 });
    await expect(createOrder(inventory, orderInput(menu.id), key())).rejects.toMatchObject({ status: 403 });
    const pending = await createOrder(cashier, orderInput(menu.id, { confirm: false }), key());
    await expect(changeOrderStatus(cashier, pending.id, { status: 'PREPARING' }, key())).rejects.toMatchObject({ status: 403 });
    await expect(refundPayment(cashier, pending.id, { amount: '1', method: 'CASH', reason: 'Test refund' }, key())).rejects.toMatchObject({ status: 403 });
    const confirmed = await changeOrderStatus(cashier, pending.id, { status: 'CONFIRMED' }, key());
    expect(confirmed.status).toBe('CONFIRMED');
  });

  it('keeps a pending order recipe snapshot when a newer recipe and price are added', async () => {
    const { menu, ingredient, version } = await fixture();
    const order = await createOrder(owner, orderInput(menu.id, { confirm: false }), key());
    await prisma.menuItem.update({ where: { id: menu.id }, data: { price: '999' } });
    await prisma.recipeVersion.create({ data: { recipeId: menu.recipe!.id, version: 2, createdById: owner.id, ingredients: { create: { ingredientId: ingredient.id, quantity: '7' } } } });
    const confirmed = await changeOrderStatus(owner, order.id, { status: 'CONFIRMED' }, key());
    expect(confirmed.items[0].recipeVersionId).toBe(version.id);
    expect(new Decimal(confirmed.items[0].unitPrice).equals(100)).toBe(true);
    expect((await prisma.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } })).reserved.equals(2)).toBe(true);
  });

  it('allows only one concurrent reservation when both orders need the same final stock', async () => {
    const { menu, ingredient } = await fixture('2');
    const results = await Promise.allSettled([createOrder(owner, orderInput(menu.id), key()), createOrder(owner, orderInput(menu.id), key())]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const stock = await prisma.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } });
    expect(stock.reserved.equals(2)).toBe(true);
    expect(stock.onHand.equals(2)).toBe(true);
  });

  it('handles duplicate submissions and refuses an idempotency key with a changed payload', async () => {
    const { menu, ingredient } = await fixture();
    const requestKey = key();
    const input = orderInput(menu.id);
    const [first, second] = await Promise.all([createOrder(owner, input, requestKey), createOrder(owner, input, requestKey)]);
    expect(first.id).toBe(second.id);
    expect(await prisma.inventoryReservation.count({ where: { orderId: first.id } })).toBe(1);
    expect((await prisma.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } })).reserved.equals(2)).toBe(true);
    await expect(createOrder(owner, orderInput(menu.id, { notes: 'Changed request' }), requestKey)).rejects.toMatchObject({ status: 409 });
  });

  it('consumes once on first preparation and never restores stock on late cancellation', async () => {
    const { menu, ingredient } = await fixture('10');
    const order = await createOrder(owner, orderInput(menu.id), key());
    const requestKey = key();
    await Promise.all([changeOrderStatus(kitchen, order.id, { status: 'PREPARING' }, requestKey), changeOrderStatus(kitchen, order.id, { status: 'PREPARING' }, requestKey)]);
    await expect(changeOrderStatus(kitchen, order.id, { status: 'PREPARING' }, key())).rejects.toMatchObject({ code: 'INVALID_ORDER_TRANSITION' });
    let stock = await prisma.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } });
    expect(stock.onHand.equals(8)).toBe(true);
    expect(stock.reserved.equals(0)).toBe(true);
    expect(await prisma.inventoryMovement.count({ where: { orderId: order.id, type: 'CONSUMPTION' } })).toBe(1);
    expect((await prisma.inventoryReservation.findFirstOrThrow({ where: { orderId: order.id } })).status).toBe('CONSUMED');
    await expect(changeOrderStatus(kitchen, order.id, { status: 'CANCELLED' }, key())).rejects.toMatchObject({ status: 403 });
    await changeOrderStatus(owner, order.id, { status: 'CANCELLED' }, key());
    stock = await prisma.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } });
    expect(stock.onHand.equals(8)).toBe(true);
  });

  it('releases a confirmed cancellation without consuming stock', async () => {
    const { menu, ingredient } = await fixture('10');
    const order = await createOrder(owner, orderInput(menu.id), key());
    await changeOrderStatus(owner, order.id, { status: 'CANCELLED' }, key());
    const stock = await prisma.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } });
    expect(stock.onHand.equals(10)).toBe(true);
    expect(stock.reserved.equals(0)).toBe(true);
    expect(await prisma.inventoryMovement.count({ where: { orderId: order.id } })).toBe(0);
    expect((await prisma.inventoryReservation.findFirstOrThrow({ where: { orderId: order.id } })).status).toBe('RELEASED');
  });

  it('validates preparation quantities and automatically marks a fully prepared order ready', async () => {
    const { menu } = await fixture();
    const order = await createOrder(owner, { items: [{ menuItemId: menu.id, quantity: 2 }] }, key());
    await expect(markOrderItemReady(kitchen, order.id, order.items[0].id, { quantity: 2 }, key())).rejects.toMatchObject({ code: 'ORDER_NOT_PREPARING' });
    await changeOrderStatus(kitchen, order.id, { status: 'PREPARING' }, key());
    await expect(changeOrderStatus(kitchen, order.id, { status: 'READY' }, key())).rejects.toMatchObject({ code: 'ITEMS_NOT_READY' });
    const partial = await markOrderItemReady(kitchen, order.id, order.items[0].id, { quantity: 1 }, key());
    expect(partial.status).toBe('PREPARING');
    await expect(markOrderItemReady(kitchen, order.id, order.items[0].id, { quantity: 0 }, key())).rejects.toMatchObject({ code: 'INVALID_PREPARED_QUANTITY' });
    await expect(markOrderItemReady(kitchen, order.id, order.items[0].id, { quantity: 3 }, key())).rejects.toMatchObject({ code: 'INVALID_PREPARED_QUANTITY' });
    const ready = await markOrderItemReady(kitchen, order.id, order.items[0].id, { quantity: 2 }, key());
    expect(ready.status).toBe('READY');
    await expect(changeOrderStatus(cashier, order.id, { status: 'COMPLETED' }, key())).rejects.toMatchObject({ code: 'PAYMENT_REQUIRED' });
  });

  it('reconciles concurrent item completion into a ready order', async () => {
    const { menu } = await fixture();
    const order = await createOrder(owner, { items: [{ menuItemId: menu.id, quantity: 1, notes: 'First plate' }, { menuItemId: menu.id, quantity: 1, notes: 'Second plate' }] }, key());
    await changeOrderStatus(kitchen, order.id, { status: 'PREPARING' }, key());
    await Promise.all(order.items.map((item: { id: string }) => markOrderItemReady(kitchen, order.id, item.id, { quantity: 1 }, key())));
    const persisted = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
    expect(persisted.status).toBe('READY');
    expect(persisted.items.every(item => item.preparedQuantity === item.quantity)).toBe(true);
  });

  it('serializes concurrent distinct payments so the order cannot be overpaid', async () => {
    const { menu } = await fixture();
    const order = await createOrder(owner, orderInput(menu.id), key());
    const payment = { amount: new Decimal(order.total).toFixed(2), method: 'CASH' };
    const attempts = await Promise.allSettled([recordPayment(cashier, order.id, payment, key()), recordPayment(cashier, order.id, payment, key())]);
    expect(attempts.filter(attempt => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(attempt => attempt.status === 'rejected')).toHaveLength(1);
    const payments = await prisma.payment.findMany({ where: { orderId: order.id } });
    expect(payments).toHaveLength(1);
    expect(payments[0].amount.equals(order.total)).toBe(true);
  });

  it('bounds payments, prevents duplicate charges, requires paid completion and bounds refunds', async () => {
    const { menu } = await fixture();
    const ready = await prepareOrder(menu.id);
    await expect(recordPayment(cashier, ready.id, { amount: '0', method: 'CASH' }, key())).rejects.toMatchObject({ code: 'INVALID_PAYMENT_AMOUNT' });
    await expect(recordPayment(cashier, ready.id, { amount: '1', method: 'NOT_CONFIGURED' }, key())).rejects.toMatchObject({ code: 'INVALID_PAYMENT_METHOD' });
    await expect(recordPayment(cashier, ready.id, { amount: new Decimal(ready.total).plus(1).toFixed(2), method: 'CASH' }, key())).rejects.toMatchObject({ code: 'INVALID_PAYMENT_AMOUNT' });
    const requestKey = key();
    const payment = { amount: new Decimal(ready.total).toFixed(2), method: 'CASH' };
    await Promise.all([recordPayment(cashier, ready.id, payment, requestKey), recordPayment(cashier, ready.id, payment, requestKey)]);
    expect(await prisma.payment.count({ where: { orderId: ready.id, type: 'PAYMENT' } })).toBe(1);
    await changeOrderStatus(cashier, ready.id, { status: 'COMPLETED' }, key());
    const refundKey = key();
    const refund = { amount: new Decimal(ready.total).toFixed(2), method: 'CASH', reason: 'Customer return' };
    await refundPayment(owner, ready.id, refund, refundKey);
    await refundPayment(owner, ready.id, refund, refundKey);
    expect(await prisma.payment.count({ where: { orderId: ready.id, type: 'REFUND' } })).toBe(1);
    await expect(refundPayment(owner, ready.id, { amount: '0.01', method: 'CASH', reason: 'Another refund' }, key())).rejects.toMatchObject({ code: 'INVALID_REFUND_AMOUNT' });
    const receipt = await orderReceipt(ready.id);
    expect(receipt.netPaid.equals(0)).toBe(true);
    expect(receipt.refunded.equals(ready.total)).toBe(true);
    expect(receipt.paymentNotice).toContain('does not process');
  });
});
