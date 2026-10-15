import { Router } from 'express';
import { z } from 'zod';
import { prisma, Decimal, AppError, requireRoles, tx, idempotent, requestKey, audit, notify, publish, quantity, pagination } from '../lib/core.js';

export const purchasingRouter = Router();
const managers = requireRoles('OWNER', 'MANAGER');
const inventoryRoles = requireRoles('OWNER', 'MANAGER', 'INVENTORY');
const id = z.string().min(1).max(80);
const positive = z.string().regex(/^\d{1,12}(?:\.\d{1,6})?$/).refine(v => new Decimal(v).gt(0), 'Quantity must be positive.');
const cost = z.string().regex(/^\d{1,12}(?:\.\d{1,6})?$/);
const unit = z.enum(['G', 'KG', 'ML', 'L', 'PIECE']);
const supplierSchema = z.object({
  name: z.string().trim().min(1).max(160), contactName: z.string().trim().max(160).nullable().optional(),
  email: z.email().max(254).nullable().optional(), phone: z.string().trim().max(60).nullable().optional(),
  address: z.string().trim().max(500).nullable().optional(), active: z.boolean().optional(),
}).strict();
const lineSchema = z.object({ ingredientId: id, quantity: positive, unit, unitCost: cost }).strict();
const purchaseSchema = z.object({
  supplierId: id, expectedAt: z.iso.datetime({ offset: true }).optional(), notes: z.string().trim().max(1000).optional(),
  items: z.array(lineSchema).min(1).max(200),
}).strict().refine(body => new Set(body.items.map(item => item.ingredientId)).size === body.items.length, 'Each ingredient may appear only once.');
const receiptSchema = z.object({
  invoiceReference: z.string().trim().min(1).max(160).optional(),
  items: z.array(z.object({ purchaseOrderItemId: id, quantity: positive, unit, unitCost: cost, expiresAt: z.iso.datetime({ offset: true }).optional() }).strict()).min(1).max(200),
}).strict().refine(body => new Set(body.items.map(item => item.purchaseOrderItemId)).size === body.items.length, 'Each purchase line may appear only once.');
const wasteSchema = z.object({ ingredientId: id, quantity: positive, unit, reason: z.string().trim().min(3).max(500) }).strict();
const purchaseInclude = { supplier: true, items: { include: { ingredient: true } }, receipts: { include: { items: true, receivedBy: { select: { id: true, name: true, role: true } } } } } as const;
const person = { select: { id: true, name: true, role: true } } as const;
const wasteInclude = { ingredient: true, createdBy: person, approvedBy: person } as const;
function json<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function normalizedCost(value: string, suppliedUnit: z.infer<typeof unit>, canonicalUnit: z.infer<typeof unit>) {
  const normalized = new Decimal(value).div(quantity('1', suppliedUnit, canonicalUnit));
  if (normalized.decimalPlaces() > 6) throw new AppError(400, 'INVALID_UNIT_COST', 'Unit cost must be representable to six decimal places in the ingredient canonical unit.');
  return normalized;
}

purchasingRouter.get('/suppliers', inventoryRoles, async (req, res) => {
  const page = pagination(req);
  const query = z.object({ q: z.string().max(160).optional(), active: z.enum(['true', 'false']).optional() }).parse(req.query);
  const where = { ...(query.q ? { name: { contains: query.q, mode: 'insensitive' as const } } : {}), ...(query.active ? { active: query.active === 'true' } : {}) };
  const [rows, total] = await Promise.all([prisma.supplier.findMany({ where, orderBy: { name: 'asc' }, skip: page.skip, take: page.take }), prisma.supplier.count({ where })]);
  res.json({ data: rows, pagination: { page: page.page, pageSize: page.pageSize, total } });
});

purchasingRouter.post('/suppliers', managers, async (req, res) => {
  const body = supplierSchema.parse(req.body), key = requestKey(req), actor = req.user!.id;
  const result = await tx(t => idempotent(t, actor, 'supplier:create', key, body, async () => {
    const supplier = await t.supplier.create({ data: body });
    await audit(t, actor, 'SUPPLIER_CREATED', 'Supplier', supplier.id, { name: supplier.name });
    return json(supplier);
  }));
  res.status(201).json({ data: result });
});

purchasingRouter.patch('/suppliers/:id', managers, async (req, res) => {
  const supplierId = id.parse(req.params.id), body = supplierSchema.partial().refine(v => Object.keys(v).length > 0, 'Supply at least one field.').parse(req.body);
  const key = requestKey(req), actor = req.user!.id;
  const result = await tx(t => idempotent(t, actor, `supplier:update:${supplierId}`, key, body, async () => {
    if (!await t.supplier.findUnique({ where: { id: supplierId } })) throw new AppError(404, 'NOT_FOUND', 'Supplier not found.');
    const supplier = await t.supplier.update({ where: { id: supplierId }, data: body });
    await audit(t, actor, 'SUPPLIER_UPDATED', 'Supplier', supplier.id, { fields: Object.keys(body) });
    return json(supplier);
  }));
  res.json({ data: result });
});

purchasingRouter.get('/purchases', inventoryRoles, async (req, res) => {
  const page = pagination(req);
  const filters = z.object({ status: z.enum(['DRAFT', 'ORDERED', 'PARTIAL', 'RECEIVED', 'CANCELLED']).optional(), supplierId: id.optional() }).parse(req.query);
  const [rows, total] = await Promise.all([prisma.purchaseOrder.findMany({ where: filters, include: purchaseInclude, orderBy: { createdAt: 'desc' }, skip: page.skip, take: page.take }), prisma.purchaseOrder.count({ where: filters })]);
  res.json({ data: rows, pagination: { page: page.page, pageSize: page.pageSize, total } });
});

purchasingRouter.get('/purchases/:id', inventoryRoles, async (req, res) => {
  const purchase = await prisma.purchaseOrder.findUnique({ where: { id: id.parse(req.params.id) }, include: purchaseInclude });
  if (!purchase) throw new AppError(404, 'NOT_FOUND', 'Purchase order not found.');
  res.json({ data: purchase });
});

purchasingRouter.post('/purchases', managers, async (req, res) => {
  const body = purchaseSchema.parse(req.body), key = requestKey(req), actor = req.user!.id;
  const result = await tx(t => idempotent(t, actor, 'purchase:create', key, body, async () => {
    const supplier = await t.supplier.findUnique({ where: { id: body.supplierId } });
    if (!supplier?.active) throw new AppError(400, 'INVALID_SUPPLIER', 'Choose an active supplier.');
    const ingredients = await t.ingredient.findMany({ where: { id: { in: body.items.map(item => item.ingredientId) } } });
    const items = body.items.map(item => {
      const ingredient = ingredients.find(candidate => candidate.id === item.ingredientId);
      if (!ingredient?.active) throw new AppError(400, 'INVALID_INGREDIENT', 'Choose active ingredients for every purchase line.');
      return { ingredientId: ingredient.id, quantity: quantity(item.quantity, item.unit, ingredient.unit), unitCost: normalizedCost(item.unitCost, item.unit, ingredient.unit) };
    });
    const purchase = await t.purchaseOrder.create({ data: { supplierId: supplier.id, expectedAt: body.expectedAt ? new Date(body.expectedAt) : undefined, notes: body.notes, createdById: actor, items: { create: items } }, include: purchaseInclude });
    await audit(t, actor, 'PURCHASE_CREATED', 'PurchaseOrder', purchase.id, { number: purchase.number, supplierId: supplier.id });
    return json(purchase);
  }));
  publish('purchasing:changed', { action: 'created' }, ['OWNER', 'MANAGER', 'INVENTORY']);
  res.status(201).json({ data: result });
});

purchasingRouter.post('/purchases/:id/status', managers, async (req, res) => {
  const purchaseId = id.parse(req.params.id), body = z.object({ status: z.enum(['ORDERED', 'CANCELLED']) }).strict().parse(req.body);
  const key = requestKey(req), actor = req.user!.id;
  const result = await tx(t => idempotent(t, actor, `purchase:status:${purchaseId}`, key, body, async () => {
    const purchase = await t.purchaseOrder.findUnique({ where: { id: purchaseId }, include: { items: true, supplier: true } });
    if (!purchase) throw new AppError(404, 'NOT_FOUND', 'Purchase order not found.');
    if (body.status === 'ORDERED' && (purchase.status !== 'DRAFT' || !purchase.supplier.active)) throw new AppError(409, 'INVALID_TRANSITION', 'Only a draft with an active supplier can be ordered.');
    if (body.status === 'CANCELLED' && !['DRAFT', 'ORDERED', 'PARTIAL'].includes(purchase.status)) throw new AppError(409, 'INVALID_TRANSITION', 'Only open purchase orders can be cancelled.');
    // Cancelling a partial delivery closes the remainder; existing receipts and stock remain intact.
    const updated = await t.purchaseOrder.update({ where: { id: purchaseId }, data: { status: body.status }, include: purchaseInclude });
    await audit(t, actor, `PURCHASE_${body.status}`, 'PurchaseOrder', purchaseId, { previousStatus: purchase.status, receivedStockRetained: true });
    if (body.status === 'ORDERED') await notify(t, 'PURCHASE_ORDERED', 'Supplier delivery expected', `Purchase #${purchase.number} has been ordered from ${purchase.supplier.name}.`, ['OWNER', 'MANAGER', 'INVENTORY']);
    return json(updated);
  }));
  publish('purchasing:changed', { id: purchaseId }, ['OWNER', 'MANAGER', 'INVENTORY']);
  res.json({ data: result });
});

purchasingRouter.post('/purchases/:id/receipts', inventoryRoles, async (req, res) => {
  const purchaseId = id.parse(req.params.id), body = receiptSchema.parse(req.body), key = requestKey(req), actor = req.user!.id;
  const result = await tx(t => idempotent(t, actor, `purchase:receipt:${purchaseId}`, key, body, async () => {
    const purchase = await t.purchaseOrder.findUnique({ where: { id: purchaseId }, include: { items: { include: { ingredient: true } } } });
    if (!purchase) throw new AppError(404, 'NOT_FOUND', 'Purchase order not found.');
    if (!['ORDERED', 'PARTIAL'].includes(purchase.status)) throw new AppError(409, 'INVALID_TRANSITION', 'Receive only ordered or partially received purchases.');
    if (body.invoiceReference && await t.goodsReceipt.findFirst({ where: { purchaseOrderId: purchaseId, invoiceReference: body.invoiceReference } })) throw new AppError(409, 'DUPLICATE_INVOICE', 'This invoice reference is already received for this purchase.');
    const receipt = await t.goodsReceipt.create({ data: { purchaseOrderId: purchaseId, invoiceReference: body.invoiceReference, receivedById: actor } });
    // Stable ingredient order keeps concurrent receipt/count/consumption transactions predictable.
    for (const item of [...body.items].sort((a, b) => a.purchaseOrderItemId.localeCompare(b.purchaseOrderItemId))) {
      const line = purchase.items.find(candidate => candidate.id === item.purchaseOrderItemId);
      if (!line) throw new AppError(400, 'INVALID_PURCHASE_LINE', 'Every receipt line must belong to this purchase.');
      const received = quantity(item.quantity, item.unit, line.ingredient.unit);
      if (line.receivedQuantity.plus(received).gt(line.quantity)) throw new AppError(409, 'OVER_RECEIPT', `Receipt exceeds the remaining quantity for ${line.ingredient.name}.`);
      const unitCost = normalizedCost(item.unitCost, item.unit, line.ingredient.unit);
      const current = await t.ingredient.findUniqueOrThrow({ where: { id: line.ingredientId } });
      const onHand = current.onHand.plus(received);
      if (onHand.gte('1000000000000')) throw new AppError(400, 'INVALID_QUANTITY', 'The resulting stock balance exceeds the supported quantity range.');
      const weightedCost = current.onHand.mul(current.unitCost).plus(received.mul(unitCost)).div(onHand).toDecimalPlaces(6);
      await t.goodsReceiptItem.create({ data: { goodsReceiptId: receipt.id, purchaseOrderItemId: line.id, quantity: received, unitCost, expiresAt: item.expiresAt ? new Date(item.expiresAt) : undefined } });
      await t.purchaseOrderItem.update({ where: { id: line.id }, data: { receivedQuantity: { increment: received } } });
      await t.ingredient.update({ where: { id: line.ingredientId }, data: { onHand, unitCost: weightedCost, ...(item.expiresAt && (!current.expiresAt || new Date(item.expiresAt) < current.expiresAt) ? { expiresAt: new Date(item.expiresAt) } : {}) } });
      await t.inventoryMovement.create({ data: { ingredientId: line.ingredientId, type: 'PURCHASE', quantity: received, unitCost, reason: `Goods received against purchase #${purchase.number}`, reference: body.invoiceReference ?? `PO-${purchase.number}`, actorId: actor, goodsReceiptId: receipt.id } });
    }
    const lines = await t.purchaseOrderItem.findMany({ where: { purchaseOrderId: purchaseId } });
    const status = lines.every(line => line.receivedQuantity.eq(line.quantity)) ? 'RECEIVED' : 'PARTIAL';
    await t.purchaseOrder.update({ where: { id: purchaseId }, data: { status } });
    await audit(t, actor, 'PURCHASE_RECEIVED', 'GoodsReceipt', receipt.id, { purchaseOrderId: purchaseId, invoiceReference: body.invoiceReference ?? null, lines: body.items.length, status });
    await notify(t, 'PURCHASE_RECEIVED', 'Stock received', `Purchase #${purchase.number} is ${status.toLowerCase()}.`, ['OWNER', 'MANAGER', 'INVENTORY']);
    return json(await t.goodsReceipt.findUniqueOrThrow({ where: { id: receipt.id }, include: { items: true, purchaseOrder: { include: purchaseInclude } } }));
  }));
  publish('inventory:changed', { purchaseId }, ['OWNER', 'MANAGER', 'INVENTORY']);
  publish('purchasing:changed', { id: purchaseId }, ['OWNER', 'MANAGER', 'INVENTORY']);
  res.status(201).json({ data: result });
});

purchasingRouter.get('/waste', inventoryRoles, async (req, res) => {
  const page = pagination(req);
  const filters = z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(), ingredientId: id.optional() }).parse(req.query);
  const [rows, total] = await Promise.all([prisma.wasteRecord.findMany({ where: filters, include: wasteInclude, orderBy: { createdAt: 'desc' }, skip: page.skip, take: page.take }), prisma.wasteRecord.count({ where: filters })]);
  res.json({ data: rows, pagination: { page: page.page, pageSize: page.pageSize, total } });
});

purchasingRouter.post('/waste', inventoryRoles, async (req, res) => {
  const body = wasteSchema.parse(req.body), key = requestKey(req), actor = req.user!.id;
  const result = await tx(t => idempotent(t, actor, 'waste:create', key, body, async () => {
    const ingredient = await t.ingredient.findUnique({ where: { id: body.ingredientId } });
    if (!ingredient?.active) throw new AppError(400, 'INVALID_INGREDIENT', 'Choose an active ingredient.');
    const amount = quantity(body.quantity, body.unit, ingredient.unit);
    if (amount.gt(ingredient.onHand.minus(ingredient.reserved))) throw new AppError(409, 'INSUFFICIENT_STOCK', 'Waste cannot exceed unreserved stock.');
    const estimatedCost = amount.mul(ingredient.unitCost).toDecimalPlaces(2);
    if (estimatedCost.gte('1000000000000')) throw new AppError(400, 'INVALID_COST', 'The waste value exceeds the supported money range.');
    const waste = await t.wasteRecord.create({ data: { ingredientId: ingredient.id, quantity: amount, estimatedCost, reason: body.reason, createdById: actor }, include: wasteInclude });
    await audit(t, actor, 'WASTE_RECORDED', 'WasteRecord', waste.id, { ingredientId: ingredient.id, quantity: amount.toString(), status: 'PENDING' });
    await notify(t, 'WASTE_PENDING', 'Waste approval needed', `${ingredient.name}: ${amount.toString()} ${ingredient.unit} recorded for approval.`, ['OWNER', 'MANAGER']);
    return json(waste);
  }));
  publish('inventory:changed', { action: 'waste-pending' }, ['OWNER', 'MANAGER', 'INVENTORY']);
  res.status(201).json({ data: result });
});

purchasingRouter.post('/waste/:id/approve', managers, async (req, res) => {
  const wasteId = id.parse(req.params.id), body = z.object({}).strict().parse(req.body ?? {}), key = requestKey(req), actor = req.user!.id;
  const result = await tx(t => idempotent(t, actor, `waste:approve:${wasteId}`, key, body, async () => {
    const waste = await t.wasteRecord.findUnique({ where: { id: wasteId }, include: { ingredient: true } });
    if (!waste) throw new AppError(404, 'NOT_FOUND', 'Waste record not found.');
    if (waste.status !== 'PENDING') throw new AppError(409, 'ALREADY_REVIEWED', 'Waste has already been reviewed.');
    if (waste.quantity.gt(waste.ingredient.onHand.minus(waste.ingredient.reserved))) throw new AppError(409, 'INSUFFICIENT_STOCK', 'Unreserved stock is insufficient to approve this waste.');
    const estimatedCost = waste.quantity.mul(waste.ingredient.unitCost).toDecimalPlaces(2);
    if (estimatedCost.gte('1000000000000')) throw new AppError(400, 'INVALID_COST', 'The waste value exceeds the supported money range.');
    await t.ingredient.update({ where: { id: waste.ingredientId }, data: { onHand: { decrement: waste.quantity } } });
    await t.inventoryMovement.create({ data: { ingredientId: waste.ingredientId, type: 'WASTE', quantity: waste.quantity.negated(), unitCost: waste.ingredient.unitCost, reason: waste.reason, reference: waste.id, actorId: actor } });
    const updated = await t.wasteRecord.update({ where: { id: wasteId }, data: { status: 'APPROVED', approvedById: actor, approvedAt: new Date(), estimatedCost }, include: wasteInclude });
    await audit(t, actor, 'WASTE_APPROVED', 'WasteRecord', waste.id, { quantity: waste.quantity.toString(), estimatedCost: estimatedCost.toString() });
    if (waste.ingredient.onHand.minus(waste.quantity).minus(waste.ingredient.reserved).lte(waste.ingredient.minimumStock)) await notify(t, 'LOW_STOCK', 'Ingredient stock is low', `${waste.ingredient.name} is at or below its minimum available stock.`, ['OWNER', 'MANAGER', 'INVENTORY']);
    return json(updated);
  }));
  publish('inventory:changed', { wasteId }, ['OWNER', 'MANAGER', 'INVENTORY']);
  res.json({ data: result });
});
