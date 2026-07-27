import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROOM_SETTINGS, type PublicRoomProjection } from '@poker-with-friends/protocol';
import { buildApp, safeErrorLogContext, safeRequestUrl } from './app.js';
import type { AppConfig } from './config.js';
import type { PokerRepository } from './repository.js';
import type { RoomManager } from './room/manager.js';
import { USER_COOKIE } from './security/cookies.js';

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
  ALLOW_NO_ORIGIN: true,
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
      expect(health.headers['content-security-policy']).toContain(
        "style-src 'self' https://fonts.googleapis.com",
      );
      expect(health.headers['content-security-policy']).toContain(
        "font-src 'self' https://fonts.gstatic.com",
      );
      expect(health.headers['content-security-policy']).not.toContain("'unsafe-inline'");
    } finally {
      built.io.close();
      await built.app.close();
    }
  });

  it('requires login for spectator snapshots and gives non-members no private projection', async () => {
    const roomId = '00000000-0000-4000-8000-000000000001';
    const publicProjection: PublicRoomProjection = {
      roomId,
      name: 'Spectator test',
      mode: 'ONLINE',
      status: 'LOBBY',
      settings: { ...DEFAULT_ROOM_SETTINGS, mode: 'ONLINE' },
      serverSeq: 0,
      handNumber: 0,
      phase: null,
      seats: [],
      communityCards: [],
      pots: [],
      actingSeat: null,
      buttonSeat: null,
      smallBlindSeat: null,
      bigBlindSeat: null,
      liveDealerSeat: null,
      pendingLiveStreet: null,
      prompt: null,
      liveResultProposal: null,
      nextHandAt: null,
      readyCount: 0,
      requiredReadyCount: 0,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    const repository = {
      getUserBySession: vi.fn(async (sessionToken?: string) =>
        sessionToken === 'valid-user-session'
          ? {
              id: '00000000-0000-4000-8000-000000000099',
              username: 'spectator',
              displayName: 'Spectator',
              mustChangePassword: false,
            }
          : null,
      ),
      getAdminBySession: vi.fn(async () => null),
    } as unknown as PokerRepository;
    const publicSnapshot = vi.fn(async () => publicProjection);
    const rooms = {
      setProjectionListener: vi.fn(),
      publicSnapshot,
    } as unknown as RoomManager;
    const built = await buildApp({ config: testConfig, repository, rooms });
    try {
      const unauthenticated = await built.app.inject({
        method: 'GET',
        url: `/api/rooms/${roomId}/spectate`,
      });
      expect(unauthenticated.statusCode).toBe(401);
      expect(unauthenticated.json()).toMatchObject({ error: 'UNAUTHORIZED' });
      expect(publicSnapshot).not.toHaveBeenCalled();

      const authenticated = await built.app.inject({
        method: 'GET',
        url: `/api/rooms/${roomId}/spectate`,
        headers: { cookie: `${USER_COOKIE}=valid-user-session` },
      });
      expect(authenticated.statusCode).toBe(200);
      expect(authenticated.json()).toEqual({ public: publicProjection, private: null });
      expect(publicSnapshot).toHaveBeenCalledOnce();
      expect(publicSnapshot).toHaveBeenCalledWith(roomId);
    } finally {
      built.io.close();
      await built.app.close();
    }
  });
});
