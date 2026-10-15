import { prisma, tx, notify, publish, Decimal } from './core.js';
import type { Role } from '@prisma/client';

export async function refreshOperationalNotifications() {
  const now = new Date();
  const start = new Date(now); start.setUTCHours(0, 0, 0, 0);
  const soon = new Date(now.getTime() + 7 * 86400000);
  const [ingredients, purchases] = await Promise.all([
    prisma.ingredient.findMany({ where: { active: true } }),
    prisma.purchaseOrder.findMany({ where: { status: { in: ['ORDERED', 'PARTIAL'] }, expectedAt: { lte: now } }, include: { supplier: true } }),
  ]);
  const alerts: { type: string; title: string; message: string; roles: Role[] }[] = [];
  for (const item of ingredients) {
    const available = new Decimal(item.onHand).minus(item.reserved);
    if (available.lte(item.minimumStock)) alerts.push({ type: 'LOW_STOCK', title: `${item.name} needs replenishment`, message: `${item.sku}: ${available.toString()} ${item.unit} available; minimum ${item.minimumStock.toString()} ${item.unit}.`, roles: ['OWNER', 'MANAGER', 'INVENTORY'] });
    if (item.expiresAt && item.expiresAt <= soon && item.onHand.gt(0)) alerts.push({ type: 'EXPIRING', title: `${item.name} expiry check`, message: `${item.sku}: recorded expiry ${item.expiresAt.toISOString().slice(0, 10)}. Check received batches before use.`, roles: ['OWNER', 'MANAGER', 'INVENTORY'] });
  }
  for (const order of purchases) alerts.push({ type: 'DELIVERY_DUE', title: `Purchase #${order.number} delivery due`, message: `${order.supplier.name} · expected ${order.expectedAt!.toISOString().slice(0, 10)}.`, roles: ['OWNER', 'MANAGER', 'INVENTORY'] });
  for (const alert of alerts) await tx(async t => {
    if (!await t.notification.findFirst({ where: { type: alert.type, message: alert.message, createdAt: { gte: start } } })) await notify(t, alert.type, alert.title, alert.message, alert.roles);
  });
  if (alerts.length) publish('notifications:changed', {}, ['OWNER', 'MANAGER', 'INVENTORY']);
}
