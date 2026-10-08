import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admins, auditLogs, createDatabase, rooms, userAccounts } from '@poker-with-friends/db';
import type {
  AdminUserSummary,
  CommandResult,
  RoomSnapshotEnvelope,
  UserSession,
} from '@poker-with-friends/protocol';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type PokerApp } from '../app.js';
import type { AppConfig } from '../config.js';
import { PokerRepository } from '../repository.js';
import { RoomManager } from '../room/manager.js';
import { ADMIN_COOKIE, USER_COOKIE } from '../security/cookies.js';

const databaseUrl = process.env.E2E_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
type Jar = Map<string, string>;
type CreatedRoom = { roomId: string; playerId: string; inviteUrl: string };
const settings = {
  mode: 'ONLINE',
  smallBlind: 10,
  bigBlind: 20,
  startingStack: 5_000,
  stackCap: 5_000,
  actionTimeoutSeconds: 180,
  resultDisplaySeconds: 1,
  nextHandCountdownSeconds: 1,
  maxPlayers: 6,
};

suite('administrator plays through ordinary HTTP and Socket.IO permissions', () => {
  const runId = randomUUID().replaceAll('-', '').slice(0, 12);
  const username = `admin_player_${runId}`;
  const password = 'Admin-Player-E2E!';
  const admin: Jar = new Map();
  const sockets: Socket[] = [];
  let app: PokerApp;
  let database: ReturnType<typeof createDatabase>;
  let baseUrl: string;
  let playerId: string;
  let loginClient = 0;
  const cookie = (jar: Jar): string => [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
  const request = async <T>(
    jar: Jar,
    method: string,
    path: string,
    body?: unknown,
    status = 200,
  ): Promise<T> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        cookie: cookie(jar),
        // Model independent clients for repeated logins without changing production limits.
        ...(path === '/api/admin/login' ? { 'x-forwarded-for': `192.0.2.${++loginClient}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(';', 1)[0]!;
      const split = pair.indexOf('=');
      const name = pair.slice(0, split);
      const value = pair.slice(split + 1);
      if (value) jar.set(name, value);
      else jar.delete(name);
    }
    const text = await response.text();
    const value: unknown = text ? JSON.parse(text) : null;
    expect(response.status, `${method} ${path}: ${text}`).toBe(status);
    return value as T;
  };
  const login = async (jar: Jar = admin): Promise<void> => {
    await request(jar, 'POST', '/api/admin/login', { username, password });
    expect(jar.has(ADMIN_COOKIE)).toBe(true);
    expect(jar.has(USER_COOKIE)).toBe(true);
  };
  const session = (jar: Jar = admin) => request<UserSession>(jar, 'GET', '/api/auth/session');
  const connect = async (jar: Jar, roomId: string, allowed = true): Promise<Socket> => {
    const socket = io(baseUrl, {
      transports: ['websocket'],
      extraHeaders: { Cookie: cookie(jar) },
      auth: { roomId },
      autoConnect: false,
      reconnection: false,
      timeout: 5_000,
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Socket connection timed out')), 8_000);
      socket.once('connect', () => {
        clearTimeout(timeout);
        allowed ? resolve() : reject(new Error('Non-member connected'));
      });
      socket.once('connect_error', (error) => {
        clearTimeout(timeout);
        allowed ? reject(error) : resolve();
      });
      socket.connect();
    });
    return socket;
  };

  const disconnected = (socket: Socket): Promise<void> =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Revoked session socket remained connected')),
        8_000,
      );
      socket.once('disconnect', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  const lobby = () =>
    request<CreatedRoom>(
      admin,
      'POST',
      '/api/rooms',
      {
        name: `Session revocation ${randomUUID()}`,
        settings,
      },
      201,
    );

  beforeAll(async () => {
    const config: AppConfig = {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: 3000,
      PUBLIC_ORIGIN: 'http://127.0.0.1',
      DATABASE_URL: databaseUrl!,
      COOKIE_SECRET: 'admin-player-e2e-cookie-secret-thirty-two-bytes',
      SNAPSHOT_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      TOKEN_PEPPER: 'admin-player-e2e-token-pepper-thirty-two-bytes',
      ADMIN_USERNAME: username,
      ADMIN_PASSWORD_HASH: await argon2.hash(password),
      TRUST_PROXY: true,
      RETENTION_DAYS: 30,
      ROOM_IDLE_HOURS: 12,
      APP_BUILD_SHA: 'e2e',
      WEB_DIST_DIR: join(tmpdir(), `admin-player-e2e-${runId}`),
    };
    database = createDatabase(databaseUrl!);
    const repository = new PokerRepository(database.db, config);
    await repository.ensureConfiguredAdmin();
    app = await buildApp({ config, repository, rooms: new RoomManager(repository) });
    baseUrl = await app.app.listen({ host: '127.0.0.1', port: 0 });
  }, 30_000);

  afterAll(async () => {
    for (const socket of sockets) socket.close();
    app?.io.close();
    if (app) await app.app.close();
    if (!database) return;
    const [configuredAdmin] = await database.db
      .select({ id: admins.id })
      .from(admins)
      .where(eq(admins.username, username));
    if (configuredAdmin)
      await database.db.transaction(async (tx) => {
        const accounts = await tx
          .select({ id: userAccounts.id })
          .from(userAccounts)
          .where(eq(userAccounts.createdByAdminId, configuredAdmin.id));
        for (const account of accounts)
          await tx.delete(rooms).where(eq(rooms.createdByUserId, account.id));
        await tx.delete(rooms).where(eq(rooms.createdByAdminId, configuredAdmin.id));
        await tx.delete(userAccounts).where(eq(userAccounts.createdByAdminId, configuredAdmin.id));
        await tx.delete(auditLogs).where(eq(auditLogs.adminId, configuredAdmin.id));
        await tx.delete(admins).where(eq(admins.id, configuredAdmin.id));
      });
    await database.client.end({ timeout: 5 });
  });

  it('lists its unique player account, owns an ordinary table, plays and cashes out', async () => {
    await login();
    const before = await session();
    playerId = before.id;
    expect(before).toMatchObject({ username, isAdmin: true, chipBalance: 50_000 });
    const users = await request<AdminUserSummary[]>(admin, 'GET', '/api/admin/users');
    expect(users.filter((user) => user.id === playerId)).toHaveLength(1);
    const room = await request<CreatedRoom>(
      admin,
      'POST',
      '/api/rooms',
      { name: `Admin table ${runId}`, settings },
      201,
    );
    expect((await session()).chipBalance).toBe(45_000);
    // Listen before connecting so the initial private snapshot cannot be missed.
    const socket = io(baseUrl, {
      transports: ['websocket'],
      extraHeaders: { Cookie: cookie(admin) },
      auth: { roomId: room.roomId },
      autoConnect: false,
      reconnection: false,
    });
    sockets.push(socket);
    const snapshot = new Promise<RoomSnapshotEnvelope>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Initial snapshot timed out')), 8_000);
      socket.once('room.snapshot', (value: RoomSnapshotEnvelope) => {
        clearTimeout(timeout);
        resolve(value);
      });
      socket.once('connect_error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    socket.connect();
    const initial = await snapshot;
    expect(initial.public.ownerPlayerId).toBe(room.playerId);
    expect(initial.public.seats[0]).toMatchObject({ playerId: room.playerId, stack: 5_000 });
    expect(initial.private?.playerId).toBe(room.playerId);
    const ready = await new Promise<CommandResult>((resolve, reject) => {
      socket
        .timeout(8_000)
        .emit(
          'player.ready',
          { commandId: randomUUID(), expectedSeq: initial.public.serverSeq, payload: {} },
          (error: Error | null, result: CommandResult) => (error ? reject(error) : resolve(result)),
        );
    });
    expect(ready.ok, JSON.stringify(ready)).toBe(true);
    socket.close();
    await request(admin, 'POST', `/api/rooms/${room.roomId}/archive`, {});
    expect((await session()).chipBalance).toBe(50_000);
    await login();
    expect(await session()).toMatchObject({ id: playerId, chipBalance: 50_000 });
    const again = await request<AdminUserSummary[]>(admin, 'GET', '/api/admin/users');
    expect(again.filter((user) => user.username === username)).toHaveLength(1);
  });

  it('restores legacy admin cookies and requires normal membership for public and private tables', async () => {
    await login();
    const legacy: Jar = new Map([[ADMIN_COOKIE, admin.get(ADMIN_COOKIE)!]]);
    expect(await session(legacy)).toMatchObject({ id: playerId, isAdmin: true });
    expect(legacy.has(USER_COOKIE)).toBe(true);
    const ordinary = await request<AdminUserSummary>(
      admin,
      'POST',
      '/api/admin/users',
      {
        username: `ordinary_${runId}`,
        displayName: 'Ordinary owner',
        password: 'aB3!x9',
      },
      201,
    );
    const owner: Jar = new Map();
    await request(owner, 'POST', '/api/auth/login', {
      username: ordinary.username,
      password: 'aB3!x9',
    });
    for (const visibility of ['PUBLIC', 'PRIVATE']) {
      const room = await request<CreatedRoom>(
        owner,
        'POST',
        '/api/rooms',
        { name: `${visibility} ${runId}`, settings, visibility },
        201,
      );
      const oldSocketCookie: Jar = new Map([[ADMIN_COOKIE, admin.get(ADMIN_COOKIE)!]]);
      await connect(oldSocketCookie, room.roomId, false);
      if (visibility === 'PUBLIC')
        await request(legacy, 'POST', `/api/rooms/${room.roomId}/enter`, {}, 201);
      else
        await request(
          legacy,
          'POST',
          `/api/rooms/${room.inviteUrl.split('/').at(-1)}/join`,
          {},
          201,
        );
      const socket = await connect(oldSocketCookie, room.roomId);
      socket.close();
      await request(legacy, 'POST', `/api/rooms/${room.roomId}/archive`, {}, 403);
      await request(owner, 'POST', `/api/rooms/${room.roomId}/archive`, {});
    }
    expect((await session(legacy)).chipBalance).toBe(50_000);
  });

  it('rotates both sessions through either profile entry point and isolates independent logins', async () => {
    for (const path of ['/api/auth/profile', '/api/admin/profile']) {
      await login();
      const old: Jar = new Map(admin);
      const independent: Jar = new Map();
      await login(independent);
      const room = await lobby();
      const activeSocket = await connect(old, room.roomId);
      const independentSocket = await connect(independent, room.roomId);
      const activeDisconnected = disconnected(activeSocket);
      const independentDisconnected = disconnected(independentSocket);
      await request(admin, 'PATCH', path, { newPassword: password });
      await Promise.all([activeDisconnected, independentDisconnected]);
      await connect(old, room.roomId, false);
      await connect(independent, room.roomId, false);
      expect(admin.get(ADMIN_COOKIE)).not.toBe(old.get(ADMIN_COOKIE));
      expect(admin.get(USER_COOKIE)).not.toBe(old.get(USER_COOKIE));
      expect(await session()).toMatchObject({ id: playerId, isAdmin: true });
      await request(old, 'GET', '/api/auth/session', undefined, 401);
      await request(old, 'GET', '/api/admin/users', undefined, 401);
      // Password updates revoke all older sessions, including independent logins.
      await request(independent, 'GET', '/api/auth/session', undefined, 401);
      await request(admin, 'POST', `/api/rooms/${room.roomId}/archive`, {});
    }
    const independent: Jar = new Map();
    await login(independent);
    const room = await lobby();
    const currentSocket = await connect(admin, room.roomId);
    const independentSocket = await connect(independent, room.roomId);
    const old = new Map(admin);
    const currentDisconnected = disconnected(currentSocket);
    await request(admin, 'POST', '/api/auth/logout', {}, 204);
    await currentDisconnected;
    await connect(old, room.roomId, false);
    expect(independentSocket.connected).toBe(true);
    await request(independent, 'POST', `/api/rooms/${room.roomId}/archive`, {});
    independentSocket.close();
    expect(await session(independent)).toMatchObject({ id: playerId, isAdmin: true });
  });

  it('clears both identities on logout and revokes admin privileges when switching to an ordinary account', async () => {
    await login();
    const room = await lobby();
    const stale: Jar = new Map(admin);
    const logoutSocket = await connect(stale, room.roomId);
    const logoutDisconnected = disconnected(logoutSocket);
    await request(admin, 'POST', '/api/auth/logout', {}, 204);
    await logoutDisconnected;
    await connect(stale, room.roomId, false);
    expect(admin.size).toBe(0);
    await request(stale, 'GET', '/api/auth/session', undefined, 401);
    await request(stale, 'GET', '/api/admin/users', undefined, 401);
    await login();
    const ordinary = await request<AdminUserSummary>(
      admin,
      'POST',
      '/api/admin/users',
      {
        username: `switch_${runId}`,
        displayName: 'Switch target',
        password: 'aB3!x9',
      },
      201,
    );
    const oldAdmin: Jar = new Map(admin);
    const switchingSocket = await connect(oldAdmin, room.roomId);
    const switchingDisconnected = disconnected(switchingSocket);
    await request(admin, 'POST', '/api/auth/login', {
      username: ordinary.username,
      password: 'aB3!x9',
    });
    await switchingDisconnected;
    await connect(oldAdmin, room.roomId, false);
    expect(admin.has(ADMIN_COOKIE)).toBe(false);
    expect(await session()).toMatchObject({ id: ordinary.id });
    await request(admin, 'GET', '/api/admin/users', undefined, 401);
    await request(oldAdmin, 'GET', '/api/admin/users', undefined, 401);
    await login();
    const beforeLogout: Jar = new Map(admin);
    const adminLogoutSocket = await connect(beforeLogout, room.roomId);
    const adminLogoutDisconnected = disconnected(adminLogoutSocket);
    await request(admin, 'POST', '/api/admin/logout', {}, 204);
    await adminLogoutDisconnected;
    await connect(beforeLogout, room.roomId, false);
    expect(admin.size).toBe(0);
    await request(beforeLogout, 'GET', '/api/auth/session', undefined, 401);
    await login();
    await request(admin, 'POST', `/api/rooms/${room.roomId}/archive`, {});
  });
});
