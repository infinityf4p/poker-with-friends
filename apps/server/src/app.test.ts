import { describe, expect, it, vi } from 'vitest';
import { buildApp, safeErrorLogContext, safeRequestUrl } from './app.js';
import type { AppConfig } from './config.js';
import type { PokerRepository } from './repository.js';
import type { RoomManager } from './room/manager.js';

const testConfig: AppConfig = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: 3000,
  PUBLIC_ORIGIN: 'https://poker.example.com',
  DATABASE_URL: 'postgres://unused',
  COOKIE_SECRET: 'cookie-secret-generated-for-tests-only',
  SNAPSHOT_KEY: Buffer.alloc(32, 1).toString('base64'),
  TOKEN_PEPPER: 'token-pepper-generated-for-tests-only',
  ADMIN_USERNAME: 'admin',
  TRUST_PROXY: false,
  RETENTION_DAYS: 30,
  ROOM_IDLE_HOURS: 12,
  APP_BUILD_SHA: 'test',
  WEB_DIST_DIR: 'missing-test-web-dist',
};

describe('safeErrorLogContext', () => {
  it('keeps diagnostic codes without serializing SQL parameters or password hashes', () => {
    const passwordHash = '$argon2id$v=19$m=65536,t=3,p=4$private-hash';
    const cause = Object.assign(new Error(`database params: ${passwordHash}`), { code: '23514' });
    const error = Object.assign(new Error(`Failed query: insert params: ${passwordHash}`), {
      code: 'DRIZZLE_QUERY_ERROR',
      cause,
    });

    const context = safeErrorLogContext(error);
    const serialized = JSON.stringify(context);

    expect(context).toEqual({
      errorName: 'Error',
      errorCode: 'DRIZZLE_QUERY_ERROR',
      causeCode: '23514',
    });
    expect(serialized).not.toContain(passwordHash);
    expect(serialized).not.toContain('Failed query');
    expect(serialized).not.toContain('params');
  });

  it('keeps the route shape while removing invite tokens and query strings', () => {
    const token = 'a'.repeat(43);
    expect(safeRequestUrl(`/api/rooms/${token}/invite-preview?debug=secret`)).toBe(
      '/api/rooms/[REDACTED]/invite-preview',
    );
    expect(safeRequestUrl('/health/live?probe=1')).toBe('/health/live');
  });
});

describe('HTTP security boundary', () => {
  it('rejects cross-origin writes and malformed identifiers before route handlers', async () => {
    const repository = {} as PokerRepository;
    const rooms = { setProjectionListener: vi.fn() } as unknown as RoomManager;
    const built = await buildApp({ config: testConfig, repository, rooms });
    try {
      const crossOrigin = await built.app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { origin: 'https://attacker.example.com' },
      });
      expect(crossOrigin.statusCode).toBe(403);

      const malformedId = await built.app.inject({
        method: 'GET',
        url: '/api/rooms/not-a-uuid/history',
      });
      expect(malformedId.statusCode).toBe(400);

      const health = await built.app.inject({ method: 'GET', url: '/health/live' });
      expect(health.statusCode).toBe(200);
      expect(health.headers['cache-control']).toBe('no-store');
      expect(health.headers['content-security-policy']).toContain(
        "connect-src 'self' wss://poker.example.com",
      );
      expect(health.headers['content-security-policy']).not.toContain("'unsafe-inline'");
    } finally {
      built.io.close();
      await built.app.close();
    }
  });
});
