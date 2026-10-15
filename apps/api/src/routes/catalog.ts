import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { AppError, Decimal, audit, pagination, prisma, publish, quantity, requireRoles, tx } from '../lib/core.js';

export const catalogRouter = Router();
const everyone = ['OWNER', 'MANAGER', 'CASHIER', 'KITCHEN', 'INVENTORY'] as const;
const operators = ['OWNER', 'MANAGER', 'INVENTORY'] as const;
const decimal = z.string().regex(/^\d{1,12}(\.\d{1,6})?$/, 'Use a nonnegative decimal string with at most six decimal places.');
const money = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, 'Use a nonnegative money string with at most two decimal places.');
const unit = z.enum(['G', 'KG', 'ML', 'L', 'PIECE']);
const identifier = z.string().min(1).max(100);
const categoryInput = z.object({ name: z.string().trim().min(1).max(120), sortOrder: z.number().int().min(0).max(10000).optional(), active: z.boolean().optional() }).strict();
const menuInput = z.object({ categoryId: identifier, name: z.string().trim().min(1).max(160), description: z.string().trim().max(2000).nullable().optional(), imageUrl: z.url().max(2000).refine(value => /^https?:\/\//i.test(value), 'Image URL must use HTTP or HTTPS.').nullable().optional(), price: money, active: z.boolean().optional() }).strict();
const ingredientInput = z.object({ name: z.string().trim().min(1).max(160), sku: z.string().trim().min(1).max(80).transform(value => value.toUpperCase()), category: z.string().trim().min(1).max(120), unit: z.enum(['G', 'ML', 'PIECE']), minimumStock: decimal.optional(), unitCost: decimal.optional(), preferredSupplierId: identifier.nullable().optional(), expiresAt: z.iso.datetime().nullable().optional(), storageNotes: z.string().trim().max(2000).nullable().optional(), active: z.boolean().optional() }).strict();
const recipeInput = z.object({ ingredients: z.array(z.object({ ingredientId: identifier, quantity: decimal.refine(value => new Decimal(value).gt(0), 'Recipe quantity must be positive.'), unit }).strict()).min(1).max(100) }).strict();
const latestRecipe = { versions: { orderBy: { version: 'desc' as const }, take: 1, include: { ingredients: { include: { ingredient: true } } } } };

function decorateMenu<T extends { price: { toString(): string }; active: boolean; category: { active: boolean }; recipe: { versions: { ingredients: Prisma.RecipeIngredientGetPayload<{ include: { ingredient: true } }>[] }[] } | null }>(item: T) {
  const ingredients = item.recipe?.versions[0]?.ingredients ?? [];
  const estimatedCost = ingredients.reduce((total, line) => total.plus(new Decimal(line.quantity.toString()).mul(line.ingredient.unitCost.toString())), new Decimal(0));
  const portions = ingredients.length ? Math.min(...ingredients.map(line => new Decimal(line.ingredient.onHand.toString()).minus(line.ingredient.reserved.toString()).div(line.quantity.toString()).floor().toNumber())) : 0;
  const warnings = [
    ...(!ingredients.length ? ['Recipe is missing.'] : []),
    ...(ingredients.some(line => !line.ingredient.active) ? ['Recipe contains an inactive ingredient.'] : []),
    ...(ingredients.some(line => new Decimal(line.ingredient.unitCost.toString()).isZero()) ? ['Ingredient cost is missing; estimated cost may be understated.'] : []),
  ];
  return { ...item, estimatedCost: estimatedCost.toFixed(2), margin: new Decimal(item.price.toString()).minus(estimatedCost).toFixed(2), available: item.active && item.category.active && ingredients.length > 0 && ingredients.every(line => line.ingredient.active) && portions > 0, availablePortions: Math.max(0, portions), warnings };
}

function publicRecipeVersions<T extends { ingredients: Prisma.RecipeIngredientGetPayload<{ include: { ingredient: true } }>[] }>(versions: T[]) {
  return versions.map(version => ({ ...version, ingredients: version.ingredients.map(line => ({ ...line, ingredient: { id: line.ingredient.id, name: line.ingredient.name, sku: line.ingredient.sku, unit: line.ingredient.unit, active: line.ingredient.active } })) }));
}
function menuView<T extends Parameters<typeof decorateMenu>[0]>(item: T, role: string) {
  const data = decorateMenu(item);
  if (role === 'OWNER' || role === 'MANAGER' || role === 'INVENTORY') return data;
  const { estimatedCost: _cost, margin: _margin, ...safe } = data;
  return { ...safe, warnings: safe.warnings.filter(warning => !warning.startsWith('Ingredient cost')), recipe: safe.recipe ? { ...safe.recipe, versions: publicRecipeVersions(safe.recipe.versions) } : null };
}

catalogRouter.get('/categories', requireRoles(...everyone), async (req, res) => {
  const page = pagination(req);
  const where = req.query.active === 'true' ? { active: true } : {};
  const [rows, total] = await Promise.all([prisma.menuCategory.findMany({ where, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], skip: page.skip, take: page.take }), prisma.menuCategory.count({ where })]);
  res.json({ data: rows, pagination: { page: page.page, pageSize: page.pageSize, total } });
});

catalogRouter.post('/categories', requireRoles('OWNER', 'MANAGER'), async (req, res) => {
  const data = categoryInput.parse(req.body);
  const result = await tx(async transaction => {
    const row = await transaction.menuCategory.create({ data });
    await audit(transaction, req.user!.id, 'category.created', 'MenuCategory', row.id, data);
    return row;
  });
  publish('catalog:changed', { categoryId: result.id });
  res.status(201).json({ data: result });
});

catalogRouter.patch('/categories/:id', requireRoles('OWNER', 'MANAGER'), async (req, res) => {
  const data = categoryInput.partial().refine(value => Object.keys(value).length > 0, 'Supply at least one field.').parse(req.body);
  const result = await tx(async transaction => {
    if (!await transaction.menuCategory.findUnique({ where: { id: String(req.params.id) } })) throw new AppError(404, 'NOT_FOUND', 'Category not found.');
    const row = await transaction.menuCategory.update({ where: { id: String(req.params.id) }, data });
    await audit(transaction, req.user!.id, 'category.updated', 'MenuCategory', row.id, data);
    return row;
  });
  publish('catalog:changed', { categoryId: result.id });
  res.json({ data: result });
});

catalogRouter.get('/menu', requireRoles(...everyone), async (req, res) => {
  const page = pagination(req);
  const where = { ...(req.query.active === 'true' ? { active: true } : {}), ...(typeof req.query.categoryId === 'string' ? { categoryId: req.query.categoryId } : {}), ...(typeof req.query.search === 'string' ? { name: { contains: req.query.search.slice(0, 160), mode: 'insensitive' as const } } : {}) };
  const [rows, total] = await Promise.all([prisma.menuItem.findMany({ where, include: { category: true, recipe: { include: latestRecipe } }, orderBy: { name: 'asc' }, skip: page.skip, take: page.take }), prisma.menuItem.count({ where })]);
  res.json({ data: rows.map(row => menuView(row, req.user!.role)), pagination: { page: page.page, pageSize: page.pageSize, total } });
});

catalogRouter.get('/menu/:id', requireRoles(...everyone), async (req, res) => {
  const row = await prisma.menuItem.findUnique({ where: { id: String(req.params.id) }, include: { category: true, recipe: { include: latestRecipe } } });
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Menu item not found.');
  res.json({ data: menuView(row, req.user!.role) });
});

catalogRouter.post('/menu', requireRoles('OWNER', 'MANAGER'), async (req, res) => {
  const data = menuInput.parse(req.body);
  const result = await tx(async transaction => {
    if (!await transaction.menuCategory.findUnique({ where: { id: data.categoryId } })) throw new AppError(400, 'INVALID_CATEGORY', 'Category not found.');
    const row = await transaction.menuItem.create({ data });
    await audit(transaction, req.user!.id, 'menu.created', 'MenuItem', row.id, data);
    return row;
  });
  publish('catalog:changed', { menuItemId: result.id });
  res.status(201).json({ data: result });
});

catalogRouter.patch('/menu/:id', requireRoles('OWNER', 'MANAGER'), async (req, res) => {
  const data = menuInput.partial().refine(value => Object.keys(value).length > 0, 'Supply at least one field.').parse(req.body);
  const result = await tx(async transaction => {
    if (!await transaction.menuItem.findUnique({ where: { id: String(req.params.id) } })) throw new AppError(404, 'NOT_FOUND', 'Menu item not found.');
    if (data.categoryId && !await transaction.menuCategory.findUnique({ where: { id: data.categoryId } })) throw new AppError(400, 'INVALID_CATEGORY', 'Category not found.');
    const row = await transaction.menuItem.update({ where: { id: String(req.params.id) }, data });
    await audit(transaction, req.user!.id, 'menu.updated', 'MenuItem', row.id, data);
    return row;
  });
  publish('catalog:changed', { menuItemId: result.id });
  res.json({ data: result });
});

catalogRouter.get('/menu/:id/recipes', requireRoles(...everyone), async (req, res) => {
  const item = await prisma.menuItem.findUnique({ where: { id: String(req.params.id) } });
  if (!item) throw new AppError(404, 'NOT_FOUND', 'Menu item not found.');
  const recipe = await prisma.recipe.findUnique({ where: { menuItemId: item.id }, include: { versions: { orderBy: { version: 'desc' }, include: { ingredients: { include: { ingredient: true } }, createdBy: { select: { id: true, name: true } } } } } });
  res.json({ data: req.user!.role === 'CASHIER' || req.user!.role === 'KITCHEN' ? publicRecipeVersions(recipe?.versions ?? []) : recipe?.versions ?? [] });
});

catalogRouter.post('/menu/:id/recipes', requireRoles('OWNER', 'MANAGER'), async (req, res) => {
  const data = recipeInput.parse(req.body);
  if (new Set(data.ingredients.map(line => line.ingredientId)).size !== data.ingredients.length) throw new AppError(400, 'DUPLICATE_INGREDIENT', 'An ingredient may appear only once in a recipe.');
  const result = await tx(async transaction => {
    if (!await transaction.menuItem.findUnique({ where: { id: String(req.params.id) } })) throw new AppError(404, 'NOT_FOUND', 'Menu item not found.');
    const ingredients = await transaction.ingredient.findMany({ where: { id: { in: data.ingredients.map(line => line.ingredientId) }, active: true } });
    if (ingredients.length !== data.ingredients.length) throw new AppError(400, 'INVALID_INGREDIENT', 'Every recipe ingredient must exist and be active.');
    const recipe = await transaction.recipe.upsert({ where: { menuItemId: String(req.params.id) }, create: { menuItemId: String(req.params.id) }, update: {} });
    const latest = await transaction.recipeVersion.findFirst({ where: { recipeId: recipe.id }, orderBy: { version: 'desc' } });
    const row = await transaction.recipeVersion.create({ data: { recipeId: recipe.id, version: (latest?.version ?? 0) + 1, createdById: req.user!.id, ingredients: { create: data.ingredients.map(line => { const ingredient = ingredients.find(candidate => candidate.id === line.ingredientId)!; return { ingredientId: line.ingredientId, quantity: quantity(line.quantity, line.unit, ingredient.unit) }; }) } }, include: { ingredients: { include: { ingredient: true } } } });
    await audit(transaction, req.user!.id, 'recipe.version_created', 'RecipeVersion', row.id, { menuItemId: String(req.params.id), version: row.version, ingredients: data.ingredients });
    return row;
  });
  publish('catalog:changed', { menuItemId: String(req.params.id) });
  res.status(201).json({ data: result });
});

catalogRouter.get('/ingredients', requireRoles(...operators), async (req, res) => {
  const page = pagination(req);
  const where = { ...(req.query.active === 'true' ? { active: true } : {}), ...(typeof req.query.search === 'string' ? { OR: [{ name: { contains: req.query.search.slice(0, 160), mode: 'insensitive' as const } }, { sku: { contains: req.query.search.slice(0, 80), mode: 'insensitive' as const } }] } : {}) };
  const [rows, total] = await Promise.all([prisma.ingredient.findMany({ where, include: { preferredSupplier: true }, orderBy: { name: 'asc' }, skip: page.skip, take: page.take }), prisma.ingredient.count({ where })]);
  res.json({ data: rows.map(row => ({ ...row, available: row.onHand.minus(row.reserved).toString() })), pagination: { page: page.page, pageSize: page.pageSize, total } });
});

catalogRouter.get('/ingredients/:id', requireRoles(...operators), async (req, res) => {
  const row = await prisma.ingredient.findUnique({ where: { id: String(req.params.id) }, include: { preferredSupplier: true } });
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Ingredient not found.');
  res.json({ data: { ...row, available: row.onHand.minus(row.reserved).toString() } });
});

catalogRouter.post('/ingredients', requireRoles('OWNER', 'MANAGER'), async (req, res) => {
  const data = ingredientInput.parse(req.body);
  const result = await tx(async transaction => {
    if (data.preferredSupplierId && !await transaction.supplier.findUnique({ where: { id: data.preferredSupplierId, active: true } })) throw new AppError(400, 'INVALID_SUPPLIER', 'Preferred supplier must exist and be active.');
    const row = await transaction.ingredient.create({ data: { ...data, expiresAt: data.expiresAt ? new Date(data.expiresAt) : null } });
    await audit(transaction, req.user!.id, 'ingredient.created', 'Ingredient', row.id, data);
    return row;
  });
  publish('inventory:changed', { ingredientId: result.id });
  res.status(201).json({ data: result });
});

catalogRouter.patch('/ingredients/:id', requireRoles('OWNER', 'MANAGER'), async (req, res) => {
  const data = ingredientInput.omit({ unit: true }).partial().refine(value => Object.keys(value).length > 0, 'Supply at least one field.').parse(req.body);
  const result = await tx(async transaction => {
    const current = await transaction.ingredient.findUnique({ where: { id: String(req.params.id) } });
    if (!current) throw new AppError(404, 'NOT_FOUND', 'Ingredient not found.');
    if (data.active === false && current.reserved.gt(0)) throw new AppError(409, 'ACTIVE_RESERVATIONS', 'An ingredient with active reservations cannot be disabled.');
    if (data.preferredSupplierId && !await transaction.supplier.findUnique({ where: { id: data.preferredSupplierId, active: true } })) throw new AppError(400, 'INVALID_SUPPLIER', 'Preferred supplier must exist and be active.');
    const row = await transaction.ingredient.update({ where: { id: current.id }, data: { ...data, ...(data.expiresAt !== undefined ? { expiresAt: data.expiresAt ? new Date(data.expiresAt) : null } : {}) } });
    await audit(transaction, req.user!.id, 'ingredient.updated', 'Ingredient', row.id, data);
    return row;
  });
  publish('inventory:changed', { ingredientId: result.id });
  res.json({ data: result });
});
