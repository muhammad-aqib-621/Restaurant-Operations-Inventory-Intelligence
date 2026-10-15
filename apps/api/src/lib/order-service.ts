import type { Prisma, Role, OrderStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma, Decimal, AppError, tx, idempotent, audit, notify, publish } from './core.js';

type Actor = { id: string; role: Role };
type Transaction = Prisma.TransactionClient;
const money = z.string().regex(/^\d{1,12}(?:\.\d{1,2})?$/, 'Enter a decimal monetary amount with up to two decimal places.');
const note = z.string().trim().max(2000);
export const createOrderSchema = z.object({
  items: z.array(z.object({ menuItemId: z.string().min(1), quantity: z.number().int().min(1).max(999), notes: note.optional() }).strict()).min(1).max(100),
  notes: note.optional(), discount: money.default('0'), confirm: z.boolean().default(true),
  customer: z.object({ name: z.string().trim().min(1).max(120), phone: z.string().trim().min(1).max(50).optional() }).strict().optional(),
}).strict();
export const orderStatusSchema = z.object({ status: z.enum(['CONFIRMED', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED']) }).strict();
export const readyItemSchema = z.object({ quantity: z.number().int().min(0).max(999) }).strict();
export const paymentSchema = z.object({ amount: money, method: z.string().trim().min(1).max(50), reference: z.string().trim().max(200).optional() }).strict();
export const refundSchema = paymentSchema.extend({ reason: z.string().trim().min(3).max(1000) }).strict();
const includeOrder = { items: true, payments: { orderBy: { createdAt: 'asc' as const } }, customer: true } satisfies Prisma.OrderInclude;

function allow(actor: Actor, roles: Role[]) {
  if (!roles.includes(actor.role)) throw new AppError(403, 'FORBIDDEN', 'Your role cannot perform this order operation.');
}
function decimalMoney(value: InstanceType<typeof Decimal>) {
  const result = value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (!result.isFinite() || result.abs().gt('999999999999.99')) throw new AppError(400, 'MONEY_OUT_OF_RANGE', 'The order amount or estimated cost exceeds the supported monetary limit.');
  return result;
}
function plain<T>(value: T) { return JSON.parse(JSON.stringify(value)); }
async function loadOrder(transaction: Transaction, id: string) {
  const order = await transaction.order.findUnique({ where: { id }, include: includeOrder });
  if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found.');
  return order;
}
function paymentBalance(payments: { type: string; amount: InstanceType<typeof Decimal> }[]) {
  return payments.reduce((sum, payment) => payment.type === 'PAYMENT' ? sum.plus(payment.amount) : sum.minus(payment.amount), new Decimal(0));
}

/** Reserve creation-time recipe quantities. Guarded updates and SERIALIZABLE retries prevent overselling. */
async function reserveOrder(transaction: Transaction, orderId: string, actorId: string) {
  const order = await transaction.order.findUniqueOrThrow({ where: { id: orderId }, include: {
    items: { include: { recipeVersion: { include: { ingredients: { include: { ingredient: true } } } } } },
  } });
  const needed = new Map<string, InstanceType<typeof Decimal>>();
  for (const item of order.items) {
    for (const recipeIngredient of item.recipeVersion.ingredients) {
      if (!recipeIngredient.ingredient.active) throw new AppError(409, 'INGREDIENT_INACTIVE', `${recipeIngredient.ingredient.name} is inactive.`);
      needed.set(recipeIngredient.ingredientId, (needed.get(recipeIngredient.ingredientId) ?? new Decimal(0)).plus(recipeIngredient.quantity.mul(item.quantity)));
    }
  }
  if (!needed.size) throw new AppError(409, 'RECIPE_REQUIRED', 'An order must have ingredient recipes before confirmation.');
  for (const [ingredientId, required] of [...needed].sort(([a], [b]) => a.localeCompare(b))) {
    const ingredient = await transaction.ingredient.findUniqueOrThrow({ where: { id: ingredientId } });
    // Include the observed reserved balance in the guard; stale balance writers cannot both succeed.
    const updated = await transaction.ingredient.updateMany({
      where: { id: ingredientId, active: true, reserved: ingredient.reserved, onHand: { gte: ingredient.reserved.plus(required) } },
      data: { reserved: { increment: required } },
    });
    if (updated.count !== 1) throw new AppError(409, 'INSUFFICIENT_STOCK', `Insufficient available stock for ${ingredient.name}.`);
    await transaction.inventoryReservation.create({ data: { orderId, ingredientId, quantity: required } });
    if (ingredient.onHand.minus(ingredient.reserved).minus(required).lte(ingredient.minimumStock)) {
      await notify(transaction, 'LOW_STOCK', `Low stock: ${ingredient.name}`, `Available stock has reached the reorder threshold after order #${order.number}.`, ['OWNER', 'MANAGER', 'INVENTORY']);
    }
  }
  await audit(transaction, actorId, 'ORDER_RESERVED', 'Order', orderId, { ingredientCount: needed.size });
}

async function consumeReservations(transaction: Transaction, orderId: string, actorId: string, orderNumber: number) {
  const reservations = await transaction.inventoryReservation.findMany({ where: { orderId }, include: { ingredient: true }, orderBy: { ingredientId: 'asc' } });
  if (!reservations.length || reservations.some(reservation => reservation.status !== 'ACTIVE')) {
    throw new AppError(409, 'INVALID_RESERVATIONS', 'Order reservations are missing or have already been processed.');
  }
  for (const reservation of reservations) {
    const updated = await transaction.ingredient.updateMany({
      where: { id: reservation.ingredientId, reserved: { gte: reservation.quantity }, onHand: { gte: reservation.quantity } },
      data: { reserved: { decrement: reservation.quantity }, onHand: { decrement: reservation.quantity } },
    });
    if (updated.count !== 1) throw new AppError(409, 'INVALID_RESERVATIONS', 'Reserved stock is no longer available.');
    const claimed = await transaction.inventoryReservation.updateMany({ where: { id: reservation.id, status: 'ACTIVE' }, data: { status: 'CONSUMED' } });
    if (claimed.count !== 1) throw new AppError(409, 'INVALID_RESERVATIONS', 'Reservation was already consumed.');
    await transaction.inventoryMovement.create({ data: {
      ingredientId: reservation.ingredientId, type: 'CONSUMPTION', quantity: reservation.quantity.negated(), unitCost: reservation.ingredient.unitCost,
      reason: `Recipe consumption for order #${orderNumber}`, reference: `ORDER-${orderNumber}`, actorId, orderId,
    } });
  }
}
async function releaseReservations(transaction: Transaction, orderId: string) {
  const reservations = await transaction.inventoryReservation.findMany({ where: { orderId, status: 'ACTIVE' }, orderBy: { ingredientId: 'asc' } });
  for (const reservation of reservations) {
    const released = await transaction.inventoryReservation.updateMany({ where: { id: reservation.id, status: 'ACTIVE' }, data: { status: 'RELEASED' } });
    if (released.count !== 1) throw new AppError(409, 'INVALID_RESERVATIONS', 'Reservation was already processed.');
    const updated = await transaction.ingredient.updateMany({ where: { id: reservation.ingredientId, reserved: { gte: reservation.quantity } }, data: { reserved: { decrement: reservation.quantity } } });
    if (updated.count !== 1) throw new AppError(409, 'INVALID_RESERVATIONS', 'Reserved inventory does not match this order.');
  }
}
function changed(order: { id: string }, inventory: boolean) {
  publish('orders:changed', { orderId: order.id }, ['OWNER', 'MANAGER', 'CASHIER', 'KITCHEN']);
  if (inventory) publish('inventory:changed', { orderId: order.id }, ['OWNER', 'MANAGER', 'INVENTORY']);
}

export async function createOrder(actor: Actor, raw: unknown, key: string) {
  allow(actor, ['OWNER', 'MANAGER', 'CASHIER']);
  const input = createOrderSchema.parse(raw);
  const result = await tx(transaction => idempotent(transaction, actor.id, 'orders:create', key, input, async () => {
    const settings = await transaction.restaurantSettings.findUnique({ where: { id: 'primary' } });
    if (!settings) throw new AppError(503, 'NOT_CONFIGURED', 'Restaurant settings are missing.');
    const ids = [...new Set(input.items.map(item => item.menuItemId))];
    const menu = await transaction.menuItem.findMany({ where: { id: { in: ids } }, include: {
      category: true, recipe: { include: { versions: { orderBy: { version: 'desc' }, take: 1, include: { ingredients: { include: { ingredient: true } } } } } },
    } });
    const rows = input.items.map(item => {
      const match = menu.find(candidate => candidate.id === item.menuItemId);
      if (!match || !match.active || !match.category.active) throw new AppError(409, 'MENU_UNAVAILABLE', 'A selected menu item is unavailable.');
      const version = match.recipe?.versions[0];
      if (!version?.ingredients.length) throw new AppError(409, 'RECIPE_REQUIRED', `${match.name} needs an ingredient recipe before it can be ordered.`);
      if (version.ingredients.some(part => !part.ingredient.active)) throw new AppError(409, 'INGREDIENT_INACTIVE', `${match.name} contains an inactive ingredient.`);
      return { menuItemId: match.id, recipeVersionId: version.id, name: match.name, quantity: item.quantity, notes: item.notes,
        unitPrice: match.price, estimatedUnitCost: decimalMoney(version.ingredients.reduce((sum, part) => sum.plus(part.quantity.mul(part.ingredient.unitCost)), new Decimal(0))) };
    });
    const subtotal = decimalMoney(rows.reduce((sum, item) => sum.plus(item.unitPrice.mul(item.quantity)), new Decimal(0)));
    const discount = new Decimal(input.discount);
    if (discount.gt(subtotal)) throw new AppError(400, 'DISCOUNT_EXCEEDS_SUBTOTAL', 'Discount cannot exceed the order subtotal.');
    if (actor.role === 'CASHIER' && discount.gt(subtotal.mul(settings.cashierDiscountLimit))) {
      throw new AppError(403, 'DISCOUNT_LIMIT', 'The discount exceeds your configured cashier limit.');
    }
    const tax = decimalMoney(subtotal.minus(discount).mul(settings.taxRate));
    const total = subtotal.minus(discount).plus(tax);
    if (total.gt('999999999999.99')) throw new AppError(400, 'ORDER_TOTAL_TOO_LARGE', 'Order total exceeds the supported limit.');
    const customer = input.customer ? await transaction.customer.create({ data: input.customer }) : null;
    const order = await transaction.order.create({ data: {
      createdById: actor.id, customerId: customer?.id, notes: input.notes, subtotal, discount, tax, total,
      estimatedCost: decimalMoney(rows.reduce((sum, item) => sum.plus(item.estimatedUnitCost.mul(item.quantity)), new Decimal(0))),
      status: input.confirm ? 'CONFIRMED' : 'PENDING', items: { create: rows },
    } });
    if (input.confirm) await reserveOrder(transaction, order.id, actor.id);
    await audit(transaction, actor.id, 'ORDER_CREATED', 'Order', order.id, { number: order.number, total: total.toFixed(2), status: order.status });
    await notify(transaction, 'NEW_ORDER', `New order #${order.number}`, `${rows.reduce((sum, item) => sum + item.quantity, 0)} item(s) ${input.confirm ? 'confirmed for the kitchen' : 'awaiting confirmation'}.`, ['OWNER', 'MANAGER', 'KITCHEN']);
    return plain(await loadOrder(transaction, order.id));
  }));
  changed(result, input.confirm);
  return result;
}

const transitions: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED'], CONFIRMED: ['PREPARING', 'CANCELLED'], PREPARING: ['READY', 'CANCELLED'],
  READY: ['COMPLETED', 'CANCELLED'], COMPLETED: [], CANCELLED: [],
};
export async function changeOrderStatus(actor: Actor, orderId: string, raw: unknown, key: string) {
  allow(actor, ['OWNER', 'MANAGER', 'CASHIER', 'KITCHEN']);
  const input = orderStatusSchema.parse(raw);
  const result = await tx(transaction => idempotent(transaction, actor.id, `orders:${orderId}:status`, key, input, async () => {
    const order = await loadOrder(transaction, orderId);
    if (actor.role === 'KITCHEN' && !['CONFIRMED', 'PREPARING', 'READY'].includes(input.status)) throw new AppError(403, 'FORBIDDEN', 'Kitchen staff may only advance preparation.');
    if (actor.role === 'CASHIER' && !(input.status === 'COMPLETED' || (input.status === 'CANCELLED' && order.status === 'PENDING') || (input.status === 'CONFIRMED' && order.createdById === actor.id))) {
      throw new AppError(403, 'FORBIDDEN', 'Cashiers may confirm their own pending order, complete a ready order, or cancel a pending order.');
    }
    if (!transitions[order.status].includes(input.status)) throw new AppError(409, 'INVALID_ORDER_TRANSITION', `Cannot change an order from ${order.status} to ${input.status}.`);
    if (input.status === 'CONFIRMED') await reserveOrder(transaction, order.id, actor.id);
    if (input.status === 'PREPARING') await consumeReservations(transaction, order.id, actor.id, order.number);
    if (input.status === 'READY' && order.items.some(item => item.preparedQuantity !== item.quantity)) throw new AppError(409, 'ITEMS_NOT_READY', 'Mark every item prepared before the order is ready.');
    if (input.status === 'COMPLETED' && paymentBalance(order.payments).lt(order.total)) throw new AppError(409, 'PAYMENT_REQUIRED', 'The order must be fully paid before completion.');
    if (input.status === 'CANCELLED' && ['PENDING', 'CONFIRMED'].includes(order.status)) await releaseReservations(transaction, order.id);
    await transaction.order.update({ where: { id: order.id }, data: { status: input.status } });
    await audit(transaction, actor.id, input.status === 'CANCELLED' ? 'ORDER_CANCELLED' : 'ORDER_STATUS_CHANGED', 'Order', order.id, {
      from: order.status, to: input.status, stockRestored: false, reservationsReleased: input.status === 'CANCELLED' && ['PENDING', 'CONFIRMED'].includes(order.status),
    });
    if (input.status === 'READY') await notify(transaction, 'ORDER_READY', `Order #${order.number} ready`, 'All items are ready for collection.', ['OWNER', 'MANAGER', 'CASHIER']);
    return plain(await loadOrder(transaction, order.id));
  }));
  changed(result, ['CONFIRMED', 'PREPARING', 'CANCELLED'].includes(input.status));
  return result;
}
export async function markOrderItemReady(actor: Actor, orderId: string, itemId: string, raw: unknown, key: string) {
  allow(actor, ['OWNER', 'MANAGER', 'KITCHEN']);
  const input = readyItemSchema.parse(raw);
  const result = await tx(transaction => idempotent(transaction, actor.id, `orders:${orderId}:items:${itemId}:ready`, key, input, async () => {
    const order = await loadOrder(transaction, orderId);
    if (!['PREPARING', 'READY'].includes(order.status)) throw new AppError(409, 'ORDER_NOT_PREPARING', 'Start preparation before marking items ready.');
    const item = order.items.find(candidate => candidate.id === itemId);
    if (!item) throw new AppError(404, 'ORDER_ITEM_NOT_FOUND', 'Order item not found.');
    if (input.quantity > item.quantity || input.quantity < item.preparedQuantity) throw new AppError(400, 'INVALID_PREPARED_QUANTITY', 'Prepared quantity must be cumulative and cannot exceed the ordered quantity.');
    await transaction.orderItem.update({ where: { id: item.id }, data: { preparedQuantity: input.quantity } });
    const complete = order.items.every(candidate => candidate.id === itemId ? input.quantity === candidate.quantity : candidate.preparedQuantity === candidate.quantity);
    if (complete && order.status !== 'READY') {
      await transaction.order.update({ where: { id: order.id }, data: { status: 'READY' } });
      await notify(transaction, 'ORDER_READY', `Order #${order.number} ready`, 'All items are ready for collection.', ['OWNER', 'MANAGER', 'CASHIER']);
    }
    await audit(transaction, actor.id, 'ORDER_ITEM_PREPARED', 'Order', order.id, { itemId, preparedQuantity: input.quantity });
    return plain(await loadOrder(transaction, order.id));
  }));
  changed(result, false);
  return result;
}

export async function recordPayment(actor: Actor, orderId: string, raw: unknown, key: string) {
  allow(actor, ['OWNER', 'MANAGER', 'CASHIER']);
  const input = paymentSchema.parse(raw);
  const result = await tx(transaction => idempotent(transaction, actor.id, `orders:${orderId}:payments`, key, input, async () => {
    const order = await loadOrder(transaction, orderId);
    if (order.status === 'CANCELLED' || order.status === 'PENDING') throw new AppError(409, 'ORDER_NOT_PAYABLE', 'Confirm the order before recording payment. Cancelled orders cannot receive payments.');
    const settings = await transaction.restaurantSettings.findUniqueOrThrow({ where: { id: 'primary' } });
    if (!settings.paymentMethods.includes(input.method)) throw new AppError(400, 'INVALID_PAYMENT_METHOD', 'This payment method is not configured.');
    const amount = new Decimal(input.amount);
    if (amount.lte(0) || amount.gt(order.total.minus(paymentBalance(order.payments)))) throw new AppError(400, 'INVALID_PAYMENT_AMOUNT', 'Payment must be positive and cannot exceed the outstanding balance.');
    await transaction.payment.create({ data: { orderId, type: 'PAYMENT', amount, method: input.method, reference: input.reference, createdById: actor.id } });
    await audit(transaction, actor.id, 'PAYMENT_RECORDED', 'Order', orderId, { amount: amount.toFixed(2), method: input.method });
    return plain(await loadOrder(transaction, orderId));
  }));
  changed(result, false);
  return result;
}
export async function refundPayment(actor: Actor, orderId: string, raw: unknown, key: string) {
  allow(actor, ['OWNER', 'MANAGER']);
  const input = refundSchema.parse(raw);
  const result = await tx(transaction => idempotent(transaction, actor.id, `orders:${orderId}:refunds`, key, input, async () => {
    const order = await loadOrder(transaction, orderId);
    const settings = await transaction.restaurantSettings.findUniqueOrThrow({ where: { id: 'primary' } });
    if (!settings.paymentMethods.includes(input.method)) throw new AppError(400, 'INVALID_PAYMENT_METHOD', 'This payment method is not configured.');
    const amount = new Decimal(input.amount);
    if (amount.lte(0) || amount.gt(paymentBalance(order.payments))) throw new AppError(400, 'INVALID_REFUND_AMOUNT', 'Refund must be positive and cannot exceed net recorded payments.');
    await transaction.payment.create({ data: { orderId, type: 'REFUND', amount, method: input.method, reference: input.reference, createdById: actor.id } });
    await audit(transaction, actor.id, 'PAYMENT_REFUNDED', 'Order', orderId, { amount: amount.toFixed(2), method: input.method, reason: input.reason });
    return plain(await loadOrder(transaction, orderId));
  }));
  changed(result, false);
  return result;
}

export async function getOrder(id: string) { return loadOrder(prisma, id); }
export async function orderReceipt(id: string) {
  const [order, settings] = await Promise.all([getOrder(id), prisma.restaurantSettings.findUniqueOrThrow({ where: { id: 'primary' } })]);
  const paid = order.payments.filter(payment => payment.type === 'PAYMENT').reduce((sum, payment) => sum.plus(payment.amount), new Decimal(0));
  const refunded = order.payments.filter(payment => payment.type === 'REFUND').reduce((sum, payment) => sum.plus(payment.amount), new Decimal(0));
  return { restaurant: { name: settings.name, currency: settings.currency, timezone: settings.timezone, isDemo: settings.isDemo },
    id: order.id, number: order.number, status: order.status, createdAt: order.createdAt, customer: order.customer ? { name: order.customer.name, phone: order.customer.phone } : null,
    notes: order.notes, subtotal: order.subtotal, discount: order.discount, tax: order.tax, total: order.total,
    items: order.items.map(item => ({ id: item.id, name: item.name, quantity: item.quantity, unitPrice: item.unitPrice, lineTotal: item.unitPrice.mul(item.quantity), notes: item.notes })),
    payments: order.payments.map(payment => ({ type: payment.type, amount: payment.amount, method: payment.method, reference: payment.reference, createdAt: payment.createdAt })),
    paid, refunded, netPaid: paid.minus(refunded), outstanding: Decimal.max(0, order.total.minus(paid).plus(refunded)),
    paymentNotice: 'Payment records are entered by restaurant staff. This application does not process card transactions.',
  };
}
