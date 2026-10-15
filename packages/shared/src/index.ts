import { z } from 'zod';

// Decimal values cross the HTTP boundary as strings to preserve precision.
export const restaurantSchema = z.object({
  id: z.literal('primary'),
  name: z.string().trim().min(1).max(120),
  currency: z.string().regex(/^[A-Z]{3}$/),
  timezone: z.string().refine(value => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; }
    catch { return false; }
  }, 'A valid IANA time zone is required.'),
  taxRate: z.string().regex(/^(?:0(?:\.\d{1,6})?|1(?:\.0{1,6})?)$/),
  isDemo: z.boolean(),
});
export type Restaurant = z.infer<typeof restaurantSchema>;
export const readinessSchema = z.object({
  data: z.object({
    status: z.literal('ready'), database: z.literal('connected'),
    restaurant: restaurantSchema, phase: z.literal(8),
  }),
});
export type ReadinessResponse = z.infer<typeof readinessSchema>;
