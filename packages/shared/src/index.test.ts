import { describe, expect, it } from 'vitest';
import { restaurantSchema } from './index.js';

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
