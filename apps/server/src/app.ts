import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Server as SocketServer } from 'socket.io';
import type { AppConfig } from './config.js';
import type { PokerRepository } from './repository.js';
import { registerSocketServer } from './realtime/socket.js';
import { registerHttpRoutes } from './routes/http.js';
import type { RoomManager } from './room/manager.js';
import { safeErrorLogContext, safeRequestUrl } from './security/logging.js';

export { safeErrorLogContext, safeRequestUrl } from './security/logging.js';

export interface BuildAppDependencies {
  config: AppConfig;
  repository: PokerRepository;
  rooms: RoomManager;
}

export interface PokerApp {
  app: FastifyInstance;
  io: SocketServer;
}

export async function buildApp(deps: BuildAppDependencies): Promise<PokerApp> {
  const publicUrl = new URL(deps.config.PUBLIC_ORIGIN);
  const realtimeOrigin = `${publicUrl.protocol === 'https:' ? 'wss:' : 'ws:'}//${publicUrl.host}`;
  const app = Fastify({
    logger:
      deps.config.NODE_ENV === 'test'
        ? false
        : {
            level: deps.config.NODE_ENV === 'production' ? 'info' : 'debug',
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.headers.referer',
                'req.url',
                'res.headers.set-cookie',
                'err.params',
                '*.password',
                '*.passwordHash',
                '*.password_hash',
                '*.holeCards',
                '*.turnToken',
              ],
              censor: (value, path) =>
                path.join('.') === 'req.url' ? safeRequestUrl(value) : '[REDACTED]',
            },
          },
    trustProxy: deps.config.TRUST_PROXY,
    bodyLimit: 64 * 1_024,
    requestTimeout: 15_000,
  });

  await app.register(cookie, { secret: deps.config.COOKIE_SECRET });
  await app.register(rateLimit, { global: false });

  app.setErrorHandler((error, request, reply) => {
    const caught =
      typeof error === 'object' && error !== null
        ? (error as { statusCode?: unknown; code?: unknown; message?: unknown })
        : {};
    const statusCode =
      typeof caught.statusCode === 'number' && caught.statusCode >= 400 && caught.statusCode < 500
        ? caught.statusCode
        : 500;
    if (statusCode < 500) {
      return reply.code(statusCode).send({
        error: typeof caught.code === 'string' ? caught.code : 'BAD_REQUEST',
        message: typeof caught.message === 'string' ? caught.message : '请求参数无效',
      });
    }
    request.log.error({ failure: safeErrorLogContext(error) }, 'unhandled request error');
    return reply
      .code(500)
      .send({ error: 'INTERNAL_ERROR', message: '服务器暂时无法处理请求，请稍后重试' });
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Robots-Tag', 'noindex, noarchive');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    if (deps.config.NODE_ENV === 'production') {
      reply.header('Strict-Transport-Security', 'max-age=31536000');
    }
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
        `connect-src 'self' ${realtimeOrigin}; font-src 'self'; object-src 'none'; frame-ancestors 'none'; ` +
        "base-uri 'self'; form-action 'self'",
    );
    const pathname = request.url.split('?', 1)[0];
    const contentType = String(reply.getHeader('content-type') ?? '');
    if (
      pathname === '/pwa-worker.js' ||
      pathname === '/manifest.webmanifest' ||
      pathname === '/icon.svg'
    ) {
      reply.header('Cache-Control', 'no-cache');
    } else if (pathname?.startsWith('/api/') || pathname?.startsWith('/health/')) {
      reply.header('Cache-Control', 'no-store');
    } else if (
      pathname === '/' ||
      pathname?.endsWith('.html') ||
      contentType.toLowerCase().includes('text/html')
    ) {
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });

  await registerHttpRoutes(app, deps);
  const io = registerSocketServer(app, deps);

  const webRoot = resolve(process.cwd(), deps.config.WEB_DIST_DIR);
  if (existsSync(resolve(webRoot, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: '/',
      wildcard: false,
      immutable: true,
      maxAge: '1y',
      index: false,
    });
    app.get('/*', async (request, reply) => {
      if (request.url.startsWith('/api/') || request.url.startsWith('/socket.io/')) {
        return reply.code(404).send({ error: 'NOT_FOUND' });
      }
      const pathname = request.url.split('?', 1)[0] ?? '';
      if (pathname.startsWith('/assets/') || /\.[a-z0-9]+$/i.test(pathname)) {
        return reply.code(404).send({ error: 'ASSET_NOT_FOUND' });
      }
      return reply.header('Cache-Control', 'no-store').sendFile('index.html');
    });
  } else {
    app.get('/', async () => ({
      name: 'Poker with Friends API',
      build: deps.config.APP_BUILD_SHA,
      message: 'Web build not found; run pnpm --filter @poker-with-friends/web build',
    }));
  }

  return { app, io };
}
