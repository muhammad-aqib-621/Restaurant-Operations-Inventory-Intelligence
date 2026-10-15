import SwaggerParser from '@apidevtools/swagger-parser';
import type { Router } from 'express';
import { describe, expect, it } from 'vitest';
import { readinessSchema } from '@nk/shared';
import { createApp, type Database } from '../src/app.js';
import { openapi } from '../src/openapi.js';
import { adminRouter } from '../src/routes/admin.js';
import { authRouter } from '../src/routes/auth.js';
import { catalogRouter } from '../src/routes/catalog.js';
import { inventoryRouter } from '../src/routes/inventory.js';
import { ordersRouter } from '../src/routes/orders.js';
import { purchasingRouter } from '../src/routes/purchasing.js';
import { reportsRouter } from '../src/routes/reports.js';

type Parameter = { $ref?: string; in?: string; name?: string; required?: boolean; schema?: Record<string, unknown> };
type Operation = { operationId: string; parameters?: Parameter[]; security?: unknown[]; 'x-roles': string[]; requestBody?: unknown; responses: Record<string, unknown> };
const operations = Object.entries(openapi.paths).flatMap(([path, methods]) =>
  Object.entries(methods).map(([method, definition]) => ({ path, method, definition: definition as Operation })));

/** Inspect Express registrations, so a new/renamed runtime route must update the published contract. */
function registered(router: Router, prefix = ''): string[] {
  return router.stack.flatMap(layer => {
    const route = layer.route as { path: string; methods: Record<string, boolean> } | undefined;
    if (!route) return [];
    const path = `${prefix}${route.path}`.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, '{$1}');
    return Object.entries(route.methods).filter(([, enabled]) => enabled).map(([method]) => `${method} ${path}`);
  });
}

describe('published OpenAPI contract', () => {
  it('validates as OpenAPI 3.1 with all local references resolved', async () => {
    // validate dereferences/mutates its argument; never mutate the document served by Express.
    const validated = await SwaggerParser.validate(structuredClone(openapi) as unknown as SwaggerParser['api']);
    expect(validated).toHaveProperty('openapi', '3.1.0');
  });

  it('documents every implemented HTTP operation exactly once', () => {
    const database: Database = {
      $queryRaw: async () => [],
      restaurantSettings: { findUnique: async () => null },
    };
    const app = createApp(database, { logging: false, operations: false });
    const foundation = registered(app.router).map(entry => entry.replace(' /api/', ' /'));
    // Swagger UI is middleware serving HTML/assets, rather than an Express Route.
    const runtime = [...foundation, 'get /docs', ...registered(authRouter, '/auth'),
      ...[adminRouter, catalogRouter, inventoryRouter, ordersRouter, purchasingRouter, reportsRouter].flatMap(router => registered(router))];
    expect(operations.map(({ path, method }) => `${method} ${path}`).sort()).toEqual(runtime.sort());
    const operationIds = operations.map(({ definition }) => definition.operationId);
    expect(new Set(operationIds).size).toBe(operationIds.length);
  });

  it('requires session authentication, CSRF and retry keys at the correct boundaries', () => {
    expect(openapi.security).toEqual([{ sessionCookie: [] }]);
    for (const { path, method, definition } of operations) {
      const publicEndpoint = ['/health', '/readiness', '/openapi.json', '/docs'].includes(path) || path.startsWith('/auth/');
      expect(definition.security, `${method} ${path} authentication`).toEqual(publicEndpoint ? [] : undefined);
      expect(definition['x-roles'].length > 0, `${method} ${path} roles`).toBe(!publicEndpoint);
      const parameters = definition.parameters ?? [];
      expect(parameters.some(parameter => parameter.$ref === '#/components/parameters/CsrfToken'), `${method} ${path} CSRF`).toBe(method !== 'get');
      const financialOrStockCommand = method !== 'get' && /^\/(orders|inventory|purchases|suppliers|waste)(\/|$)/.test(path);
      expect(parameters.some(parameter => parameter.$ref === '#/components/parameters/IdempotencyKey'), `${method} ${path} retry key`).toBe(financialOrStockCommand);
      for (const match of path.matchAll(/\{([^}]+)\}/g)) {
        expect(parameters).toEqual(expect.arrayContaining([expect.objectContaining({ in: 'path', name: match[1], required: true })]));
      }
    }
  });

  it('keeps request objects strict and authoritative totals out of checkout inputs', () => {
    const schemas = openapi.components.schemas;
    const requestNames = operations.flatMap(({ definition }) => {
      const body = definition.requestBody as { content: { 'application/json': { schema: { $ref: string } } } } | undefined;
      return body ? [body.content['application/json'].schema.$ref.split('/').at(-1)!] : [];
    });
    for (const name of requestNames) expect(schemas[name].additionalProperties, name).toBe(false);
    expect(schemas.OrderInput.required).toEqual(['items']);
    const orderProperties = schemas.OrderInput.properties as Record<string, unknown>;
    for (const serverField of ['total', 'subtotal', 'tax', 'estimatedCost', 'status', 'price']) expect(orderProperties).not.toHaveProperty(serverField);
    expect((schemas.IngredientPatch.properties as Record<string, unknown>)).not.toHaveProperty('unit');
    expect((schemas.UserPatch.properties as Record<string, unknown>)).not.toHaveProperty('email');
  });

  it('preserves exact decimal strings and signed/positive quantity constraints', () => {
    const schemas = openapi.components.schemas;
    for (const name of ['Decimal', 'NonnegativeMoney', 'NonnegativeQuantity', 'PositiveQuantity', 'SignedQuantity', 'Fraction']) expect(schemas[name].type).toBe('string');
    const matches = (name: string, value: string) => new RegExp(schemas[name].pattern as string).test(value);
    expect(matches('NonnegativeMoney', '1250.50')).toBe(true);
    expect(matches('NonnegativeMoney', '1.001')).toBe(false);
    expect(matches('NonnegativeQuantity', '0.000001')).toBe(true);
    expect(matches('PositiveQuantity', '0.000000')).toBe(false);
    expect(matches('SignedQuantity', '-1.25')).toBe(true);
    expect(matches('SignedQuantity', '-0')).toBe(false);
    expect(matches('Fraction', '1.01')).toBe(false);
  });

  it('publishes paginated analytics, full CSV exports and the current readiness phase', () => {
    const reports = openapi.paths['/reports/{type}'].get as Operation;
    expect(reports['x-roles']).toEqual(['OWNER', 'MANAGER']);
    expect(reports.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'type', in: 'path', schema: { type: 'string', enum: ['sales', 'items', 'hourly', 'consumption', 'valuation', 'movements', 'waste', 'purchases', 'reorder'] } })]));
    const response = reports.responses['200'] as { content: Record<string, { schema: unknown }> };
    expect(Object.keys(response.content).sort()).toEqual(['application/json', 'text/csv']);
    expect(response.content['application/json'].schema).toMatchObject({ required: ['data', 'pagination'] });
    expect(openapi.components.schemas.Report.required).toEqual(expect.arrayContaining(['columns', 'rows', 'summary', 'definitions', 'timezone']));
    const readiness = openapi.components.schemas.Readiness.properties as { data: { properties: { phase: { const: number } } } };
    expect(readiness.data.properties.phase.const).toBe(readinessSchema.shape.data.shape.phase.value);
  });
});
