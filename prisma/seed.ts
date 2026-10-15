import 'dotenv/config';
import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { PrismaClient, Role, Unit } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

if (process.env.NODE_ENV === 'production') {
  throw new Error('Demo seeding is disabled in production. Provision production users through a separate secure process.');
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const demoPassword = process.env.DEMO_PASSWORD;
if (!demoPassword || demoPassword.length < 12 || Buffer.byteLength(demoPassword, 'utf8') > 72) {
  throw new Error('Set DEMO_PASSWORD in the ignored local .env: use at least 12 characters and at most 72 UTF-8 bytes. Never put passwords in source control.');
}

// Stable, cuid-shaped fixture identifiers make retries additive and reproducible.
const fixtureId = (name: string) => `c${createHash('sha256').update(`nk-development-demo:${name}`).digest('hex').slice(0, 24)}`;
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const accounts: { role: Role; name: string; email: string }[] = [
  { role: 'OWNER', name: 'Demo Owner', email: 'owner@newkarachi.test' },
  { role: 'MANAGER', name: 'Demo Manager', email: 'manager@newkarachi.test' },
  { role: 'CASHIER', name: 'Demo Cashier', email: 'cashier@newkarachi.test' },
  { role: 'KITCHEN', name: 'Demo Kitchen', email: 'kitchen@newkarachi.test' },
  { role: 'INVENTORY', name: 'Demo Inventory', email: 'inventory@newkarachi.test' },
];
const suppliers = [
  { key: 'fresh', name: 'Demo Karachi Fresh Foods', contactName: 'Demo Produce Desk', email: 'fresh@example.test', phone: '+92-21-5550-0101', address: 'Demo supplier · North Karachi' },
  { key: 'bakery', name: 'Demo Sunrise Bakery', contactName: 'Demo Bakery Desk', email: 'bakery@example.test', phone: '+92-21-5550-0102', address: 'Demo supplier · Federal B Area' },
  { key: 'pantry', name: 'Demo Metro Pantry Supply', contactName: 'Demo Wholesale Desk', email: 'pantry@example.test', phone: '+92-21-5550-0103', address: 'Demo supplier · Gulshan-e-Iqbal' },
];
type IngredientFixture = { sku: string; name: string; category: string; unit: Unit; opening: string; minimum: string; cost: string; supplier: string; storage: string };
const ingredients: IngredientFixture[] = [
  { sku: 'DEMO-BUN', name: 'Burger bun', category: 'Bakery', unit: 'PIECE', opening: '120', minimum: '30', cost: '35', supplier: 'bakery', storage: 'Keep sealed in a cool dry area.' },
  { sku: 'DEMO-CHICKEN-PATTY', name: 'Chicken patty', category: 'Protein', unit: 'PIECE', opening: '90', minimum: '20', cost: '145', supplier: 'fresh', storage: 'Keep frozen; thaw safely before cooking.' },
  { sku: 'DEMO-BEEF-PATTY', name: 'Beef patty', category: 'Protein', unit: 'PIECE', opening: '60', minimum: '15', cost: '180', supplier: 'fresh', storage: 'Keep frozen; avoid cross contamination.' },
  { sku: 'DEMO-CHEESE', name: 'Cheese slice', category: 'Dairy', unit: 'PIECE', opening: '120', minimum: '25', cost: '40', supplier: 'pantry', storage: 'Keep refrigerated.' },
  { sku: 'DEMO-LETTUCE', name: 'Lettuce', category: 'Produce', unit: 'G', opening: '5000', minimum: '1000', cost: '0.35', supplier: 'fresh', storage: 'Wash before use; keep refrigerated.' },
  { sku: 'DEMO-SAUCE', name: 'House burger sauce', category: 'Sauces', unit: 'G', opening: '6000', minimum: '1200', cost: '0.55', supplier: 'pantry', storage: 'Refrigerate after opening.' },
  { sku: 'DEMO-CHICKEN', name: 'Boneless chicken', category: 'Protein', unit: 'G', opening: '15000', minimum: '3000', cost: '0.95', supplier: 'fresh', storage: 'Keep chilled below 5°C or frozen.' },
  { sku: 'DEMO-BEEF-MINCE', name: 'Beef mince', category: 'Protein', unit: 'G', opening: '10000', minimum: '2000', cost: '1.1', supplier: 'fresh', storage: 'Keep chilled below 5°C or frozen.' },
  { sku: 'DEMO-BBQ-MARINADE', name: 'BBQ marinade', category: 'Sauces', unit: 'G', opening: '5000', minimum: '1000', cost: '0.65', supplier: 'pantry', storage: 'Refrigerate after opening.' },
  { sku: 'DEMO-PARATHA', name: 'Paratha', category: 'Bakery', unit: 'PIECE', opening: '100', minimum: '20', cost: '45', supplier: 'bakery', storage: 'Store frozen until needed.' },
  { sku: 'DEMO-ONION', name: 'Onion', category: 'Produce', unit: 'G', opening: '8000', minimum: '1500', cost: '0.12', supplier: 'fresh', storage: 'Store whole onions in a ventilated dry area.' },
  { sku: 'DEMO-MINT-CHUTNEY', name: 'Mint chutney', category: 'Sauces', unit: 'G', opening: '3000', minimum: '600', cost: '0.3', supplier: 'fresh', storage: 'Keep refrigerated.' },
  { sku: 'DEMO-POTATO', name: 'French fries potato', category: 'Produce', unit: 'G', opening: '20000', minimum: '4000', cost: '0.18', supplier: 'pantry', storage: 'Store frozen.' },
  { sku: 'DEMO-OIL', name: 'Cooking oil', category: 'Pantry', unit: 'ML', opening: '15000', minimum: '3000', cost: '0.5', supplier: 'pantry', storage: 'Keep tightly closed away from heat.' },
  { sku: 'DEMO-COLA', name: 'Cola can 330 ml', category: 'Beverages', unit: 'PIECE', opening: '96', minimum: '24', cost: '90', supplier: 'pantry', storage: 'Store in a cool dry area.' },
  { sku: 'DEMO-WATER', name: 'Water bottle 500 ml', category: 'Beverages', unit: 'PIECE', opening: '72', minimum: '18', cost: '35', supplier: 'pantry', storage: 'Keep away from direct sunlight.' },
];
const categories = ['Burgers', 'BBQ & Rolls', 'Sides', 'Drinks'];
const menu = [
  { key: 'chicken-burger', name: 'Chicken Burger', category: 'Burgers', price: '450', description: 'Juicy chicken patty, lettuce and our house sauce.', recipe: [['DEMO-BUN', '1'], ['DEMO-CHICKEN-PATTY', '1'], ['DEMO-LETTUCE', '15'], ['DEMO-SAUCE', '20']] },
  { key: 'cheese-burger', name: 'Chicken Cheese Burger', category: 'Burgers', price: '520', description: 'Our chicken burger with a melted cheese slice.', recipe: [['DEMO-BUN', '1'], ['DEMO-CHICKEN-PATTY', '1'], ['DEMO-CHEESE', '1'], ['DEMO-LETTUCE', '15'], ['DEMO-SAUCE', '20']] },
  { key: 'beef-burger', name: 'Beef Cheese Burger', category: 'Burgers', price: '580', description: 'Grilled beef patty, cheese, lettuce and house sauce.', recipe: [['DEMO-BUN', '1'], ['DEMO-BEEF-PATTY', '1'], ['DEMO-CHEESE', '1'], ['DEMO-LETTUCE', '15'], ['DEMO-SAUCE', '25']] },
  { key: 'chicken-tikka', name: 'Chicken Tikka Plate', category: 'BBQ & Rolls', price: '650', description: 'BBQ chicken with onion and mint chutney.', recipe: [['DEMO-CHICKEN', '250'], ['DEMO-BBQ-MARINADE', '35'], ['DEMO-ONION', '40'], ['DEMO-MINT-CHUTNEY', '25']] },
  { key: 'seekh-roll', name: 'Beef Seekh Roll', category: 'BBQ & Rolls', price: '380', description: 'Seasoned beef in a paratha with onion and chutney.', recipe: [['DEMO-BEEF-MINCE', '120'], ['DEMO-BBQ-MARINADE', '20'], ['DEMO-PARATHA', '1'], ['DEMO-ONION', '25'], ['DEMO-MINT-CHUTNEY', '20']] },
  { key: 'fries', name: 'Classic Fries', category: 'Sides', price: '220', description: 'A crisp golden portion of fries.', recipe: [['DEMO-POTATO', '180'], ['DEMO-OIL', '15']] },
  { key: 'cola', name: 'Cola 330 ml', category: 'Drinks', price: '140', description: 'Chilled cola can.', recipe: [['DEMO-COLA', '1']] },
  { key: 'water', name: 'Water 500 ml', category: 'Drinks', price: '70', description: 'Bottled drinking water.', recipe: [['DEMO-WATER', '1']] },
];

try {
  const settings = await prisma.restaurantSettings.findUnique({ where: { id: 'primary' } });
  if (settings && !settings.isDemo) {
    throw new Error('Refusing to mix demo fixtures into a restaurant not explicitly marked isDemo. Use a separate development database.');
  }
  const passwordHash = await bcrypt.hash(demoPassword, 12);
  await prisma.$transaction(async (db) => {
    await db.restaurantSettings.upsert({
      where: { id: 'primary' }, update: {},
      create: { id: 'primary', name: 'New Karachi Fast Food', currency: 'PKR', timezone: 'Asia/Karachi', taxRate: '0', isDemo: true },
    });
    const users = await Promise.all(accounts.map((account) => db.user.upsert({
      where: { email: account.email }, update: {},
      create: { id: fixtureId(`user:${account.role}`), ...account, passwordHash },
    })));
    const owner = users.find((user) => user.email === 'owner@newkarachi.test')!;
    const supplierIds = new Map<string, string>();
    for (const { key, ...supplier } of suppliers) {
      const created = await db.supplier.upsert({ where: { id: fixtureId(`supplier:${key}`) }, update: {}, create: { id: fixtureId(`supplier:${key}`), ...supplier } });
      supplierIds.set(key, created.id);
    }
    const ingredientIds = new Map<string, string>();
    for (const fixture of ingredients) {
      const existing = await db.ingredient.findUnique({ where: { sku: fixture.sku } });
      if (existing) {
        if (existing.unit !== fixture.unit) throw new Error(`Demo SKU ${fixture.sku} already uses an incompatible canonical unit. Existing records were preserved.`);
        ingredientIds.set(fixture.sku, existing.id);
        continue;
      }
      const ingredient = await db.ingredient.create({ data: {
        id: fixtureId(`ingredient:${fixture.sku}`), name: fixture.name, sku: fixture.sku,
        category: fixture.category, unit: fixture.unit, onHand: fixture.opening,
        minimumStock: fixture.minimum, unitCost: fixture.cost,
        preferredSupplierId: supplierIds.get(fixture.supplier), storageNotes: fixture.storage,
      } });
      await db.inventoryMovement.create({ data: {
        id: fixtureId(`opening:${fixture.sku}`), ingredientId: ingredient.id, type: 'OPENING',
        quantity: fixture.opening, unitCost: fixture.cost, reason: 'DEMO: development opening inventory',
        reference: 'development-demo-v1', actorId: owner.id,
      } });
      ingredientIds.set(fixture.sku, ingredient.id);
    }
    const categoryIds = new Map<string, string>();
    for (const [sortOrder, name] of categories.entries()) {
      const category = await db.menuCategory.upsert({ where: { name }, update: {}, create: { id: fixtureId(`category:${name}`), name, sortOrder } });
      categoryIds.set(name, category.id);
    }
    for (const item of menu) {
      const menuItem = await db.menuItem.upsert({
        where: { id: fixtureId(`menu:${item.key}`) }, update: {},
        create: { id: fixtureId(`menu:${item.key}`), categoryId: categoryIds.get(item.category)!, name: item.name, price: item.price, description: item.description },
      });
      const recipe = await db.recipe.upsert({ where: { menuItemId: menuItem.id }, update: {}, create: { id: fixtureId(`recipe:${item.key}`), menuItemId: menuItem.id } });
      const existingVersion = await db.recipeVersion.findUnique({ where: { recipeId_version: { recipeId: recipe.id, version: 1 } } });
      if (!existingVersion) {
        await db.recipeVersion.create({ data: {
          id: fixtureId(`recipe-version:${item.key}:1`), recipeId: recipe.id, version: 1, createdById: owner.id,
          ingredients: { create: item.recipe.map(([sku, quantity]) => ({ id: fixtureId(`recipe-ingredient:${item.key}:${sku}`), ingredientId: ingredientIds.get(sku!)!, quantity: quantity! })) },
        } });
      }
    }
    const seedAuditId = fixtureId('seed-audit:v1');
    if (!await db.auditLog.findUnique({ where: { id: seedAuditId } })) {
      await db.auditLog.create({ data: { id: seedAuditId, actorId: owner.id, action: 'DEMO_SEED_CREATED', entityType: 'DevelopmentFixture', entityId: 'development-demo-v1', details: { demo: true, note: 'Sample catalog and opening stock only; no fabricated sales.' } } });
    }
  }, { timeout: 60_000 });
  console.log('Development demo fixtures are ready: five role accounts, three suppliers, sixteen ingredients, eight menu items and versioned recipes.');
  console.log('Use the account emails documented in docs/database.md with your local DEMO_PASSWORD. Existing users, credentials, settings and balances were preserved.');
} finally {
  await prisma.$disconnect();
}
