import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp, type Database } from '../src/app.js';

function fixture() {
  const database: Database = {
    $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
    restaurantSettings: { findUnique: vi.fn().mockResolvedValue({
      id: 'primary', name: 'Test restaurant', currency: 'PKR', timezone: 'Asia/Karachi', taxRate: { toString: () => '0.15' }, isDemo: true,
    }) },
  };
  return { database, app: createApp(database, { logging: false, operations: false }) };
}
describe('HTTP foundation', () => {
  it('keeps liveness separate from readiness', async () => {
    const { app, database } = fixture();
    const response = await request(app).get('/api/health').expect(200);
    expect(response.body.data.status).toBe('ok');
    expect(database.$queryRaw).not.toHaveBeenCalled();
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
  it('reads restaurant data and serializes decimals as strings', async () => {
    const { app, database } = fixture();
    const response = await request(app).get('/api/readiness').expect(200);
    expect(database.$queryRaw).toHaveBeenCalledOnce();
    expect(response.body.data.restaurant).toMatchObject({ name: 'Test restaurant', taxRate: '0.15' });
  });
  it('reports missing seed as unavailable', async () => {
    const { app, database } = fixture();
    vi.mocked(database.restaurantSettings.findUnique).mockResolvedValue(null);
    const response = await request(app).get('/api/readiness').expect(503);
    expect(response.body.error.code).toBe('NOT_CONFIGURED');
  });
  it('does not leak database failures or credentials', async () => {
    const { app, database } = fixture();
    vi.mocked(database.$queryRaw).mockRejectedValue(new Error('postgresql://secret-password@internal-host'));
    const response = await request(app).get('/api/readiness').expect(503);
    expect(response.body.error.requestId).toEqual(expect.any(String));
    expect(response.text).not.toMatch(/secret-password|internal-host|stack/);
  });
  it('returns consistent 404 and JSON validation errors', async () => {
    const { app } = fixture();
    expect((await request(app).get('/api/unknown').expect(404)).body.error.code).toBe('NOT_FOUND');
    const response = await request(app).post('/api/unknown').set('Content-Type', 'application/json').send('{').expect(400);
    expect(response.body.error.code).toBe('INVALID_JSON');
  });
  it('serves the versioned OpenAPI contract', async () => {
    const { app } = fixture();
    const response = await request(app).get('/api/openapi.json').expect(200);
    expect(response.body.openapi).toBe('3.1.0');
    expect(response.body.paths['/readiness'].get.responses['503']).toBeDefined();
  });
});
