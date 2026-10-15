import { Router } from 'express';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { prisma, Decimal, AppError, requireRoles, pagination, tx } from '../lib/core.js';
import { allocatedEvent, businessDateRange, money, reportCsv, salesDefinitions, type BusinessRange, type PaymentEvent, type ReportRow } from '../lib/reporting.js';

export const reportsRouter = Router();
reportsRouter.use('/reports', requireRoles('OWNER', 'MANAGER'));
const reportTypes = z.enum(['sales', 'items', 'hourly', 'consumption', 'valuation', 'movements', 'waste', 'purchases', 'reorder']);
const paymentsInclude = { order: { include: { items: true, payments: true } } } as const;
const zero = () => new Decimal(0);
const between = (range: BusinessRange) => ({ gte: range.start, lt: range.end });
async function rangeFor(query: { from?: unknown; to?: unknown }, days: number) {
  const settings = await prisma.restaurantSettings.findUnique({ where: { id: 'primary' } });
  if (!settings) throw new AppError(503, 'NOT_CONFIGURED', 'Restaurant settings are missing.');
  return businessDateRange(query, settings.timezone, days);
}
function financials(events: PaymentEvent[]) {
  let sales = zero(), tax = zero(), collected = zero(), refunds = zero(), estimatedCogs = zero();
  const orders = new Set<string>();
  for (const event of events) {
    const allocated = allocatedEvent(event);
    sales = sales.plus(allocated.sales); tax = tax.plus(allocated.tax); estimatedCogs = estimatedCogs.plus(allocated.cost);
    if (event.type === 'PAYMENT') { collected = collected.plus(event.amount); orders.add(event.order.id); } else refunds = refunds.plus(event.amount);
  }
  return { sales: money(sales), tax: money(tax), collected: money(collected), refunds: money(refunds), orderCount: orders.size, averageOrderValue: orders.size ? money(sales.div(orders.size)) : '0.00', estimatedCogs: money(estimatedCogs), grossProfit: money(sales.minus(estimatedCogs)) };
}
function itemRows(events: PaymentEvent[]): ReportRow[] {
  const grouped = new Map<string, { menuItemId: string; name: string; quantity: InstanceType<typeof Decimal>; sales: InstanceType<typeof Decimal>; cost: InstanceType<typeof Decimal> }>();
  for (const event of events) {
    const allocated = allocatedEvent(event);
    let allocatedSales = zero(), allocatedCost = zero();
    event.order.items.forEach((item, index) => {
      const last = index === event.order.items.length - 1;
      const lineSales = last ? allocated.sales.minus(allocatedSales) : event.order.subtotal.gt(0) ? allocated.sales.mul(item.unitPrice).mul(item.quantity).div(event.order.subtotal).toDecimalPlaces(2) : zero();
      const lineCost = last ? allocated.cost.minus(allocatedCost) : event.order.estimatedCost.gt(0) ? allocated.cost.mul(item.estimatedUnitCost).mul(item.quantity).div(event.order.estimatedCost).toDecimalPlaces(2) : zero();
      allocatedSales = allocatedSales.plus(lineSales); allocatedCost = allocatedCost.plus(lineCost);
      const key = `${item.menuItemId}:${item.name}`;
      const row = grouped.get(key) ?? { menuItemId: item.menuItemId, name: item.name, quantity: zero(), sales: zero(), cost: zero() };
      row.quantity = row.quantity.plus(allocated.ratio.mul(item.quantity)); row.sales = row.sales.plus(lineSales); row.cost = row.cost.plus(lineCost); grouped.set(key, row);
    });
  }
  return [...grouped.values()].sort((a, b) => b.quantity.comparedTo(a.quantity)).map(row => ({ menuItemId: row.menuItemId, name: row.name, quantity: row.quantity.toDecimalPlaces(6).toString(), sales: money(row.sales), estimatedCogs: money(row.cost), grossProfit: money(row.sales.minus(row.cost)) }));
}
function salesBuckets(events: PaymentEvent[], range: BusinessRange, granularity: 'day' | 'month' | 'hour') {
  const groups = new Map<string, PaymentEvent[]>();
  // Include empty days/hours to make the chart accurately show gaps.
  let cursor = DateTime.fromJSDate(range.start, { zone: range.timezone });
  const end = DateTime.fromJSDate(range.end, { zone: range.timezone });
  if (granularity === 'month') cursor = cursor.startOf('month');
  while (cursor < end) {
    const key = cursor.toFormat(granularity === 'hour' ? 'yyyy-MM-dd HH:00' : granularity === 'month' ? 'yyyy-MM' : 'yyyy-MM-dd');
    groups.set(key, []); cursor = cursor.plus(granularity === 'hour' ? { hours: 1 } : granularity === 'month' ? { months: 1 } : { days: 1 });
  }
  for (const event of events) {
    const key = DateTime.fromJSDate(event.createdAt, { zone: range.timezone }).toFormat(granularity === 'hour' ? 'yyyy-MM-dd HH:00' : granularity === 'month' ? 'yyyy-MM' : 'yyyy-MM-dd');
    const group = groups.get(key) ?? []; group.push(event); groups.set(key, group);
  }
  return [...groups.entries()].map(([date, group]) => ({ date, ...financials(group) }));
}

reportsRouter.get('/reports/dashboard', async (req, res) => {
  const range = await rangeFor(req.query, 1);
  const data = await tx(async t => {
    const [events, ingredients, pendingPurchases, waste] = await Promise.all([
      t.payment.findMany({ where: { createdAt: between(range) }, include: paymentsInclude, orderBy: { createdAt: 'asc' } }),
      t.ingredient.findMany({ where: { active: true }, select: { onHand: true, reserved: true, minimumStock: true } }),
      t.purchaseOrder.count({ where: { status: { in: ['ORDERED', 'PARTIAL'] } } }),
      t.wasteRecord.aggregate({ where: { status: 'APPROVED', approvedAt: between(range) }, _sum: { estimatedCost: true } }),
    ]);
    const recentOrders = await t.order.findMany({ where: { payments: { some: { createdAt: between(range) } } }, orderBy: { updatedAt: 'desc' }, take: 8, select: { id: true, number: true, status: true, subtotal: true, discount: true, tax: true, total: true, estimatedCost: true, createdAt: true, updatedAt: true } });
    const salesSeries = salesBuckets(events, range, range.from === range.to ? 'hour' : 'day').map(row => ({ date: row.date, label: range.from === range.to ? row.date.slice(11) : row.date, sales: row.sales, value: Number(row.sales) }));
    return { from: range.from, to: range.to, timezone: range.timezone, ...financials(events), lowStockCount: ingredients.filter(item => item.onHand.minus(item.reserved).lte(item.minimumStock)).length, pendingPurchases, wasteCost: money(waste._sum.estimatedCost ?? zero()), bestSellers: itemRows(events).slice(0, 5), salesSeries, recentOrders, definitions: [...salesDefinitions, 'Low-stock and pending-purchase counts are current snapshots. Waste cost includes approvals in the selected interval.'] };
  });
  res.json({ data });
});

reportsRouter.get('/reports/:type', async (req, res) => {
  const type = reportTypes.parse(req.params.type);
  const query = z.object({ from: z.string().optional(), to: z.string().optional(), format: z.enum(['json', 'csv']).optional(), granularity: z.enum(['day', 'month']).optional() }).parse(req.query);
  const range = await rangeFor(query, 30), page = pagination(req);
  const report = await tx(async t => {
    let rows: ReportRow[] = [], columns: string[] = [], definitions: string[] = [];
    let summary: ReportRow = {};
    if (type === 'sales' || type === 'items' || type === 'hourly') {
      const events = await t.payment.findMany({ where: { createdAt: between(range) }, include: paymentsInclude, orderBy: { createdAt: 'asc' } });
      summary = financials(events); definitions = salesDefinitions;
      if (type === 'sales') {
        columns = ['date', 'orderCount', 'sales', 'tax', 'collected', 'refunds', 'estimatedCogs', 'grossProfit'];
        rows = salesBuckets(events, range, query.granularity ?? 'day');
      } else if (type === 'items') {
        columns = ['menuItemId', 'name', 'quantity', 'sales', 'estimatedCogs', 'grossProfit']; rows = itemRows(events);
        definitions = [...definitions, 'Quantity is the paid/refunded fraction of ordered quantity. Names and costs use historical order-line snapshots.'];
      } else {
        columns = ['date', 'orderCount', 'sales', 'tax', 'collected', 'refunds', 'estimatedCogs', 'grossProfit']; rows = salesBuckets(events, range, 'hour');
      }
    } else if (type === 'consumption') {
      const movements = await t.inventoryMovement.findMany({ where: { type: 'CONSUMPTION', createdAt: between(range) }, include: { ingredient: true } });
      const groups = new Map<string, { name: string; unit: string; quantity: InstanceType<typeof Decimal>; cost: InstanceType<typeof Decimal> }>();
      for (const movement of movements) {
        const row = groups.get(movement.ingredientId) ?? { name: movement.ingredient.name, unit: movement.ingredient.unit, quantity: zero(), cost: zero() };
        row.quantity = row.quantity.minus(movement.quantity); row.cost = row.cost.minus(movement.quantity.mul(movement.unitCost)); groups.set(movement.ingredientId, row);
      }
      rows = [...groups].map(([ingredientId, row]) => ({ ingredientId, ingredient: row.name, unit: row.unit, quantity: row.quantity.toString(), cost: money(row.cost) }));
      columns = ['ingredientId', 'ingredient', 'unit', 'quantity', 'cost']; summary = { consumptionCost: money(movements.reduce((sum, row) => sum.minus(row.quantity.mul(row.unitCost)), zero())) };
      definitions = ['Physical ingredient consumption uses immutable CONSUMPTION ledger movements in the date range, including preparation for subsequently cancelled orders. Cost uses the movement unit-cost snapshot.'];
    } else if (type === 'valuation' || type === 'reorder') {
      const ingredients = await t.ingredient.findMany({ where: { active: true }, include: { preferredSupplier: true }, orderBy: { name: 'asc' } });
      if (type === 'valuation') {
        rows = ingredients.map(item => ({ ingredientId: item.id, ingredient: item.name, unit: item.unit, onHand: item.onHand.toString(), reserved: item.reserved.toString(), available: item.onHand.minus(item.reserved).toString(), unitCost: item.unitCost.toString(), value: money(item.onHand.mul(item.unitCost)) }));
        columns = ['ingredientId', 'ingredient', 'unit', 'onHand', 'reserved', 'available', 'unitCost', 'value'];
        summary = { inventoryValue: money(ingredients.reduce((sum, item) => sum.plus(item.onHand.mul(item.unitCost)), zero())), asOf: new Date().toISOString() };
        definitions = ['Current inventory valuation is on-hand quantity times current weighted-average unit cost. Reservations remain part of on-hand value. Date filters do not reconstruct historical inventory balances.'];
      } else {
        const forecastEnd = range.end < new Date() ? range.end : new Date();
        const forecastStart = DateTime.fromJSDate(forecastEnd).minus({ days: 30 }).toJSDate();
        const history = await t.inventoryMovement.findMany({ where: { type: 'CONSUMPTION', createdAt: { gte: forecastStart, lt: forecastEnd } }, select: { ingredientId: true, quantity: true, createdAt: true } });
        rows = ingredients.map(item => {
          const movements = history.filter(row => row.ingredientId === item.id);
          const days = new Set(movements.map(row => DateTime.fromJSDate(row.createdAt, { zone: range.timezone }).toISODate())).size;
          const consumed = movements.reduce((sum, row) => sum.minus(row.quantity), zero()), daily = consumed.div(30);
          const available = item.onHand.minus(item.reserved), sufficient = days >= 3;
          const target = Decimal.max(item.minimumStock, sufficient ? daily.mul(7) : item.minimumStock);
          const reorder = Decimal.max(0, target.minus(available)).toDecimalPlaces(6);
          return { ingredientId: item.id, ingredient: item.name, unit: item.unit, onHand: item.onHand.toString(), available: available.toString(), minimumStock: item.minimumStock.toString(), lowStock: available.lte(item.minimumStock), dailyConsumptionEstimate: sufficient ? daily.toDecimalPlaces(6).toString() : null, daysRemainingEstimate: sufficient && daily.gt(0) ? available.div(daily).toDecimalPlaces(1).toString() : null, suggestedReorder: reorder.toString(), supplier: item.preferredSupplier?.name ?? null, forecastStatus: sufficient ? 'ESTIMATE' : 'INSUFFICIENT_HISTORY' };
        });
        columns = ['ingredientId', 'ingredient', 'unit', 'onHand', 'available', 'minimumStock', 'lowStock', 'dailyConsumptionEstimate', 'daysRemainingEstimate', 'suggestedReorder', 'supplier', 'forecastStatus'];
        summary = { lowStockCount: rows.filter(row => row.lowStock).length, forecastFrom: forecastStart.toISOString(), forecastTo: forecastEnd.toISOString(), observationDays: 30, targetDays: 7 };
        definitions = ['Available stock is current on-hand less reservations. The estimate averages actual consumption over 30 calendar days ending at the selected end date or now, whichever is earlier.', 'At least three distinct consumption dates are required for a demand estimate. Suggested reorder targets the greater of minimum stock and seven days of estimated consumption. With insufficient history it only replenishes the minimum. This is a rule-based estimate, not AI.'];
      }
    } else if (type === 'movements') {
      const movements = await t.inventoryMovement.findMany({ where: { createdAt: between(range) }, include: { ingredient: true, actor: { select: { name: true } } }, orderBy: { createdAt: 'desc' } });
      rows = movements.map(row => ({ id: row.id, createdAt: row.createdAt.toISOString(), ingredient: row.ingredient.name, unit: row.ingredient.unit, type: row.type, quantity: row.quantity.toString(), unitCost: row.unitCost.toString(), cost: money(row.quantity.mul(row.unitCost)), reason: row.reason, reference: row.reference, actor: row.actor.name }));
      columns = ['id', 'createdAt', 'ingredient', 'unit', 'type', 'quantity', 'unitCost', 'cost', 'reason', 'reference', 'actor']; summary = { movementCount: movements.length };
      definitions = ['All stock movements are immutable. Positive quantities add stock; negative quantities remove stock. Cost is signed quantity times its movement unit-cost snapshot.'];
    } else if (type === 'waste') {
      const records = await t.wasteRecord.findMany({ where: { createdAt: between(range) }, include: { ingredient: true, createdBy: { select: { name: true } }, approvedBy: { select: { name: true } } }, orderBy: { createdAt: 'desc' } });
      rows = records.map(row => ({ id: row.id, createdAt: row.createdAt.toISOString(), ingredient: row.ingredient.name, unit: row.ingredient.unit, quantity: row.quantity.toString(), reason: row.reason, estimatedCost: money(row.estimatedCost), status: row.status, recordedBy: row.createdBy.name, approvedBy: row.approvedBy?.name ?? null, approvedAt: row.approvedAt?.toISOString() ?? null }));
      columns = ['id', 'createdAt', 'ingredient', 'unit', 'quantity', 'reason', 'estimatedCost', 'status', 'recordedBy', 'approvedBy', 'approvedAt'];
      summary = { approvedWasteCost: money(records.filter(row => row.status === 'APPROVED').reduce((sum, row) => sum.plus(row.estimatedCost), zero())), pendingCount: records.filter(row => row.status === 'PENDING').length };
      definitions = ['Date filters select when waste was recorded. Pending waste is provisional and does not reduce stock; only approved waste contributes to approved waste cost. Approved estimated cost is valued at the inventory unit cost when approved.'];
    } else if (type === 'purchases') {
      const purchases = await t.purchaseOrder.findMany({ where: { OR: [{ createdAt: between(range) }, { receipts: { some: { createdAt: between(range) } } }] }, include: { supplier: true, items: true, receipts: { where: { createdAt: between(range) }, include: { items: true } } }, orderBy: { createdAt: 'desc' } });
      let actualCost = zero();
      rows = purchases.map(row => {
        const receivedCost = row.receipts.reduce((sum, receipt) => receipt.items.reduce((subtotal, item) => subtotal.plus(item.quantity.mul(item.unitCost)), sum), zero()); actualCost = actualCost.plus(receivedCost);
        return { id: row.id, number: row.number, createdAt: row.createdAt.toISOString(), supplier: row.supplier.name, status: row.status, expectedAt: row.expectedAt?.toISOString() ?? null, orderedCost: money(row.items.reduce((sum, item) => sum.plus(item.quantity.mul(item.unitCost)), zero())), receivedCost: money(receivedCost), receiptCount: row.receipts.length };
      });
      columns = ['id', 'number', 'createdAt', 'supplier', 'status', 'expectedAt', 'orderedCost', 'receivedCost', 'receiptCount']; summary = { receivedCost: money(actualCost), purchaseCount: purchases.length };
      definitions = ['Includes purchase orders created in the selected interval or having a receipt in that interval. Ordered cost is the whole purchase estimate. Received cost uses only actual receipt quantities/costs received in the selected interval, independent of ordered date.'];
    }
    return { type, from: range.from, to: range.to, timezone: range.timezone, columns, rows, summary, definitions };
  });
  if (query.format === 'csv') {
    res.setHeader('Content-Disposition', `attachment; filename="${type}-${range.from}-${range.to}.csv"`);
    res.type('text/csv; charset=utf-8').send(reportCsv(report.columns, report.rows)); return;
  }
  res.json({ data: { ...report, rows: report.rows.slice(page.skip, page.skip + page.take) }, pagination: { page: page.page, pageSize: page.pageSize, total: report.rows.length } });
});
