import type { Prisma } from '@prisma/client';
import { AppError, Decimal, audit, notify } from './core.js';

/** Inventory balances may change only alongside append-only movements in this transaction. */
export function requireAvailable(onHand: Prisma.Decimal, reserved: Prisma.Decimal, delta: Prisma.Decimal) {
  const next = onHand.plus(delta);
  if (next.lt(0) || next.lt(reserved)) throw new AppError(409, 'INSUFFICIENT_AVAILABLE_STOCK', 'This operation would consume stock reserved for an order or make stock negative.');
  return next;
}

export async function approveStockAdjustment(transaction: Prisma.TransactionClient, actorId: string, id: string) {
  const adjustment = await transaction.stockAdjustment.findUnique({ where: { id }, include: { ingredient: true } });
  if (!adjustment) throw new AppError(404, 'NOT_FOUND', 'Stock adjustment not found.');
  if (adjustment.status !== 'PENDING') throw new AppError(409, 'ALREADY_REVIEWED', 'This stock adjustment has already been reviewed.');
  const ingredient = adjustment.ingredient;
  const onHand = requireAvailable(ingredient.onHand, ingredient.reserved, adjustment.quantity);
  await transaction.ingredient.update({ where: { id: ingredient.id }, data: { onHand } });
  await transaction.inventoryMovement.create({ data: { ingredientId: ingredient.id, type: 'ADJUSTMENT', quantity: adjustment.quantity, unitCost: ingredient.unitCost, reason: adjustment.reason, reference: adjustment.id, actorId } });
  const result = await transaction.stockAdjustment.update({ where: { id }, data: { status: 'APPROVED', approvedById: actorId, approvedAt: new Date() }, include: { ingredient: true } });
  await audit(transaction, actorId, 'inventory.adjustment_approved', 'StockAdjustment', id, { ingredientId: ingredient.id, quantity: adjustment.quantity.toString(), reason: adjustment.reason });
  if (onHand.minus(ingredient.reserved).lte(ingredient.minimumStock)) await notify(transaction, 'LOW_STOCK', 'Low stock', `${ingredient.name} is at or below its minimum available stock.`, ['OWNER', 'MANAGER', 'INVENTORY']);
  return result;
}

export async function approveStockCount(transaction: Prisma.TransactionClient, actorId: string, id: string) {
  const count = await transaction.stockCount.findUnique({ where: { id }, include: { items: { include: { ingredient: true } } } });
  if (!count) throw new AppError(404, 'NOT_FOUND', 'Stock count not found.');
  if (count.status !== 'PENDING') throw new AppError(409, 'ALREADY_REVIEWED', 'This stock count has already been reviewed.');
  // Validate every line before performing any mutation; the surrounding transaction remains atomic.
  for (const line of count.items) {
    if (!line.expectedQuantity.eq(line.ingredient.onHand)) throw new AppError(409, 'STALE_STOCK_COUNT', 'Stock changed after this count was submitted. Submit a new count.');
    requireAvailable(line.ingredient.onHand, line.ingredient.reserved, line.countedQuantity.minus(line.expectedQuantity));
  }
  for (const line of count.items) {
    const delta = line.countedQuantity.minus(line.expectedQuantity);
    if (delta.isZero()) continue;
    await transaction.ingredient.update({ where: { id: line.ingredientId }, data: { onHand: line.countedQuantity } });
    await transaction.inventoryMovement.create({ data: { ingredientId: line.ingredientId, type: 'COUNT', quantity: delta, unitCost: line.ingredient.unitCost, reason: count.notes || 'Approved physical stock count', reference: count.id, actorId } });
    if (line.countedQuantity.minus(line.ingredient.reserved).lte(line.ingredient.minimumStock)) await notify(transaction, 'LOW_STOCK', 'Low stock', `${line.ingredient.name} is at or below its minimum available stock.`, ['OWNER', 'MANAGER', 'INVENTORY']);
  }
  const result = await transaction.stockCount.update({ where: { id }, data: { status: 'APPROVED', approvedById: actorId, approvedAt: new Date() }, include: { items: { include: { ingredient: true } } } });
  await audit(transaction, actorId, 'inventory.count_approved', 'StockCount', id, { items: count.items.map(line => ({ ingredientId: line.ingredientId, expected: line.expectedQuantity.toString(), counted: line.countedQuantity.toString() })) });
  return result;
}

export async function reverseStockMovement(transaction: Prisma.TransactionClient, actorId: string, id: string, reason: string) {
  const movement = await transaction.inventoryMovement.findUnique({ where: { id }, include: { ingredient: true } });
  if (!movement) throw new AppError(404, 'NOT_FOUND', 'Inventory movement not found.');
  if (movement.type !== 'ADJUSTMENT' && movement.type !== 'COUNT') throw new AppError(409, 'REVERSAL_NOT_ALLOWED', 'Only approved manual adjustment and count movements can be reversed. Reverse purchase, waste, and order operations through their own workflow.');
  if (await transaction.inventoryMovement.findUnique({ where: { reversalOfId: id } })) throw new AppError(409, 'ALREADY_REVERSED', 'This movement already has a compensating reversal.');
  const delta = movement.quantity.negated();
  const onHand = requireAvailable(movement.ingredient.onHand, movement.ingredient.reserved, delta);
  await transaction.ingredient.update({ where: { id: movement.ingredientId }, data: { onHand } });
  const result = await transaction.inventoryMovement.create({ data: { ingredientId: movement.ingredientId, type: 'REVERSAL', quantity: delta, unitCost: movement.unitCost, reason, reference: movement.id, reversalOfId: movement.id, actorId } });
  await audit(transaction, actorId, 'inventory.movement_reversed', 'InventoryMovement', result.id, { originalMovementId: movement.id, quantity: delta.toString(), reason });
  return result;
}
