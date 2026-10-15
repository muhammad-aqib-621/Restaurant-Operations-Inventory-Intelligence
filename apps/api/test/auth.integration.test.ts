import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { sessionPool } from '../src/lib/session.js';

const app = createApp(prisma, { logging: false });
const password = process.env.DEMO_PASSWORD!;
async function login(role = 'owner') {
  const agent = request.agent(app);
  const initial = await agent.get('/api/auth/me').expect(200);
  const result = await agent.post('/api/auth/login').set('x-csrf-token', initial.body.data.csrfToken).send({ email: `${role}@newkarachi.test`, password }).expect(200);
  return { agent, csrf: result.body.data.csrfToken as string, user: result.body.data.user, cookie: result.headers['set-cookie'] };
}
afterAll(async () => { await sessionPool.end(); await prisma.$disconnect(); });

describe('persistent authentication and backend authorization', () => {
  it('exposes readiness but protects operational data without a session', async () => {
    await request(app).get('/api/readiness').expect(200);
    await request(app).get('/api/orders').expect(401);
    await request(app).post('/api/orders').send({ items: [] }).expect(401);
  });
  it('rotates CSRF and session on login, persists login in PostgreSQL, and keeps cookies HTTP-only', async () => {
    const { agent, csrf, user, cookie } = await login();
    expect(user.role).toBe('OWNER');
    expect(user.passwordHash).toBeUndefined();
    expect(String(cookie)).toMatch(/HttpOnly/);
    expect(String(cookie)).toMatch(/SameSite=Lax/);
    expect((await agent.get('/api/auth/me')).body.data.csrfToken).toBe(csrf);
    expect(await prisma.session.count({ where: { sess: { path: ['userId'], equals: user.id } } })).toBeGreaterThan(0);
    const users = await agent.get('/api/users').expect(200);
    expect(users.text).not.toContain('passwordHash');
  });
  it('rejects absent, malformed and cross-origin CSRF tokens before mutations', async () => {
    const { agent, csrf } = await login();
    await agent.patch('/api/settings').send({ name: 'Untrusted update' }).expect(403);
    await agent.patch('/api/settings').set('x-csrf-token', 'é'.repeat(64)).send({ name: 'Untrusted update' }).expect(403);
    await agent.patch('/api/settings').set('x-csrf-token', csrf).set('Origin', 'https://untrusted.example').send({ name: 'Untrusted update' }).expect(403);
  });
  it('enforces role boundaries on direct requests', async () => {
    const { agent, csrf } = await login('cashier');
    await agent.get('/api/users').expect(403);
    await agent.get('/api/audit').expect(403);
    await agent.get('/api/reports/dashboard').expect(403);
    await agent.patch('/api/settings').set('x-csrf-token', csrf).send({ taxRate: '0.99' }).expect(403);
    await agent.get('/api/settings').expect(200);
  });
  it('preserves disabled accounts on unrelated edits and immediately revokes disabled sessions', async () => {
    const owner = await login();
    const email = `${randomUUID()}@auth-test.example`;
    const created = await owner.agent.post('/api/users').set('x-csrf-token', owner.csrf).send({ name: 'Disable test', email, password, role: 'INVENTORY', active: true }).expect(201);
    const target = request.agent(app);
    const token = (await target.get('/api/auth/me')).body.data.csrfToken;
    await target.post('/api/auth/login').set('x-csrf-token', token).send({ email, password }).expect(200);
    await target.get('/api/ingredients').expect(200);
    await owner.agent.patch(`/api/users/${created.body.data.id}`).set('x-csrf-token', owner.csrf).send({ active: false }).expect(200);
    const renamed = await owner.agent.patch(`/api/users/${created.body.data.id}`).set('x-csrf-token', owner.csrf).send({ name: 'Still disabled' }).expect(200);
    expect(renamed.body.data.active).toBe(false);
    await target.get('/api/ingredients').expect(401);
  });
  it('prevents owner self-lockout and rejects weak or overlong password changes', async () => {
    const { agent, csrf, user } = await login();
    await agent.patch(`/api/users/${user.id}`).set('x-csrf-token', csrf).send({ active: false }).expect(409);
    await agent.patch(`/api/users/${user.id}`).set('x-csrf-token', csrf).send({ password: 'short' }).expect(400);
    await agent.patch(`/api/users/${user.id}`).set('x-csrf-token', csrf).send({ password: 'é'.repeat(40) }).expect(400);
    await agent.post('/api/auth/login').set('x-csrf-token', csrf).send({ email: user.email, password: 'x'.repeat(73) }).expect(400);
  });
  it('scopes broadcast notifications and read acknowledgements to authorized roles', async () => {
    const cashier = await login('cashier');
    const notification = await prisma.notification.create({ data: { type: 'TEST', title: 'Owner only', message: 'Access test', roles: ['OWNER'] } });
    const response = await cashier.agent.get('/api/notifications').expect(200);
    expect(response.body.data.some((item: { id: string }) => item.id === notification.id)).toBe(false);
    await cashier.agent.post(`/api/notifications/${notification.id}/read`).set('x-csrf-token', cashier.csrf).send({}).expect(404);
  });
  it('destroys sessions on logout', async () => {
    const { agent, csrf } = await login();
    await agent.post('/api/auth/logout').set('x-csrf-token', csrf).send({}).expect(200);
    await agent.get('/api/orders').expect(401);
    expect((await agent.get('/api/auth/me')).body.data.user).toBeNull();
  });
  it('returns a generic credential error and rate limits repeated attempts', async () => {
    const agent = request.agent(app);
    const token = (await agent.get('/api/auth/me')).body.data.csrfToken;
    let limited = false;
    for (let i = 0; i < 16; i++) {
      const result = await agent.post('/api/auth/login').set('x-csrf-token', token).send({ email: 'missing@example.test', password: 'incorrect-password' });
      if (result.status === 429) { expect(result.body.error.code).toBe('RATE_LIMITED'); limited = true; break; }
      expect(result.status).toBe(401);
      expect(result.body.error.message).toBe('Email or password is incorrect.');
    }
    expect(limited).toBe(true);
  });
});
