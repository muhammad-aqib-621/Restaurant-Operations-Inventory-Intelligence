import { z } from 'zod';

// Normalize before validating so pasted addresses work consistently on both clients.
export const accountEmailSchema = z.string().trim().toLowerCase().max(254, 'Use an email address of 254 characters or fewer.').pipe(z.email('Enter a valid email address.'));
const passwordSchema = z.string().min(1, 'Enter your password.').max(72, 'Use a password of 72 bytes or fewer.').refine(
  value => new TextEncoder().encode(value).length <= 72,
  'Use a password of 72 bytes or fewer.',
);
export const signInSchema = z.object({ email: accountEmailSchema, password: passwordSchema }).strict();
export const accountRequestSchema = z.object({
  name: z.string().trim().min(2, 'Enter your name (at least 2 characters).').max(100, 'Use a name of 100 characters or fewer.'),
  email: accountEmailSchema,
  password: passwordSchema.refine(value => value.length >= 12, 'Use at least 12 characters.'),
}).strict();

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
