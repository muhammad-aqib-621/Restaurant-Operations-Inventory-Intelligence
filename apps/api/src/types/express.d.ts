import type { Role } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; name: string; email: string; role: Role; active: boolean };
    }
  }
}
declare module 'express-session' {
  interface SessionData { userId?: string; csrfToken?: string }
}
export {};
