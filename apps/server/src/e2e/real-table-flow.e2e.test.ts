import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admins, auditLogs, createDatabase, rooms, userAccounts } from '@poker-with-friends/db';
import type {
  AdminUserSummary,
  CommandResult,
  HandHistoryItem,
  LobbyRoomSummary,
  PlayerAction,
  PrivatePlayerProjection,
  PublicRoomProjection,
  RoomMembershipResponse,
  RoomSnapshotEnvelope,
  UserRoomSummary,
  UserSession,
} from '@poker-with-friends/protocol';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { io as createSocket, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type PokerApp } from '../app.js';
import type { AppConfig } from '../config.js';
import { PokerRepository } from '../repository.js';
import { RoomManager } from '../room/manager.js';

const databaseUrl = process.env.E2E_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

interface HttpSession {
  cookie: string;
}

interface TestPlayer extends HttpSession {
  accountId: string;
  username: string;
  nickname: string;
  playerId: string;
}

interface CreatedRoom {
  roomId: string;
}

interface ActionHistory {
  seq: number;
  playerId: string;
  nickname: string;
  street: string;
  action: PlayerAction;
  amount: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function collectPlayerActions(history: HandHistoryItem): ActionHistory[] {
  const actions: ActionHistory[] = [];
  const visit = (type: string, payloadValue: unknown, seq: number): void => {
    const payload = asRecord(payloadValue);
    const preceding = Array.isArray(payload.precedingEvents) ? payload.precedingEvents : [];
    for (const nestedValue of preceding) {
      const nested = asRecord(nestedValue);
      if (typeof nested.type === 'string') {
        visit(nested.type, nested.payload ?? nested.publicPayload, seq);
      }
    }
    if (type !== 'PLAYER_ACTED') return;
    actions.push({
      seq,
      playerId: String(payload.playerId),
      nickname: String(payload.nickname),
      street: String(payload.street),
      action: payload.action as PlayerAction,
      amount: Number(payload.amount),
    });
  };
  for (const event of history.events) visit(event.type, event.publicPayload, event.seq);
  return actions;
}

describeWithDatabase('real HTTP + Socket.IO three-player table flow', () => {
  const adminPassword = 'Admin-E2E-Password!';
  const initialPassword = 'Initial-E2E-Password!';
  const changedPassword = 'Changed-E2E-Password!';
  const runId = randomUUID().replaceAll('-', '').slice(0, 12);
  const adminUsername = `e2e_admin_${runId}`;
  const admin: HttpSession = { cookie: '' };
  const sockets = new Map<string, Socket>();
  const privateByPlayer = new Map<string, PrivatePlayerProjection>();
  const createdAccountIds: string[] = [];
  let pokerApp: PokerApp | null = null;
  let database: ReturnType<typeof createDatabase> | null = null;
  let baseUrl = '';
  let publicRoom: PublicRoomProjection | null = null;

  const currentRoom = (): PublicRoomProjection => {
    if (!publicRoom) throw new Error('room projection has not arrived');
    return publicRoom;
  };

  const acceptEnvelope = (envelope: RoomSnapshotEnvelope): void => {
    if (!publicRoom || envelope.public.serverSeq >= publicRoom.serverSeq) {
      publicRoom = envelope.public;
    }
    if (envelope.private) privateByPlayer.set(envelope.private.playerId, envelope.private);
  };

  const acceptPublic = (projection: PublicRoomProjection): void => {
    if (!publicRoom || projection.serverSeq >= publicRoom.serverSeq) publicRoom = projection;
  };

  const waitFor = async (
    predicate: () => boolean,
    label: string,
    timeoutMs = 10_000,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const room = publicRoom;
    throw new Error(
      `Timed out waiting for ${label}: ${JSON.stringify({
        seq: room?.serverSeq,
        status: room?.status,
        phase: room?.phase,
        actor: room?.prompt?.playerId,
      })}`,
    );
  };

  const request = async <T>(
    session: HttpSession,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> => {
    const headers: Record<string, string> = {};
    if (session.cookie) headers.cookie = session.cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) session.cookie = setCookie.split(';', 1)[0] ?? '';
    const text = await response.text();
    const value = text.length === 0 ? null : (JSON.parse(text) as unknown);
    if (!response.ok) {
      throw new Error(`${method} ${path} returned ${response.status}: ${JSON.stringify(value)}`);
    }
    return value as T;
  };

  const emitRaw = async (
    playerId: string,
    event: string,
    envelope: Record<string, unknown>,
  ): Promise<CommandResult> => {
    const socket = sockets.get(playerId);
    if (!socket) throw new Error(`socket is missing for ${playerId}`);
    return new Promise<CommandResult>((resolve, reject) => {
      socket.timeout(8_000).emit(event, envelope, (error: Error | null, result: CommandResult) => {
        if (error) reject(error);
        else resolve(result);
      });
    });
  };

  const command = async (
    playerId: string,
    event: string,
    payload: Record<string, unknown>,
    needsTurn = false,
  ): Promise<Extract<CommandResult, { ok: true }>> => {
    if (needsTurn) {
      await waitFor(
        () =>
          currentRoom().prompt?.playerId === playerId &&
          typeof privateByPlayer.get(playerId)?.turnToken === 'string',
        `turn token for ${playerId}`,
      );
    }
    const room = currentRoom();
    const turnToken = needsTurn ? privateByPlayer.get(playerId)?.turnToken : undefined;
    const result = await emitRaw(playerId, event, {
      commandId: randomUUID(),
      expectedSeq: room.serverSeq,
      ...(turnToken ? { turnToken } : {}),
      payload,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error(result.message);
    acceptEnvelope(result.data);
    await waitFor(() => currentRoom().serverSeq >= result.serverSeq, `${event} acknowledgement`);
    return result;
  };

  const act = async (action: PlayerAction, amountTo?: number): Promise<void> => {
    const prompt = currentRoom().prompt;
    if (!prompt) throw new Error(`action prompt is missing for ${action}`);
    expect(prompt.legalActions).toContain(action);
    await command(
      prompt.playerId,
      'hand.act',
      { action, ...(amountTo === undefined ? {} : { amountTo }) },
      true,
    );
  };

  beforeAll(async () => {
    if (!databaseUrl) return;
    const config: AppConfig = {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: 3000,
      PUBLIC_ORIGIN: 'http://127.0.0.1',
      DATABASE_URL: databaseUrl,
      COOKIE_SECRET: 'e2e-cookie-secret-at-least-thirty-two-bytes',
      SNAPSHOT_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      TOKEN_PEPPER: 'e2e-token-pepper-at-least-thirty-two-bytes',
      ADMIN_USERNAME: adminUsername,
      ADMIN_PASSWORD_HASH: await argon2.hash(adminPassword),
      TRUST_PROXY: false,
      RETENTION_DAYS: 30,
      ROOM_IDLE_HOURS: 12,
      APP_BUILD_SHA: 'e2e',
      WEB_DIST_DIR: join(tmpdir(), `poker-e2e-no-web-${runId}`),
    };
    database = createDatabase(databaseUrl);
    const repository = new PokerRepository(database.db, config);
    await repository.ensureConfiguredAdmin();
    const rooms = new RoomManager(repository);
    pokerApp = await buildApp({ config, repository, rooms });
    baseUrl = await pokerApp.app.listen({ host: '127.0.0.1', port: 0 });
  }, 30_000);

  afterAll(async () => {
    for (const socket of sockets.values()) socket.close();
    pokerApp?.io.close();
    if (pokerApp) await pokerApp.app.close();
    if (database) {
      const [configuredAdmin] = await database.db
        .select({ id: admins.id })
        .from(admins)
        .where(eq(admins.username, adminUsername))
        .limit(1);
      if (configuredAdmin) {
        await database.db.transaction(async (tx) => {
          await tx.delete(rooms).where(eq(rooms.createdByAdminId, configuredAdmin.id));
          await tx
            .delete(userAccounts)
            .where(eq(userAccounts.createdByAdminId, configuredAdmin.id));
          await tx.delete(auditLogs).where(eq(auditLogs.adminId, configuredAdmin.id));
          await tx.delete(admins).where(eq(admins.id, configuredAdmin.id));
        });
      }
      await database.client.end({ timeout: 5 });
    }
  });

  it('plays four streets, preserves chips, records actions, and starts heads-up next hand', async () => {
    await request<UserSession>(admin, 'POST', '/api/admin/login', {
      username: adminUsername,
      password: adminPassword,
    });

    const players: TestPlayer[] = [];
    for (let index = 0; index < 3; index += 1) {
      const account = await request<AdminUserSummary>(admin, 'POST', '/api/admin/users', {
        username: `e2e_${runId}_${index + 1}`,
        displayName: `流程玩家${index + 1}`,
        password: initialPassword,
      });
      players.push({
        accountId: account.id,
        username: account.username,
        nickname: `玩家${index + 1}`,
        playerId: '',
        cookie: '',
      });
      createdAccountIds.push(account.id);
    }

    const duplicateAccountResponse = await fetch(`${baseUrl}/api/admin/users`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        username: players[0]!.username,
        displayName: '重复账号',
        password: initialPassword,
      }),
    });
    const duplicateAccountBody = (await duplicateAccountResponse.json()) as Record<string, unknown>;
    expect(duplicateAccountResponse.status).toBe(409);
    expect(duplicateAccountBody).toEqual({ error: 'USERNAME_TAKEN', message: '账号已存在' });
    expect(JSON.stringify(duplicateAccountBody)).not.toMatch(/insert into|argon2|password_hash/i);

    const room = await request<CreatedRoom>(admin, 'POST', '/api/admin/rooms', {
      name: `三人全流程-${runId}`,
      settings: {
        mode: 'ONLINE',
        smallBlind: 10,
        bigBlind: 20,
        startingStack: 2_000,
        stackCap: 2_000,
        actionTimeoutSeconds: 180,
        resultDisplaySeconds: 1,
        nextHandCountdownSeconds: 1,
        maxPlayers: 6,
      },
    });

    for (const player of players) {
      const membership = await request<RoomMembershipResponse>(
        admin,
        'POST',
        `/api/admin/rooms/${room.roomId}/players`,
        { userId: player.accountId, nickname: player.nickname },
      );
      player.playerId = membership.playerId;
      const login = await request<UserSession>(player, 'POST', '/api/auth/login', {
        username: player.username,
        password: initialPassword,
      });
      expect(login.mustChangePassword).toBe(true);
      const changed = await request<UserSession>(player, 'POST', '/api/auth/password', {
        currentPassword: initialPassword,
        newPassword: changedPassword,
      });
      expect(changed.mustChangePassword).toBe(false);
      const memberships = await request<UserRoomSummary[]>(player, 'GET', '/api/me/rooms');
      expect(memberships).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ roomId: room.roomId, playerId: player.playerId }),
        ]),
      );
    }

    for (const player of players) {
      const socket = createSocket(baseUrl, {
        path: '/socket.io/',
        transports: ['websocket'],
        extraHeaders: { Cookie: player.cookie },
        auth: { roomId: room.roomId },
        autoConnect: false,
        reconnection: false,
      });
      socket.on('room.snapshot', (envelope: RoomSnapshotEnvelope) => acceptEnvelope(envelope));
      socket.on('room.public', (projection: PublicRoomProjection) => acceptPublic(projection));
      socket.on('room.private', (projection: PrivatePlayerProjection) => {
        privateByPlayer.set(projection.playerId, projection);
      });
      sockets.set(player.playerId, socket);
      const connected = new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', reject);
      });
      socket.connect();
      await connected;
      await waitFor(
        () => privateByPlayer.has(player.playerId),
        `initial private projection for ${player.playerId}`,
      );
    }

    for (const [seat, player] of players.entries()) {
      await command(player.playerId, 'seat.claim', { seat });
    }
    expect(currentRoom()).not.toHaveProperty('message');
    expect(currentRoom().requiredReadyCount).toBe(3);

    const staleSeq = currentRoom().serverSeq;
    const stale = await emitRaw(players[0]!.playerId, 'player.ready', {
      commandId: randomUUID(),
      expectedSeq: staleSeq - 1,
      payload: {},
    });
    expect(stale).toMatchObject({ ok: false, code: 'STALE_SEQUENCE', serverSeq: staleSeq });
    expect(currentRoom().serverSeq).toBe(staleSeq);

    for (const player of players) await command(player.playerId, 'player.ready', {});
    await waitFor(
      () => currentRoom().status === 'ACTIVE' && currentRoom().phase === 'PREFLOP',
      'first hand start',
    );
    const firstHandNumber = currentRoom().handNumber;
    const firstButton = currentRoom().buttonSeat;
    expect(firstButton).not.toBeNull();
    expect(currentRoom().actingSeat).toBe(firstButton);

    const openingPrompt = currentRoom().prompt;
    if (!openingPrompt?.minRaiseTo) throw new Error('pre-flop minimum raise is missing');
    await waitFor(
      () => typeof privateByPlayer.get(openingPrompt.playerId)?.turnToken === 'string',
      'opening turn token',
    );
    const openingEnvelope = {
      commandId: randomUUID(),
      expectedSeq: currentRoom().serverSeq,
      turnToken: privateByPlayer.get(openingPrompt.playerId)!.turnToken!,
      payload: { action: 'RAISE_TO', amountTo: openingPrompt.minRaiseTo },
    };
    const opened = await emitRaw(openingPrompt.playerId, 'hand.act', openingEnvelope);
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(opened.message);
    acceptEnvelope(opened.data);
    const openingSeat = currentRoom().seats.find(
      (seat) => seat.playerId === openingPrompt.playerId,
    );
    const openingSnapshot = {
      seq: currentRoom().serverSeq,
      stack: openingSeat?.stack,
      committedStreet: openingSeat?.committedStreet,
      committedHand: openingSeat?.committedHand,
    };

    const duplicate = await emitRaw(openingPrompt.playerId, 'hand.act', openingEnvelope);
    expect(duplicate).toEqual(opened);
    const openingPlayer = players.find((player) => player.playerId === openingPrompt.playerId)!;
    const authoritative = await request<RoomSnapshotEnvelope>(
      openingPlayer,
      'GET',
      `/api/rooms/${room.roomId}`,
    );
    const authoritativeSeat = authoritative.public.seats.find(
      (seat) => seat.playerId === openingPrompt.playerId,
    );
    expect({
      seq: authoritative.public.serverSeq,
      stack: authoritativeSeat?.stack,
      committedStreet: authoritativeSeat?.committedStreet,
      committedHand: authoritativeSeat?.committedHand,
    }).toEqual(openingSnapshot);
    acceptEnvelope(authoritative);

    let guard = 0;
    while (currentRoom().status === 'ACTIVE' && currentRoom().phase === 'PREFLOP') {
      if (guard++ > 4) throw new Error('pre-flop action loop exceeded its bound');
      await act('CALL');
    }
    await waitFor(() => currentRoom().phase === 'FLOP', 'flop');
    expect(currentRoom().actingSeat).toBe(currentRoom().smallBlindSeat);
    await act('CHECK');
    const flopBet = currentRoom().prompt?.minBetTo;
    if (!flopBet) throw new Error('flop minimum bet is missing');
    await act('BET_TO', flopBet);
    await act('FOLD');
    await act('CALL');

    await waitFor(() => currentRoom().phase === 'TURN', 'turn');
    guard = 0;
    while (currentRoom().status === 'ACTIVE' && currentRoom().phase === 'TURN') {
      if (guard++ > 3) throw new Error('turn action loop exceeded its bound');
      await act('CHECK');
    }

    await waitFor(() => currentRoom().phase === 'RIVER', 'river');
    await act('ALL_IN');
    if (currentRoom().status === 'ACTIVE') await act('CALL');
    await waitFor(
      () => currentRoom().status === 'BETWEEN_HANDS' && currentRoom().phase === 'SETTLED',
      'showdown settlement',
      15_000,
    );

    const settled = structuredClone(currentRoom());
    const occupied = settled.seats.filter((seat) => seat.playerId !== null);
    expect(occupied.reduce((sum, seat) => sum + seat.stack, 0)).toBe(6_000);
    expect(settled.readyCount).toBe(0);

    const histories = await request<HandHistoryItem[]>(
      players[0]!,
      'GET',
      `/api/rooms/${room.roomId}/history`,
    );
    const firstHand = histories.find((hand) => hand.handNumber === firstHandNumber);
    expect(firstHand).toBeDefined();
    const actions = collectPlayerActions(firstHand!);
    expect(actions).toHaveLength(11);
    expect(actions.every((action) => action.playerId && action.nickname && action.street)).toBe(
      true,
    );
    expect(new Set(actions.map((action) => action.action))).toEqual(
      new Set<PlayerAction>(['RAISE_TO', 'CALL', 'CHECK', 'BET_TO', 'FOLD', 'ALL_IN']),
    );

    const positive = currentRoom().seats.filter((seat) => seat.playerId && seat.stack > 0);
    if (positive.length === 3) {
      await request(
        admin,
        'POST',
        `/api/admin/rooms/${room.roomId}/players/${positive[2]!.playerId}/chips`,
        {
          stack: 0,
          reason: 'E2E deterministic heads-up transition',
          operationId: randomUUID(),
        },
      );
      await waitFor(() => currentRoom().requiredReadyCount === 2, 'zero-stack exclusion');
    }
    const eligible = currentRoom()
      .seats.filter(
        (seat) => seat.playerId !== null && seat.connected && !seat.sittingOut && seat.stack > 0,
      )
      .sort((left, right) => left.seat - right.seat);
    expect(eligible).toHaveLength(2);
    expect(currentRoom().requiredReadyCount).toBe(2);
    const zeroStackPlayer = currentRoom().seats.find(
      (seat) => seat.playerId !== null && seat.stack === 0,
    );
    expect(zeroStackPlayer).toBeDefined();

    const expectedButton =
      eligible.find((seat) => seat.seat > firstButton!)?.seat ?? eligible[0]!.seat;
    for (const seat of eligible) await command(seat.playerId!, 'player.ready', {});
    await waitFor(
      () => currentRoom().status === 'ACTIVE' && currentRoom().handNumber === firstHandNumber + 1,
      'second hand start',
      15_000,
    );
    expect(currentRoom().buttonSeat).toBe(expectedButton);
    expect(currentRoom().smallBlindSeat).toBe(expectedButton);
    expect(currentRoom().actingSeat).toBe(expectedButton);
    const headsUpSeats = currentRoom().seats.filter((seat) => seat.positions.length > 0);
    expect(headsUpSeats).toHaveLength(2);
    expect(headsUpSeats.find((seat) => seat.seat === expectedButton)?.positions).toEqual([
      'BTN',
      'SB',
    ]);
    expect(headsUpSeats.find((seat) => seat.seat !== expectedButton)?.positions).toEqual(['BB']);
    const skipped = currentRoom().seats.find((seat) => seat.playerId === zeroStackPlayer!.playerId);
    expect(skipped).toMatchObject({ stack: 0, positions: [], hasCards: false });
  }, 60_000);

  it('lists every open room and completes a directly joined LIVE table flow', async () => {
    const liveRoomCreated = await request<CreatedRoom>(admin, 'POST', '/api/admin/rooms', {
      name: `线下全流程-${runId}`,
      settings: {
        mode: 'LIVE',
        smallBlind: 10,
        bigBlind: 20,
        startingStack: 2_000,
        stackCap: 2_000,
        actionTimeoutSeconds: 180,
        resultDisplaySeconds: 1,
        nextHandCountdownSeconds: 1,
        maxPlayers: 6,
      },
    });

    const livePlayers: TestPlayer[] = [];
    for (let index = 0; index < 2; index += 1) {
      const account = await request<AdminUserSummary>(admin, 'POST', '/api/admin/users', {
        username: `live_${runId}_${index + 1}`,
        displayName: `线下玩家${index + 1}`,
        password: initialPassword,
      });
      createdAccountIds.push(account.id);
      const player: TestPlayer = {
        accountId: account.id,
        username: account.username,
        nickname: account.displayName,
        playerId: '',
        cookie: '',
      };
      await request<UserSession>(player, 'POST', '/api/auth/login', {
        username: player.username,
        password: initialPassword,
      });
      await request<UserSession>(player, 'POST', '/api/auth/password', {
        currentPassword: initialPassword,
        newPassword: changedPassword,
      });

      const beforeJoin = await request<LobbyRoomSummary[]>(player, 'GET', '/api/rooms');
      expect(beforeJoin.find((room) => room.roomId === liveRoomCreated.roomId)).toMatchObject({
        name: `线下全流程-${runId}`,
        mode: 'LIVE',
        membership: null,
      });
      const membership = await request<RoomMembershipResponse>(
        player,
        'POST',
        `/api/rooms/${liveRoomCreated.roomId}/enter`,
        {},
      );
      player.playerId = membership.playerId;
      livePlayers.push(player);

      const afterJoin = await request<LobbyRoomSummary[]>(player, 'GET', '/api/rooms');
      expect(afterJoin.find((room) => room.roomId === liveRoomCreated.roomId)).toMatchObject({
        playerCount: index + 1,
        availableSeats: 5 - index,
        membership: { playerId: player.playerId, status: 'ACTIVE', seat: null },
      });
    }

    let liveRoom: PublicRoomProjection | null = null;
    const livePrivate = new Map<string, PrivatePlayerProjection>();
    const currentLiveRoom = (): PublicRoomProjection => {
      if (!liveRoom) throw new Error('LIVE room projection has not arrived');
      return liveRoom;
    };
    const acceptLiveEnvelope = (envelope: RoomSnapshotEnvelope): void => {
      if (!liveRoom || envelope.public.serverSeq >= liveRoom.serverSeq) liveRoom = envelope.public;
      if (envelope.private) livePrivate.set(envelope.private.playerId, envelope.private);
    };
    const waitForLive = async (predicate: () => boolean, label: string): Promise<void> => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`Timed out waiting for LIVE ${label}`);
    };

    for (const player of livePlayers) {
      const socket = createSocket(baseUrl, {
        path: '/socket.io/',
        transports: ['websocket'],
        extraHeaders: { Cookie: player.cookie },
        auth: { roomId: liveRoomCreated.roomId },
        autoConnect: false,
        reconnection: false,
      });
      socket.on('room.snapshot', acceptLiveEnvelope);
      socket.on('room.public', (projection: PublicRoomProjection) => {
        if (!liveRoom || projection.serverSeq >= liveRoom.serverSeq) liveRoom = projection;
      });
      socket.on('room.private', (projection: PrivatePlayerProjection) => {
        livePrivate.set(projection.playerId, projection);
      });
      sockets.set(player.playerId, socket);
      const connected = new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', reject);
      });
      socket.connect();
      await connected;
      await waitForLive(
        () => livePrivate.has(player.playerId),
        `private state for ${player.playerId}`,
      );
    }

    const liveCommand = async (
      playerId: string,
      event: string,
      payload: Record<string, unknown>,
      needsTurn = false,
    ): Promise<void> => {
      if (needsTurn) {
        await waitForLive(
          () =>
            currentLiveRoom().prompt?.playerId === playerId &&
            typeof livePrivate.get(playerId)?.turnToken === 'string',
          `turn for ${playerId}`,
        );
      }
      const socket = sockets.get(playerId);
      if (!socket) throw new Error(`LIVE socket missing for ${playerId}`);
      const result = await new Promise<CommandResult>((resolve, reject) => {
        socket.timeout(8_000).emit(
          event,
          {
            commandId: randomUUID(),
            expectedSeq: currentLiveRoom().serverSeq,
            ...(needsTurn ? { turnToken: livePrivate.get(playerId)?.turnToken } : {}),
            payload,
          },
          (error: Error | null, commandResult: CommandResult) => {
            if (error) reject(error);
            else resolve(commandResult);
          },
        );
      });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error(result.message);
      acceptLiveEnvelope(result.data);
    };

    for (const [seat, player] of livePlayers.entries()) {
      await liveCommand(player.playerId, 'seat.claim', { seat });
      expect(currentLiveRoom().seats[seat]).toMatchObject({
        playerId: player.playerId,
        isActing: false,
      });
      expect(livePrivate.get(player.playerId)?.seat).toBe(seat);
    }
    expect(currentLiveRoom().requiredReadyCount).toBe(2);

    for (const player of livePlayers) await liveCommand(player.playerId, 'player.ready', {});
    await waitForLive(
      () => currentLiveRoom().status === 'ACTIVE' && currentLiveRoom().phase === 'PREFLOP',
      'hand start',
    );

    const finishLiveBettingRound = async (): Promise<void> => {
      let guard = 0;
      while (currentLiveRoom().prompt) {
        if (guard++ > 4) throw new Error('LIVE betting round exceeded its bound');
        const prompt = currentLiveRoom().prompt!;
        const action: PlayerAction = prompt.legalActions.includes('CHECK') ? 'CHECK' : 'CALL';
        await liveCommand(prompt.playerId, 'hand.act', { action }, true);
      }
    };

    await finishLiveBettingRound();
    for (const street of ['FLOP', 'TURN', 'RIVER'] as const) {
      expect(currentLiveRoom().pendingLiveStreet).toBe(street);
      const dealer = currentLiveRoom().seats.find(
        (seat) => seat.seat === currentLiveRoom().liveDealerSeat,
      );
      if (!dealer?.playerId) throw new Error('LIVE dealer is missing');
      await liveCommand(dealer.playerId, 'live.streetDealt', { street });
      await finishLiveBettingRound();
    }
    expect(currentLiveRoom().phase).toBe('SHOWDOWN');

    const dealer = currentLiveRoom().seats.find(
      (seat) => seat.seat === currentLiveRoom().liveDealerSeat,
    );
    if (!dealer?.playerId) throw new Error('LIVE showdown dealer is missing');
    const objector = livePlayers.find((player) => player.playerId !== dealer.playerId)!;
    const winnersByPot = Object.fromEntries(
      currentLiveRoom().pots.map((pot) => [pot.id, [pot.eligiblePlayerIds[0]!]]),
    );
    await liveCommand(dealer.playerId, 'live.resultPropose', { winnersByPot });
    const firstProposal = currentLiveRoom().liveResultProposal;
    if (!firstProposal) throw new Error('first LIVE proposal is missing');
    await liveCommand(objector.playerId, 'live.resultObject', { proposalId: firstProposal.id });
    await liveCommand(dealer.playerId, 'live.resultPropose', { winnersByPot });
    const replacement = currentLiveRoom().liveResultProposal;
    if (!replacement) throw new Error('replacement LIVE proposal is missing');
    await liveCommand(objector.playerId, 'live.resultConfirm', { proposalId: replacement.id });

    expect(currentLiveRoom().status).toBe('BETWEEN_HANDS');
    expect(currentLiveRoom().phase).toBe('SETTLED');
    expect(
      currentLiveRoom().seats.reduce((sum, seat) => sum + (seat.playerId ? seat.stack : 0), 0),
    ).toBe(4_000);
  }, 60_000);

  it('serializes concurrent joins so a six-player room never overfills', async () => {
    const capacityAccountIds = createdAccountIds.slice(0, 3);
    for (let index = 0; index < 4; index += 1) {
      const account = await request<AdminUserSummary>(admin, 'POST', '/api/admin/users', {
        username: `capacity_${runId}_${index + 1}`,
        displayName: `并发玩家${index + 1}`,
        password: initialPassword,
      });
      createdAccountIds.push(account.id);
      capacityAccountIds.push(account.id);
    }

    const room = await request<CreatedRoom>(admin, 'POST', '/api/admin/rooms', {
      name: `并发容量-${runId}`,
      settings: {
        mode: 'LIVE',
        smallBlind: 10,
        bigBlind: 20,
        startingStack: 2_000,
        stackCap: 2_000,
        actionTimeoutSeconds: 30,
        resultDisplaySeconds: 1,
        nextHandCountdownSeconds: 1,
        maxPlayers: 6,
      },
    });

    const results = await Promise.all(
      capacityAccountIds.map(async (userId, index) => {
        const response = await fetch(`${baseUrl}/api/admin/rooms/${room.roomId}/players`, {
          method: 'POST',
          headers: { cookie: admin.cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ userId, nickname: `容量玩家${index + 1}` }),
        });
        return {
          status: response.status,
          body: (await response.json()) as Record<string, unknown>,
        };
      }),
    );

    expect(results.filter((result) => result.status === 201)).toHaveLength(6);
    expect(results.filter((result) => result.status === 409)).toEqual([
      expect.objectContaining({ body: { error: 'ROOM_FULL', message: '牌桌已满' } }),
    ]);
  }, 30_000);
});
