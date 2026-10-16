import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import pino from 'pino';
import { pinoHttp } from 'pino-http';
import { readinessSchema } from '@nk/shared';
import { openapi } from './openapi.js';
import { ZodError } from 'zod';
import { env } from './config.js';
import { sessionMiddleware, csrfProtection, authenticate } from './lib/session.js';
import { AppError } from './lib/core.js';
import { prisma } from './db.js';
import { authRouter } from './routes/auth.js';
import { adminRouter } from './routes/admin.js';
import { catalogRouter } from './routes/catalog.js';
import { inventoryRouter } from './routes/inventory.js';
import { ordersRouter } from './routes/orders.js';
import { purchasingRouter } from './routes/purchasing.js';
import { reportsRouter } from './routes/reports.js';
import swaggerUi from 'swagger-ui-express';

export interface Database {
  $queryRaw: (query: TemplateStringsArray) => Promise<unknown>;
  restaurantSettings: { findUnique: (args: { where: { id: string } }) => Promise<{
    id: string; name: string; currency: string; timezone: string; taxRate: { toString(): string }; isDemo: boolean;
  } | null> };
}

export function createApp(database: Database, options: { logging?: boolean; operations?: boolean } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY === 'true' ? 1 : false);
  app.use(helmet());
  app.use(pinoHttp({
    logger: pino({ enabled: options.logging !== false }),
    genReqId: () => randomUUID(),
    // Keep credentials, cookies, request bodies and database errors out of logs.
    serializers: {
      req: req => ({ id: req.id, method: req.method }),
      res: res => ({ statusCode: res.statusCode }),
      err: () => ({ type: 'RequestError' }),
    },
  }));
  app.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Request-Id', String(req.id)); next(); });
  app.use(express.json({ limit: '256kb' }));

  app.get('/api/health', (_req, res) => { res.json({ data: { status: 'ok', service: 'api' } }); });
  app.get('/api/openapi.json', (_req, res) => { res.json(openapi); });
  app.use('/api/docs', helmet({ contentSecurityPolicy: { directives: { 'script-src': ["'self'"], 'style-src': ["'self'", "'unsafe-inline'"], 'img-src': ["'self'", 'data:'] } } }), swaggerUi.serve, swaggerUi.setup(openapi, { customSiteTitle: 'The Copper Table API', swaggerOptions: { persistAuthorization: false } }));
  app.get('/api/readiness', async (req, res) => {
    try {
      await database.$queryRaw`SELECT 1`;
      if (options.operations !== false && await prisma.user.count({ where: { role: 'OWNER', active: true } }) === 0) {
        res.status(503).json({ error: { code: 'OWNER_REQUIRED', message: 'Provision an active owner before starting operations.', requestId: req.id } });
        return;
      }
      const restaurant = await database.restaurantSettings.findUnique({ where: { id: 'primary' } });
      if (!restaurant) {
        res.status(503).json({ error: { code: 'NOT_CONFIGURED', message: 'Restaurant configuration is missing. Run the development seed.', requestId: req.id } });
        return;
      }
      const response = readinessSchema.parse({ data: {
        status: 'ready', database: 'connected', phase: 8,
        restaurant: { ...restaurant, taxRate: restaurant.taxRate.toString() },
      } });
      res.json(response);
    } catch {
      req.log.warn({ event: 'readiness_failed' }, 'Database readiness check failed');
      res.status(503).json({ error: { code: 'NOT_READY', message: 'Restaurant data is unavailable. Check database connectivity and migrations.', requestId: req.id } });
    }
  });
  if (options.operations !== false) {
    app.use('/api', sessionMiddleware);
    app.use('/api/auth', csrfProtection, authRouter);
    app.use('/api', authenticate, csrfProtection, adminRouter, catalogRouter, inventoryRouter, ordersRouter, purchasingRouter, reportsRouter);
  }
  app.use((req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found.', requestId: req.id } });
  });
  const errors: ErrorRequestHandler = (error, req, res, _next) => {
    const badBody = error?.type === 'entity.parse.failed';
    const tooLarge = error?.type === 'entity.too.large';
    const validation = error instanceof ZodError;
    const conflict = ['P2002', 'P2003', 'P2004'].includes(error?.code);
    const missing = error?.code === 'P2025';
    const known = error instanceof AppError;
    const status = known ? error.status : validation || badBody ? 400 : tooLarge ? 413 : conflict ? 409 : missing ? 404 : 500;
    if (status === 500) req.log.error({ event: 'request_failed', code: typeof error?.code === 'string' ? error.code : 'unknown' }, 'Request failed');
    res.status(status).json({ error: {
      code: known ? error.code : validation ? 'VALIDATION_ERROR' : badBody ? 'INVALID_JSON' : tooLarge ? 'BODY_TOO_LARGE' : conflict ? 'CONFLICT' : missing ? 'NOT_FOUND' : 'INTERNAL_ERROR',
      message: known ? error.message : validation ? error.issues.map(issue => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; ').slice(0, 1000) : badBody ? 'Request body must contain valid JSON.' : tooLarge ? 'Request body is too large.' : conflict ? 'This operation conflicts with existing records.' : missing ? 'Record not found.' : 'An unexpected error occurred.',
      requestId: req.id,
    } });
  };
  app.use(errors);
  return app;
}
