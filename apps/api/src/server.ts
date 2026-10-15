import { createApp } from './app.js';
import { prisma } from './db.js';
import { env } from './config.js';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { sessionMiddleware, sessionPool } from './lib/session.js';
import { configureRealtime } from './lib/core.js';
import { refreshOperationalNotifications } from './lib/notifications.js';

const server = createServer(createApp(prisma));
const io = new Server(server, { cors: { origin: new URL(env.APP_ORIGIN).origin, credentials: true },
  allowRequest: (req, callback) => callback(null, !req.headers.origin || req.headers.origin === new URL(env.APP_ORIGIN).origin),
});
io.engine.use(sessionMiddleware);
io.use(async (socket, next) => {
  try {
    const session = (socket.request as typeof socket.request & { session?: { userId?: string } }).session;
    const user = session?.userId ? await prisma.user.findUnique({ where: { id: session.userId }, select: { id: true, role: true, active: true } }) : null;
    if (!user?.active) return next(new Error('Authentication required.'));
    socket.data.userId = user.id;
    await socket.join([`user:${user.id}`, `role:${user.role}`]);
    next();
  } catch { next(new Error('Authentication unavailable.')); }
});
async function validateSocket(socket: typeof io.sockets.sockets extends Map<string, infer S> ? S : never) {
  const sid = (socket.request as typeof socket.request & { sessionID?: string }).sessionID;
  const [stored, user] = await Promise.all([
    sid ? prisma.session.findUnique({ where: { sid } }) : null,
    prisma.user.findUnique({ where: { id: socket.data.userId as string }, select: { active: true, role: true } }),
  ]);
  if (!stored || stored.expire <= new Date() || !user?.active) { socket.disconnect(true); return null; }
  return user;
}
configureRealtime((event, payload, roles) => {
  void (async () => {
    for (const socket of io.sockets.sockets.values()) {
      const user = await validateSocket(socket);
      if (user && roles.includes(user.role)) socket.emit(event, payload);
    }
  })().catch(() => console.error('Real-time delivery authorization failed.'));
}, userId => { io.in(`user:${userId}`).disconnectSockets(true); });
const maintenance = setInterval(() => {
  void refreshOperationalNotifications().catch(() => console.error('Operational notification refresh failed.'));
  void prisma.session.deleteMany({ where: { expire: { lt: new Date() } } }).catch(() => console.error('Session cleanup failed.'));
  for (const socket of io.sockets.sockets.values()) void validateSocket(socket).catch(() => socket.disconnect(true));
}, 60000).unref();
server.listen(env.API_PORT, env.API_HOST, () => {
  console.log(`API listening on port ${env.API_PORT} (${env.NODE_ENV}).`);
  void refreshOperationalNotifications().catch(() => console.error('Initial notification refresh failed.'));
});
server.on('error', () => {
  console.error('API could not bind its configured address. Check API_HOST and API_PORT.');
  process.exitCode = 1;
  void prisma.$disconnect();
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(maintenance);
  const timeout = setTimeout(() => process.exit(1), 10000).unref();
  io.close();
  server.close(async () => {
    await prisma.$disconnect();
    await sessionPool.end();
    clearTimeout(timeout);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
