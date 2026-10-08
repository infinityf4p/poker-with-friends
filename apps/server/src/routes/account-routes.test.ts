import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type PokerApp } from '../app.js';
import type { AppConfig } from '../config.js';
import type { PokerRepository } from '../repository.js';
import type { RoomManager } from '../room/manager.js';
import { ADMIN_COOKIE, USER_COOKIE } from '../security/cookies.js';

const config: AppConfig = {
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
const user = {
  id: '00000000-0000-4000-8000-000000000001',
  username: 'player_1',
  displayName: '玩家',
  mustChangePassword: false,
  chipBalance: 50_000,
};
const admin = {
  id: '00000000-0000-4000-8000-000000000002',
  username: 'admin',
  displayName: '管理员',
};
let built: PokerApp | undefined;
afterEach(async () => {
  built?.io.close();
  await built?.app.close();
  built = undefined;
});

async function setup() {
  const repository = {
    getUserBySession: vi.fn(async (token) => (token === 'user-session' ? user : null)),
    getAdminBySession: vi.fn(async (token) => (token === 'admin-session' ? admin : null)),
    changeUserPassword: vi.fn(async () => ({ user, sessionToken: 'new-user-session' })),
    updateUserProfile: vi.fn(async () => ({ user, sessionToken: 'new-user-session', roomIds: [] })),
    updateAdminProfile: vi.fn(async () => ({
      admin,
      sessionToken: 'new-admin-session',
      roomIds: [],
    })),
    deleteUserAccount: vi.fn(async () => true),
    loadRoom: vi.fn(
      async () =>
        ({ room: { createdByUserId: user.id } }) as { room: { createdByUserId: string } } | null,
    ),
  };
  const rooms = {
    setProjectionListener: vi.fn(),
    refreshPlayers: vi.fn(),
    adminReinstatePlayer: vi.fn(),
    ownerArchive: vi.fn(async () => true),
  };
  built = await buildApp({
    config,
    repository: repository as unknown as PokerRepository,
    rooms: rooms as unknown as RoomManager,
  });
  return { app: built.app, repository, rooms };
}

describe('account HTTP authorization', () => {
  it('changes only the authenticated user password and rotates the cookie without an old password', async () => {
    const { app, repository } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { cookie: `${USER_COOKIE}=user-session`, origin: config.PUBLIC_ORIGIN },
      payload: { userId: admin.id, newPassword: 'abc123' },
    });
    expect(response.statusCode).toBe(200);
    expect(repository.changeUserPassword).toHaveBeenCalledWith(user.id, 'abc123');
    expect(response.headers['set-cookie']).toContain(`${USER_COOKIE}=new-user-session`);
    expect(response.headers['set-cookie']).toContain('HttpOnly');
  });

  it('supports both profile password changes with just a new password', async () => {
    const { app, repository } = await setup();
    for (const [role, cookie] of [
      ['auth', USER_COOKIE],
      ['admin', ADMIN_COOKIE],
    ] as const) {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/${role}/profile`,
        headers: { cookie: `${cookie}=${role === 'auth' ? 'user' : 'admin'}-session` },
        payload: { newPassword: 'abc123' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['set-cookie']).toContain(cookie);
    }
    expect(repository.updateUserProfile).toHaveBeenCalledWith(user.id, { newPassword: 'abc123' });
    expect(repository.updateAdminProfile).toHaveBeenCalledWith(admin.id, { newPassword: 'abc123' });
  });

  it('rejects unauthenticated, cross-origin and too-short password changes before mutation', async () => {
    const { app, repository } = await setup();
    const unauthenticated = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      payload: { newPassword: 'abc123' },
    });
    expect(unauthenticated.statusCode).toBe(401);
    const foreign = await app.inject({
      method: 'PATCH',
      url: '/api/admin/profile',
      headers: { cookie: `${ADMIN_COOKIE}=admin-session`, origin: 'https://foreign.example' },
      payload: { newPassword: 'abc123' },
    });
    expect(foreign.statusCode).toBe(403);
    const tooShort = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { cookie: `${USER_COOKIE}=user-session` },
      payload: { newPassword: '12345' },
    });
    expect(tooShort.statusCode).toBe(400);
    expect(repository.changeUserPassword).not.toHaveBeenCalled();
    expect(repository.updateAdminProfile).not.toHaveBeenCalled();
  });

  it('requires an administrator and same-origin for deletion', async () => {
    const { app, repository } = await setup();
    const player = await app.inject({
      method: 'DELETE',
      url: `/api/admin/users/${user.id}`,
      headers: { cookie: `${USER_COOKIE}=user-session` },
    });
    expect(player.statusCode).toBe(401);
    const foreign = await app.inject({
      method: 'DELETE',
      url: `/api/admin/users/${user.id}`,
      headers: { cookie: `${ADMIN_COOKIE}=admin-session`, origin: 'https://foreign.example' },
    });
    expect(foreign.statusCode).toBe(403);
    expect(repository.deleteUserAccount).not.toHaveBeenCalled();
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/admin/users/${user.id}`,
      headers: { cookie: `${ADMIN_COOKIE}=admin-session`, origin: config.PUBLIC_ORIGIN },
    });
    expect(deleted.statusCode).toBe(204);
    expect(repository.deleteUserAccount).toHaveBeenCalledWith(admin.id, user.id);
  });

  it('maps an authoritative deleted-account restore conflict to 409', async () => {
    const { app, rooms } = await setup();
    rooms.adminReinstatePlayer.mockRejectedValueOnce(new Error('USER_NOT_FOUND'));
    const response = await app.inject({
      method: 'POST',
      url: `/api/admin/rooms/${admin.id}/players/${user.id}/restore`,
      headers: { cookie: `${ADMIN_COOKIE}=admin-session` },
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: 'CONFLICT',
      message: '玩家账号已删除，无法恢复牌局成员',
    });
  });

  it('maps unsettled deletion to 409 and missing accounts to 404', async () => {
    const { app, repository } = await setup();
    repository.deleteUserAccount.mockRejectedValueOnce(new Error('USER_ACCOUNT_IN_ROOM'));
    const request = {
      method: 'DELETE' as const,
      url: `/api/admin/users/${user.id}`,
      headers: { cookie: `${ADMIN_COOKIE}=admin-session` },
    };
    const conflict = await app.inject(request);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: 'USER_ACCOUNT_IN_ROOM' });
    repository.deleteUserAccount.mockResolvedValueOnce(false);
    const missing = await app.inject(request);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: 'USER_NOT_FOUND' });
  });
});

describe('room owner archive HTTP authorization', () => {
  const roomId = '00000000-0000-4000-8000-000000000003';
  const archiveUrl = `/api/rooms/${roomId}/archive`;

  it('rejects unauthenticated and cross-origin archive requests before reading or mutating the room', async () => {
    const { app, repository, rooms } = await setup();
    const unauthenticated = await app.inject({ method: 'POST', url: archiveUrl });
    expect(unauthenticated.statusCode).toBe(401);
    const foreign = await app.inject({
      method: 'POST',
      url: archiveUrl,
      headers: { cookie: `${USER_COOKIE}=user-session`, origin: 'https://foreign.example' },
    });
    expect(foreign.statusCode).toBe(403);
    expect(repository.loadRoom).not.toHaveBeenCalled();
    expect(rooms.ownerArchive).not.toHaveBeenCalled();
  });

  it('rejects a non-owner with 403 even if the body claims the owner identity', async () => {
    const { app, repository, rooms } = await setup();
    repository.loadRoom.mockResolvedValueOnce({ room: { createdByUserId: admin.id } });
    const response = await app.inject({
      method: 'POST',
      url: archiveUrl,
      headers: { cookie: `${USER_COOKIE}=user-session` },
      payload: { ownerUserId: admin.id },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'FORBIDDEN' });
    expect(repository.loadRoom).toHaveBeenCalledWith(roomId);
    expect(rooms.ownerArchive).not.toHaveBeenCalled();
  });

  it('returns 404 for a missing room without invoking archive', async () => {
    const { app, repository, rooms } = await setup();
    repository.loadRoom.mockResolvedValueOnce(null);
    const response = await app.inject({
      method: 'POST',
      url: archiveUrl,
      headers: { cookie: `${USER_COOKIE}=user-session` },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'NOT_FOUND' });
    expect(rooms.ownerArchive).not.toHaveBeenCalled();
  });

  it('returns 409 when the owner cannot archive during an active hand', async () => {
    const { app, rooms } = await setup();
    rooms.ownerArchive.mockResolvedValueOnce(false);
    const response = await app.inject({
      method: 'POST',
      url: archiveUrl,
      headers: { cookie: `${USER_COOKIE}=user-session` },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'ACTIVE_HAND' });
    expect(rooms.ownerArchive).toHaveBeenCalledExactlyOnceWith(roomId, user.id);
  });

  it('archives successfully using only the authenticated owner identity', async () => {
    const { app, repository, rooms } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: archiveUrl,
      headers: { cookie: `${USER_COOKIE}=user-session`, origin: config.PUBLIC_ORIGIN },
      payload: { ownerUserId: admin.id, roomId: admin.id },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, archived: true, cashedOut: true });
    expect(repository.loadRoom).toHaveBeenCalledExactlyOnceWith(roomId);
    expect(rooms.ownerArchive).toHaveBeenCalledExactlyOnceWith(roomId, user.id);
  });
});
