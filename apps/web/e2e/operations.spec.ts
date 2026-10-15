import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { expect, test, type APIRequestContext, type Page, type Response } from '@playwright/test';

const Decimal = Prisma.Decimal;
const password = process.env.DEMO_PASSWORD;
if (!password) throw new Error('DEMO_PASSWORD must be injected by the disposable browser-test runner.');
type Role = 'owner' | 'cashier' | 'kitchen' | 'inventory';
interface Ingredient { id: string; name: string; sku: string; unit: string; onHand: string; reserved: string; unitCost: string }
interface MenuItem { id: string; name: string; price: string; recipe: { versions: { ingredients: { ingredientId: string; quantity: string }[] }[] } }
interface Order { id: string; number: number; status: string; subtotal: string; discount: string; tax: string; total: string; estimatedCost: string; items: { id: string; name: string; quantity: number; preparedQuantity: number }[]; payments: { amount: string; type: string }[] }
interface Dashboard { sales: string; tax: string; collected: string; estimatedCogs: string; orderCount: number }

async function data<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(`/api${path}`);
  expect(response.ok(), `GET ${path}: HTTP ${response.status()} ${response.ok() ? '' : await response.text()}`).toBe(true);
  return (await response.json() as { data: T }).data;
}
async function login(page: Page, role: Role) {
  await page.goto('/');
  await page.getByLabel('Email address', { exact: true }).fill(`${role}@newkarachi.test`);
  await page.getByLabel('Password', { exact: true }).fill(password!);
  await page.getByRole('button', { name: 'Sign in to workspace' }).click();
  // The submit button changes its label while the login request is pending.
  // Wait for the authenticated workspace before reading its persisted session.
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Sign out' }).first()).toBeVisible();
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in to workspace' })).toBeHidden();
}
function posted(page: Page, path: string): Promise<Response> {
  return page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api${path}`);
}
function ingredientBySku(rows: Ingredient[], sku: string) {
  const ingredient = rows.find(row => row.sku === sku);
  expect(ingredient, `Seed must contain ${sku}`).toBeDefined();
  return ingredient!;
}

test.describe('complete restaurant operations', () => {
  test.describe.configure({ mode: 'default' });

  test('counter payment, kitchen preparation and order completion reconcile stock, receipt and sales', async ({ page, browser, baseURL }) => {
    const kitchenContext = await browser.newContext({ baseURL });
    const kitchenPage = await kitchenContext.newPage();
    try {
    await login(kitchenPage, 'kitchen');
    await expect(kitchenPage.getByText('Live updates', { exact: true })).toBeVisible();
    await login(page, 'owner');
    const baseline = await data<Dashboard>(page.request, '/reports/dashboard');
    const before = await data<Ingredient[]>(page.request, '/ingredients?pageSize=100');
    const menu = await data<MenuItem[]>(page.request, '/menu?pageSize=100');
    const burger = menu.find(item => item.name === 'Chicken Burger');
    expect(burger).toBeDefined();
    const marker = `Browser counter ${randomUUID()}`;

    await page.getByRole('link', { name: 'Point of sale', exact: true }).click();
    await page.getByLabel('Find menu item').fill('Chicken Burger');
    await page.getByRole('button').filter({ has: page.getByText('Chicken Burger', { exact: true }) }).click();
    await page.getByRole('button', { name: 'Increase Chicken Burger', exact: true }).click();
    await page.getByLabel('Notes for Chicken Burger', { exact: true }).fill('No extra sauce; browser kitchen check');
    await page.getByText('Customer & order details', { exact: true }).click();
    await page.getByLabel('Customer name (optional)', { exact: true }).fill(marker);
    await page.getByLabel('Order notes', { exact: true }).fill('Browser service journey');
    const creation = posted(page, '/orders');
    await page.getByRole('button', { name: 'Confirm & send to kitchen' }).click();
    const created = await creation; expect(created.status()).toBe(201);
    const order = (await created.json() as { data: Order }).data;
    expect(order.status).toBe('CONFIRMED'); expect(order.items[0]!.quantity).toBe(2);
    const dialog = page.getByRole('dialog', { name: `Order #${String(order.number).padStart(4, '0')}` });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('confirmed', { exact: true })).toBeVisible();
    await expect(dialog.getByLabel('Amount · PKR', { exact: true })).toHaveValue(new Decimal(order.total).toFixed(2));
    const payment = posted(page, `/orders/${order.id}/payments`);
    await dialog.getByRole('button', { name: 'Record payment', exact: true }).click();
    expect((await payment).status()).toBe(201);
    await expect(dialog.getByText('Payment recorded.', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Close order' }).click();

    // Confirmation reserves stock; actual preparation performs the single physical deduction.
    const reserved = await data<Ingredient[]>(page.request, '/ingredients?pageSize=100');
    for (const line of burger!.recipe.versions[0]!.ingredients) {
      const original = before.find(item => item.id === line.ingredientId)!;
      const current = reserved.find(item => item.id === line.ingredientId)!;
      expect(current.onHand).toBe(original.onHand);
      expect(new Decimal(current.reserved).minus(original.reserved).eq(new Decimal(line.quantity).mul(2))).toBe(true);
    }
    // This kitchen tab was already open before POS submission. A socket event must
    // make its new ticket appear without navigation or a manual reload.
    const ticket = kitchenPage.getByRole('article').filter({ has: kitchenPage.getByRole('heading', { name: `#${String(order.number).padStart(4, '0')}`, exact: true }) });
    await expect(ticket.getByText(marker, { exact: true })).toBeVisible();
    await expect(ticket.getByText('No extra sauce; browser kitchen check', { exact: true })).toBeVisible();
    const prepare = posted(kitchenPage, `/orders/${order.id}/status`);
    await ticket.getByRole('button', { name: 'Start preparation' }).click();
    expect((await prepare).status()).toBe(200);
    const ready = posted(kitchenPage, `/orders/${order.id}/items/${order.items[0]!.id}/ready`);
    await ticket.getByRole('button', { name: `Mark Chicken Burger ready for order ${order.number}`, exact: true }).click();
    expect((await ready).status()).toBe(200);
    await expect(ticket.getByText('Ready for collection', { exact: true })).toBeVisible();
    await expect(ticket.getByText('2 / 2 prepared', { exact: true })).toBeVisible();

    await page.getByRole('link', { name: 'Orders', exact: true }).click();
    await page.getByRole('row').filter({ hasText: marker }).getByRole('button', { name: 'View order' }).click();
    const complete = posted(page, `/orders/${order.id}/status`);
    await dialog.getByRole('button', { name: 'Complete order', exact: true }).click();
    expect((await complete).status()).toBe(200);
    await expect(dialog.getByText('completed', { exact: true })).toBeVisible();
    await page.evaluate(() => { window.print = () => {}; });
    const printed = page.waitForResponse(response => new URL(response.url()).pathname === `/api/orders/${order.id}/receipt`);
    await dialog.getByRole('button', { name: 'Print receipt', exact: true }).click();
    const receipt = (await (await printed).json()).data as { number: number; total: string; netPaid: string };
    expect(receipt).toMatchObject({ number: order.number, total: order.total, netPaid: order.total });

    const after = await data<Ingredient[]>(page.request, '/ingredients?pageSize=100');
    for (const line of burger!.recipe.versions[0]!.ingredients) {
      const original = before.find(item => item.id === line.ingredientId)!;
      const current = after.find(item => item.id === line.ingredientId)!;
      expect(new Decimal(original.onHand).minus(current.onHand).eq(new Decimal(line.quantity).mul(2))).toBe(true);
      expect(current.reserved).toBe(original.reserved);
    }
    const persisted = await data<Order>(page.request, `/orders/${order.id}`);
    expect(persisted.status).toBe('COMPLETED'); expect(persisted.payments).toHaveLength(1);
    const movements = await data<{ orderId: string; type: string }[]>(page.request, '/inventory/movements?type=CONSUMPTION&pageSize=100');
    expect(movements.filter(movement => movement.orderId === order.id)).toHaveLength(burger!.recipe.versions[0]!.ingredients.length);
    const dashboard = await data<Dashboard>(page.request, '/reports/dashboard');
    expect(new Decimal(dashboard.sales).minus(baseline.sales).eq(new Decimal(order.subtotal).minus(order.discount))).toBe(true);
    expect(new Decimal(dashboard.tax).minus(baseline.tax).eq(order.tax)).toBe(true);
    expect(new Decimal(dashboard.collected).minus(baseline.collected).eq(order.total)).toBe(true);
    expect(new Decimal(dashboard.estimatedCogs).minus(baseline.estimatedCogs).eq(order.estimatedCost)).toBe(true);
    expect(dashboard.orderCount).toBe(baseline.orderCount + 1);
    } finally { await kitchenContext.close(); }
  });

  test('supplier ordering, a partial delivery and approved waste update real stock and preserve history', async ({ page }) => {
    await login(page, 'owner');
    const marker = randomUUID();
    const supplierName = `Browser produce ${marker}`;
    const original = ingredientBySku(await data<Ingredient[]>(page.request, '/ingredients?pageSize=100'), 'DEMO-POTATO');
    await page.getByRole('link', { name: 'Purchasing', exact: true }).click();
    await page.getByRole('button', { name: 'Add supplier', exact: true }).click();
    await page.getByLabel('Supplier name', { exact: true }).fill(supplierName);
    await page.getByLabel('Contact person', { exact: true }).fill('Browser receiving desk');
    await page.getByLabel('Email', { exact: true }).fill(`browser-${marker}@example.test`);
    const supplierRequest = posted(page, '/suppliers');
    await page.getByRole('button', { name: 'Add supplier', exact: true }).click();
    const supplierResponse = await supplierRequest; expect(supplierResponse.status()).toBe(201);
    const supplier = (await supplierResponse.json()).data as { id: string };
    await expect(page.getByRole('row').filter({ hasText: supplierName })).toBeVisible();
    await page.getByRole('button', { name: 'New purchase order', exact: true }).click();
    await page.getByRole('combobox', { name: 'Supplier', exact: true }).selectOption(supplier.id);
    await page.getByRole('combobox', { name: 'Ingredient', exact: true }).selectOption(original.id);
    await page.getByLabel('Quantity', { exact: true }).fill('1000');
    await page.getByRole('combobox', { name: 'Quantity unit', exact: true }).selectOption('G');
    await page.getByLabel(/^Quoted cost per/).fill('0.25');
    await page.getByLabel('Purchase notes', { exact: true }).fill(`Browser partial delivery ${marker}`);
    const purchaseRequest = posted(page, '/purchases');
    await page.getByRole('button', { name: 'Create draft purchase order', exact: true }).click();
    const purchaseResponse = await purchaseRequest; expect(purchaseResponse.status()).toBe(201);
    const purchase = (await purchaseResponse.json()).data as { id: string; number: number };
    const detail = page.locator('.ops-panel').filter({ has: page.getByRole('heading', { name: `Purchase order #${purchase.number}`, exact: true }) });
    await expect(detail).toBeVisible();
    const ordered = posted(page, `/purchases/${purchase.id}/status`);
    await detail.getByRole('button', { name: 'Mark ordered', exact: true }).click();
    expect((await ordered).status()).toBe(200);
    const invoice = `Browser invoice ${marker}`;
    await detail.getByLabel('Supplier invoice reference', { exact: true }).fill(invoice);
    await detail.getByLabel(`Received quantity · ${original.name}`, { exact: true }).fill('0.25');
    await detail.getByRole('combobox', { name: `Receipt unit · ${original.name}`, exact: true }).selectOption('KG');
    await expect(detail.getByLabel(/^Actual cost per KG/)).toHaveValue('250');
    await detail.getByLabel(/^Actual cost per/).fill('300');
    const receiptRequest = posted(page, `/purchases/${purchase.id}/receipts`);
    await detail.getByRole('button', { name: 'Record goods receipt', exact: true }).click();
    expect((await receiptRequest).status()).toBe(201);
    await expect(detail.getByText('partial', { exact: true })).toBeVisible();
    await expect(detail.getByText(invoice, { exact: true })).toBeVisible();
    const received = ingredientBySku(await data<Ingredient[]>(page.request, '/ingredients?pageSize=100'), 'DEMO-POTATO');
    expect(new Decimal(received.onHand).minus(original.onHand).eq('250')).toBe(true);
    const expectedCost = new Decimal(original.onHand).mul(original.unitCost).plus('75').div(new Decimal(original.onHand).plus(250)).toDecimalPlaces(6);
    expect(new Decimal(received.unitCost).eq(expectedCost)).toBe(true);

    await detail.getByLabel('Supplier invoice reference', { exact: true }).fill(`Browser excess ${marker}`);
    await detail.getByLabel(`Received quantity · ${original.name}`, { exact: true }).fill('751');
    const excess = posted(page, `/purchases/${purchase.id}/receipts`);
    await detail.getByRole('button', { name: 'Record goods receipt', exact: true }).click();
    expect((await excess).status()).toBe(409);
    await expect(detail.getByRole('alert').filter({ hasText: 'Receipt exceeds the remaining quantity' })).toBeVisible();
    await detail.getByRole('button', { name: 'Cancel remaining order', exact: true }).click();
    const cancel = posted(page, `/purchases/${purchase.id}/status`);
    await detail.getByRole('button', { name: 'Confirm cancellation', exact: true }).click();
    expect((await cancel).status()).toBe(200);
    await expect(detail.getByText('cancelled', { exact: true })).toBeVisible();
    await expect(detail.getByText(invoice, { exact: true })).toBeVisible();

    await page.getByRole('link', { name: 'Waste & losses', exact: true }).click();
    await page.getByRole('combobox', { name: 'Wasted ingredient', exact: true }).selectOption(original.id);
    await page.getByLabel('Wasted quantity', { exact: true }).fill('5');
    await page.getByRole('combobox', { name: 'Waste quantity unit', exact: true }).selectOption('G');
    const reason = `Damaged during browser delivery ${marker}`;
    await page.getByLabel('Reason for waste', { exact: true }).fill(reason);
    const wasteRequest = posted(page, '/waste');
    await page.getByRole('button', { name: 'Submit waste record', exact: true }).click();
    const wasteResponse = await wasteRequest; expect(wasteResponse.status()).toBe(201);
    const waste = (await wasteResponse.json()).data as { id: string };
    const wasteRow = page.getByRole('row').filter({ hasText: reason });
    await expect(wasteRow.getByText('pending', { exact: true })).toBeVisible();
    expect(ingredientBySku(await data<Ingredient[]>(page.request, '/ingredients?pageSize=100'), 'DEMO-POTATO').onHand).toBe(received.onHand);
    await wasteRow.getByRole('button', { name: `Review waste of ${original.name}`, exact: true }).click();
    const approval = posted(page, `/waste/${waste.id}/approve`);
    await page.getByRole('button', { name: 'Approve & deduct stock', exact: true }).click();
    expect((await approval).status()).toBe(200);
    await expect(wasteRow.getByText('approved', { exact: true })).toBeVisible();
    const final = ingredientBySku(await data<Ingredient[]>(page.request, '/ingredients?pageSize=100'), 'DEMO-POTATO');
    expect(new Decimal(received.onHand).minus(final.onHand).eq('5')).toBe(true);
    const purchaseReport = await data<{ rows: { id: string; receivedCost: string; status: string }[] }>(page.request, '/reports/purchases?pageSize=100');
    expect(purchaseReport.rows).toContainEqual(expect.objectContaining({ id: purchase.id, receivedCost: '75.00', status: 'CANCELLED' }));
    const wasteReport = await data<{ rows: { id: string; status: string; estimatedCost: string }[] }>(page.request, '/reports/waste?pageSize=100');
    expect(wasteReport.rows).toContainEqual(expect.objectContaining({ id: waste.id, status: 'APPROVED', estimatedCost: expectedCost.mul(5).toFixed(2) }));
  });

  for (const role of ['cashier', 'kitchen', 'inventory'] as const) {
    test(`${role} navigation and direct API requests enforce administrative and financial boundaries`, async ({ page }) => {
      await login(page, role);
      const home = role === 'cashier' ? '/pos' : role === 'kitchen' ? '/kitchen' : '/inventory';
      await expect(page).toHaveURL(home);
      await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Team members', exact: true })).toHaveCount(0);
      await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Reports', exact: true })).toHaveCount(0);
      await page.goto('/team'); await expect(page).toHaveURL(home);
      await expect(page.getByRole('button', { name: 'Add team member', exact: true })).toHaveCount(0);
      for (const endpoint of ['/users', '/audit', '/reports/dashboard']) {
        const response = await page.request.get(`/api${endpoint}`); expect(response.status()).toBe(403);
        expect((await response.json()).error.code).toBe('FORBIDDEN');
      }
      const auth = await data<{ csrfToken: string }>(page.request, '/auth/me');
      const write = await page.request.patch('/api/settings', { headers: { 'x-csrf-token': auth.csrfToken, 'Idempotency-Key': randomUUID() }, data: { name: 'Unauthorized change' } });
      expect(write.status()).toBe(403); expect((await write.json()).error.code).toBe('FORBIDDEN');
      if (role !== 'inventory') expect((await page.request.get('/api/ingredients')).status()).toBe(403);
      await page.reload(); await expect(page).toHaveURL(home);
      await expect(page.getByRole('button', { name: 'Sign in to workspace' })).toHaveCount(0);
    });
  }

  test('inventory navigation works by keyboard on a narrow screen without page overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, 'inventory');
    const trigger = page.getByRole('button', { name: 'Open navigation', exact: true });
    await trigger.focus(); await page.keyboard.press('Enter');
    const navigation = page.getByRole('dialog', { name: 'Workspace navigation' });
    await expect(navigation).toBeVisible();
    await page.keyboard.press('Escape'); await expect(navigation).not.toBeVisible(); await expect(trigger).toBeFocused();
    await page.keyboard.press('Enter');
    await navigation.getByRole('link', { name: 'Purchasing', exact: true }).click();
    await expect(navigation).not.toBeVisible(); await expect(page.getByRole('heading', { name: 'Purchasing & receiving', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await trigger.click(); await navigation.getByRole('link', { name: 'Waste & losses', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Wasted ingredient', exact: true })).toBeVisible();
    await page.getByLabel('Wasted quantity', { exact: true }).fill('1');
    await page.getByLabel('Reason for waste', { exact: true }).fill('Keyboard form check; left unsubmitted');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
