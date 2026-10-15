import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';

afterAll(async () => { await prisma.$disconnect(); });
describe('migrated PostgreSQL and HTTP integration (requires db:up, db:migrate, db:seed)', () => {
  it('returns the actual persisted restaurant through the API', async () => {
    const persisted = await prisma.restaurantSettings.findUniqueOrThrow({ where: { id: 'primary' } });
    const response = await request(createApp(prisma, { logging: false })).get('/api/readiness').expect(200);
    expect(response.body.data.restaurant.name).toBe(persisted.name);
    expect(response.body.data.restaurant.taxRate).toBe(persisted.taxRate.toString());
    expect(response.body.data.database).toBe('connected');
  });
  it('enforces the tax constraint in PostgreSQL without leaving changes', async () => {
    const before = await prisma.restaurantSettings.findUniqueOrThrow({ where: { id: 'primary' } });
    const rollback = new Error('Constraint check finished; always roll back.');
    await expect(prisma.$transaction(async tx => {
      // If the constraint regresses, the failed assertion still rolls this back.
      await expect(tx.$executeRaw`UPDATE "RestaurantSettings" SET "taxRate" = 1.1 WHERE "id" = 'primary'`).rejects.toThrow();
      throw rollback;
    })).rejects.toBe(rollback);
    const after = await prisma.restaurantSettings.findUniqueOrThrow({ where: { id: 'primary' } });
    expect(after.taxRate.equals(before.taxRate)).toBe(true);
    expect(after.taxRate).toBeInstanceOf(Prisma.Decimal);
  });
});
