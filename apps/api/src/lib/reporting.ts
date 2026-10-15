import { DateTime } from 'luxon';
import { z } from 'zod';
import { Decimal, AppError } from './core.js';

export interface BusinessRange { from: string; to: string; timezone: string; start: Date; end: Date }
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export function businessDateRange(query: { from?: unknown; to?: unknown }, timezone: string, defaultDays = 1, now = new Date()): BusinessRange {
  const parsed = z.object({ from: date.optional(), to: date.optional() }).parse(query);
  const today = DateTime.fromJSDate(now, { zone: timezone });
  if (!today.isValid) throw new AppError(500, 'INVALID_TIMEZONE', 'The restaurant timezone is invalid.');
  const to = parsed.to ?? today.toISODate()!;
  const from = parsed.from ?? (parsed.to ? to : today.minus({ days: defaultDays - 1 }).toISODate()!);
  const start = DateTime.fromISO(from, { zone: timezone }).startOf('day');
  const last = DateTime.fromISO(to, { zone: timezone }).startOf('day');
  if (!start.isValid || !last.isValid || start.toISODate() !== from || last.toISODate() !== to) throw new AppError(400, 'INVALID_DATE', 'Use real business dates in YYYY-MM-DD format.');
  if (last < start) throw new AppError(400, 'INVALID_DATE_RANGE', 'The end date must be on or after the start date.');
  if (last.diff(start, 'days').days > 365) throw new AppError(400, 'DATE_RANGE_TOO_LARGE', 'Select at most 366 business dates per report.');
  return { from, to, timezone, start: start.toUTC().toJSDate(), end: last.plus({ days: 1 }).toUTC().toJSDate() };
}
export type ReportCell = string | number | boolean | null;
export type ReportRow = Record<string, ReportCell>;
export function reportCsv(columns: string[], rows: ReportRow[]): string {
  const quote = (cell: ReportCell | undefined): string => {
    let value = cell === null || cell === undefined ? '' : String(cell);
    // A quoted CSV field can still execute a formula in spreadsheets. Escape formula markers.
    if (typeof cell === 'string' && (/^\s*[=+\-@]/.test(value) || /^[\t\r\n]/.test(value))) value = `'${value}`;
    return `"${value.replace(/"/g, '""')}"`;
  };
  return [columns.map(quote).join(','), ...rows.map(row => columns.map(column => quote(row[column])).join(','))].join('\r\n');
}
export interface PaymentEvent {
  id: string; type: 'PAYMENT' | 'REFUND'; amount: InstanceType<typeof Decimal>; createdAt: Date;
  order: {
    id: string; number: number; subtotal: InstanceType<typeof Decimal>; discount: InstanceType<typeof Decimal>;
    tax: InstanceType<typeof Decimal>; total: InstanceType<typeof Decimal>; estimatedCost: InstanceType<typeof Decimal>;
    status: string; createdAt: Date;
    payments?: { id: string; type: 'PAYMENT' | 'REFUND'; amount: InstanceType<typeof Decimal>; createdAt: Date }[];
    items: { menuItemId: string; name: string; quantity: number; unitPrice: InstanceType<typeof Decimal>; estimatedUnitCost: InstanceType<typeof Decimal> }[];
  };
}
export function allocatedEvent(event: PaymentEvent) {
  const sign = event.type === 'REFUND' ? -1 : 1;
  const amount = event.amount.mul(sign);
  if (event.order.total.lte(0)) return { sales: new Decimal(0), tax: new Decimal(0), cost: new Decimal(0), ratio: new Decimal(0), amount };
  const ratio = amount.div(event.order.total);
  // Cumulative allocation makes split payments reconcile exactly to the original order,
  // even when an earlier payment falls outside the selected report dates.
  const capturedBefore = (event.order.payments ?? []).filter(payment => payment.createdAt < event.createdAt || (+payment.createdAt === +event.createdAt && payment.id < event.id)).reduce((sum, payment) => sum.plus(payment.type === 'REFUND' ? payment.amount.negated() : payment.amount), new Decimal(0));
  const beforeRatio = capturedBefore.div(event.order.total), afterRatio = capturedBefore.plus(amount).div(event.order.total);
  const orderSales = event.order.subtotal.minus(event.order.discount);
  const sales = orderSales.mul(afterRatio).toDecimalPlaces(2).minus(orderSales.mul(beforeRatio).toDecimalPlaces(2));
  const cost = event.order.estimatedCost.mul(afterRatio).toDecimalPlaces(2).minus(event.order.estimatedCost.mul(beforeRatio).toDecimalPlaces(2));
  // Allocate the rounding remainder to tax so sales + tax always reconciles to captured cash.
  return { sales, tax: amount.minus(sales), cost, ratio, amount };
}
export const salesDefinitions = [
  'Cash-basis sales use payment and refund timestamps in the configured business timezone; unpaid orders do not contribute revenue.',
  'Sales exclude tax and include order discounts. Refunds reduce sales and tax using the original order proportions. Collected is gross payment records; refunds are reported separately.',
  'Estimated COGS allocates the historical order recipe-cost snapshot in proportion to net captured payment; refunds proportionally reverse this financial estimate. Actual physical consumption remains in the stock ledger.',
  'Estimated gross profit is sales minus estimated COGS; operating expenses are excluded, so it is not net profit.',
  'Order count is distinct orders with a positive payment in the selected interval; average order value is net sales divided by this count.',
];
export const money = (value: InstanceType<typeof Decimal>) => value.toFixed(2);
