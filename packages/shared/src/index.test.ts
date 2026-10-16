import { describe, expect, it } from 'vitest';
import { accountRequestSchema, restaurantSchema, signInSchema } from './index.js';

describe('account credentials', () => {
  it('normalizes pasted email addresses before validating without changing passwords', () => {
    expect(signInSchema.parse({ email: '  OWNER@Example.TEST  ', password: ' passphrase ' })).toEqual({ email: 'owner@example.test', password: ' passphrase ' });
  });
  it('applies the same email normalization to account requests', () => {
    expect(accountRequestSchema.parse({ name: ' New Teammate ', email: ' NEW@EXAMPLE.TEST ', password: 'twelve-characters' })).toMatchObject({ name: 'New Teammate', email: 'new@example.test' });
  });
  it('rejects passwords exceeding the bcrypt UTF-8 byte limit on either path', () => {
    const credentials = { email: 'owner@example.test', password: 'é'.repeat(37) };
    expect(signInSchema.safeParse(credentials).success).toBe(false);
    expect(accountRequestSchema.safeParse({ ...credentials, name: 'Teammate' }).success).toBe(false);
    expect(signInSchema.safeParse({ ...credentials, password: 'é'.repeat(36) }).success).toBe(true);
  });
  it('requires a longer password for registration and rejects malformed addresses', () => {
    expect(signInSchema.safeParse({ email: 'owner@example.test', password: 'short' }).success).toBe(true);
    expect(accountRequestSchema.safeParse({ name: 'Teammate', email: 'owner@example.test', password: 'short' }).success).toBe(false);
    expect(signInSchema.safeParse({ email: 'owner@', password: 'password' }).success).toBe(false);
  });
});

const restaurant = { id: 'primary', name: 'The Copper Table', currency: 'PKR', timezone: 'Asia/Karachi', taxRate: '0.15', isDemo: true };
describe('restaurant contract', () => {
  it('preserves decimal text and accepts the Karachi time zone', () => {
    expect(restaurantSchema.parse(restaurant).taxRate).toBe('0.15');
  });
  it.each(['-0.01', '1.01', 'NaN', '0.0000001'])('rejects invalid tax fraction %s', taxRate => {
    expect(restaurantSchema.safeParse({ ...restaurant, taxRate }).success).toBe(false);
  });
  it('rejects a non-IANA time zone and an empty name', () => {
    expect(restaurantSchema.safeParse({ ...restaurant, timezone: 'invalid-zone' }).success).toBe(false);
    expect(restaurantSchema.safeParse({ ...restaurant, name: ' ' }).success).toBe(false);
  });
});
