import { randomUUID } from 'node:crypto';
import {
  accountLedgerEntries,
  admins,
  auditLogs,
  createDatabase,
  ledgerEntries,
  players,
  rooms,
  userAccounts,
} from '@poker-with-friends/db';
import { DEFAULT_ROOM_SETTINGS } from '@poker-with-friends/protocol';
import argon2 from 'argon2';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config.js';
import { PokerRepository } from '../repository.js';
import { RoomActor } from '../room/actor.js';

const databaseUrl = process.env.E2E_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const settings = {
  mode: 'ONLINE' as const,
  ...DEFAULT_ROOM_SETTINGS,
  startingStack: 1_000,
  stackCap: 5_000,
};

describeWithDatabase('PostgreSQL room chip settlement', { timeout: 60_000 }, () => {
  const runId = randomUUID().slice(0, 8);
  const accountIds: string[] = [];
  const roomIds: string[] = [];
  let database: ReturnType<typeof createDatabase>;
  let repository: PokerRepository;
  let admin: { id: string; username: string; displayName: string };

  beforeAll(async () => {
    const config: AppConfig = {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: 3000,
      PUBLIC_ORIGIN: 'http://127.0.0.1',
      DATABASE_URL: databaseUrl!,
      COOKIE_SECRET: 'settlement-tests-cookie-secret-at-least-thirty-two-bytes',
      SNAPSHOT_KEY: Buffer.alloc(32, 2).toString('base64'),
      TOKEN_PEPPER: 'settlement-tests-pepper-at-least-thirty-two-bytes',
      ADMIN_USERNAME: `settle_admin_${runId}`,
      ADMIN_PASSWORD_HASH: await argon2.hash('bootstrap'),
      TRUST_PROXY: false,
      RETENTION_DAYS: 30,
      ROOM_IDLE_HOURS: 12,
      APP_BUILD_SHA: 'test',
      WEB_DIST_DIR: 'missing',
    };
    database = createDatabase(databaseUrl!);
    repository = new PokerRepository(database.db, config);
    await repository.ensureConfiguredAdmin();
    admin = (await repository.verifyAdmin(config.ADMIN_USERNAME, 'bootstrap'))!;
  }, 30_000);

  afterAll(async () => {
    if (!database) return;
    if (roomIds.length) {
      await database.db
        .delete(accountLedgerEntries)
        .where(inArray(accountLedgerEntries.roomId, roomIds));
      await database.db.delete(rooms).where(inArray(rooms.id, roomIds));
    }
    if (accountIds.length)
      await database.db.delete(userAccounts).where(inArray(userAccounts.id, accountIds));
    if (admin) {
      await database.db.delete(auditLogs).where(eq(auditLogs.adminId, admin.id));
      await database.db.delete(admins).where(eq(admins.id, admin.id));
    }
    await database.client.end({ timeout: 5 });
  }, 60_000);

  async function account() {
    const created = await repository.createUserAccount(admin.id, {
      username: `settle_${randomUUID().slice(0, 8)}`,
      displayName: '测试玩家',
      password: 'abc123',
    });
    accountIds.push(created.id);
    return created;
  }

  async function table(input?: Awaited<ReturnType<typeof account>>) {
    const user = input ?? (await account());
    const created = await repository.createUserRoom(user, 'settlement test', settings);
    roomIds.push(created.roomId);
    const actor = new RoomActor(
      (await repository.loadRoom(created.roomId))!,
      repository,
      () => undefined,
    );
    return { ...created, actor, user };
  }

  async function balance(userId: string) {
    const [row] = await database.db.select().from(userAccounts).where(eq(userAccounts.id, userId));
    return row!.chipBalance;
  }

  async function cashouts(roomId: string) {
    return database.db
      .select()
      .from(accountLedgerEntries)
      .where(
        and(
          eq(accountLedgerEntries.roomId, roomId),
          eq(accountLedgerEntries.kind, 'ROOM_CASH_OUT'),
        ),
      );
  }

  async function startHand(mode: 'ONLINE' | 'LIVE' = 'ONLINE') {
    const first = await account();
    const second = await account();
    const created = await repository.createUserRoom(first, 'active settlement test', {
      ...settings,
      mode,
    });
    roomIds.push(created.roomId);
    const joined = await repository.addUserToRoom(created.roomId, second.id, 'ADMIN', admin.id);
    const actor = new RoomActor(
      (await repository.loadRoom(created.roomId))!,
      repository,
      () => undefined,
    );
    await actor.seatClaim(joined.playerId, {
      commandId: randomUUID(),
      expectedSeq: actor.state.serverSeq,
      payload: { seat: 1 },
    });
    for (const playerId of [created.playerId, joined.playerId])
      await actor.setConnected(playerId, true);
    for (const playerId of [created.playerId, joined.playerId]) {
      expect(
        (
          await actor.ready(playerId, {
            commandId: randomUUID(),
            expectedSeq: actor.state.serverSeq,
            payload: {},
          })
        ).ok,
      ).toBe(true);
    }
    expect(actor.state.status).toBe('ACTIVE');
    return { ...created, actor, first, second };
  }

  it('cashes out every member, including an unseated late join and a kicked player, exactly once', async () => {
    const created = await table();
    const late = await account();
    const joined = await repository.addUserToRoom(created.roomId, late.id, 'ADMIN', admin.id);
    // This join intentionally never refreshes the old actor snapshot.
    await database.db
      .update(players)
      .set({ membershipStatus: 'KICKED' })
      .where(eq(players.id, joined.playerId));
    expect(await created.actor.ownerArchive(late.id)).toBe(false);
    expect(await created.actor.ownerArchive(created.user.id)).toBe(true);
    expect(await balance(created.user.id)).toBe(50_000);
    expect(await balance(late.id)).toBe(50_000);
    expect(created.actor.state.players.every((player) => player.stack === 0)).toBe(true);
    const recovered = new RoomActor(
      (await repository.loadRoom(created.roomId))!,
      repository,
      () => undefined,
    );
    expect(recovered.state.players).toHaveLength(2);
    expect(recovered.state.players.every((player) => player.stack === 0)).toBe(true);
    expect(await recovered.adminArchive(admin.id)).toBe(true);
    expect(await cashouts(created.roomId)).toHaveLength(2);
    const tableLedger = await database.db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.roomId, created.roomId), eq(ledgerEntries.kind, 'CASH_OUT')));
    expect(tableLedger).toHaveLength(2);
    expect(tableLedger.reduce((total, entry) => total + entry.delta, 0)).toBe(-2_000);
    await expect(
      repository.addUserToRoom(created.roomId, late.id, 'ADMIN', admin.id),
    ).rejects.toThrow('ROOM_NOT_FOUND');
  });

  it('keeps ordinary hand winnings on the table until the owner ends the room', async () => {
    const created = await startHand();
    const hand = created.actor.state.hand!;
    expect(
      (
        await created.actor.act(hand.betting.actorId!, {
          commandId: randomUUID(),
          expectedSeq: created.actor.state.serverSeq,
          turnToken: hand.turnToken!,
          payload: { action: 'FOLD' },
        })
      ).ok,
    ).toBe(true);
    expect(created.actor.state.status).toBe('BETWEEN_HANDS');
    expect(created.actor.state.players.reduce((sum, player) => sum + player.stack, 0)).toBe(2_000);
    expect(await balance(created.first.id)).toBe(49_000);
    expect(await cashouts(created.roomId)).toHaveLength(0);
    const stacks = new Map(
      created.actor.state.players.map((player) => [player.userId, player.stack]),
    );
    expect(await created.actor.ownerArchive(created.first.id)).toBe(true);
    expect(await balance(created.first.id)).toBe(49_000 + stacks.get(created.first.id)!);
    expect(await balance(created.second.id)).toBe(49_000 + stacks.get(created.second.id)!);
  });

  it.each(['ONLINE', 'LIVE'] as const)(
    'refunds committed bets before %s force-abort cashout',
    async (mode) => {
      const created = await startHand(mode);
      expect(await created.actor.adminArchive(admin.id)).toBe(false);
      expect(await created.actor.ownerArchive(created.first.id)).toBe(false);
      if (mode === 'LIVE') {
        created.actor.state.status = 'DISPUTED';
        await database.db
          .update(rooms)
          .set({ status: 'DISPUTED' })
          .where(eq(rooms.id, created.roomId));
      }
      expect(await created.actor.adminForceAbort(admin.id)).toBe(true);
      expect(created.actor.state.hand?.result).toEqual({ reason: 'FORCE_ABORT_REFUND' });
      expect(await balance(created.first.id)).toBe(50_000);
      expect(await balance(created.second.id)).toBe(50_000);
      expect(await cashouts(created.roomId)).toHaveLength(2);
      expect(created.actor.state.players.every((player) => player.stack === 0)).toBe(true);
      expect(await created.actor.adminForceAbort(admin.id)).toBe(true);
      expect(await cashouts(created.roomId)).toHaveLength(2);
    },
  );

  it('rolls back account credits, table debits and archive status when the final audit insert fails', async () => {
    const created = await table();
    await expect(created.actor.adminArchive(randomUUID())).rejects.toThrow();
    expect(await balance(created.user.id)).toBe(49_000);
    expect(await cashouts(created.roomId)).toHaveLength(0);
    const loaded = (await repository.loadRoom(created.roomId))!;
    expect(loaded.room.status).toBe('LOBBY');
    expect(loaded.players[0]!.stack).toBe(1_000);
    expect(created.actor.state.status).toBe('LOBBY');
    expect(await created.actor.adminArchive(admin.id)).toBe(true);
    expect(await balance(created.user.id)).toBe(50_000);
  });

  it('does not double-credit a retry after the successful commit response is lost', async () => {
    const created = await table();
    const original = repository.commitRoom.bind(repository);
    let loseResponse = true;
    const wrapped = Object.create(repository) as PokerRepository;
    wrapped.commitRoom = async (commit) => {
      await original(commit);
      if (loseResponse) {
        loseResponse = false;
        throw new Error('lost response');
      }
    };
    const actor = new RoomActor(
      (await repository.loadRoom(created.roomId))!,
      wrapped,
      () => undefined,
    );
    await expect(actor.adminArchive(admin.id)).rejects.toThrow('lost response');
    expect(actor.state.status).toBe('ARCHIVED');
    expect(await actor.adminArchive(admin.id)).toBe(true);
    expect(await balance(created.user.id)).toBe(50_000);
    expect(await cashouts(created.roomId)).toHaveLength(1);
  });

  it('uses current shared balances for stale topups and concurrent cashouts in two rooms', async () => {
    const user = await account();
    const one = await table(user);
    const two = await table(user);
    for (const created of [one, two]) {
      expect(
        (
          await created.actor.topUp(created.playerId, {
            commandId: randomUUID(),
            expectedSeq: created.actor.state.serverSeq,
            payload: { targetStack: 5_000 },
          })
        ).ok,
      ).toBe(true);
    }
    expect(await balance(user.id)).toBe(40_000);
    await Promise.all([one.actor.adminArchive(admin.id), two.actor.adminArchive(admin.id)]);
    expect(await balance(user.id)).toBe(50_000);
    expect(await cashouts(one.roomId)).toHaveLength(1);
    expect(await cashouts(two.roomId)).toHaveLength(1);
  });

  it('reconciles old archived stacks once and keeps recovered snapshots at zero', async () => {
    const created = await table();
    // Reproduce the historical archive path that left a positive table stack behind.
    await database.db
      .update(rooms)
      .set({ status: 'ARCHIVED', archivedAt: new Date() })
      .where(eq(rooms.id, created.roomId));
    expect(await repository.reconcileArchivedRoomChips([created.roomId])).toBe(1);
    expect(await repository.reconcileArchivedRoomChips([created.roomId])).toBe(0);
    expect(await balance(created.user.id)).toBe(50_000);
    expect(await cashouts(created.roomId)).toHaveLength(1);
    const recovered = new RoomActor(
      (await repository.loadRoom(created.roomId))!,
      repository,
      () => undefined,
    );
    expect(recovered.state.status).toBe('ARCHIVED');
    expect(recovered.state.players[0]!.stack).toBe(0);
  });

  it('rejects an unaffordable topup using the database balance and accepts a later replenishment', async () => {
    const created = await table();
    await database.db
      .update(userAccounts)
      .set({ chipBalance: 3_000 })
      .where(eq(userAccounts.id, created.user.id));
    const rejectedCommand = {
      commandId: randomUUID(),
      expectedSeq: created.actor.state.serverSeq,
      payload: { targetStack: 5_000 },
    };
    const refused = await created.actor.topUp(created.playerId, rejectedCommand);
    expect(refused).toMatchObject({ ok: false, code: 'CONFLICT' });
    expect(await balance(created.user.id)).toBe(3_000);
    expect(created.actor.state.players[0]!.stack).toBe(1_000);
    await database.db
      .update(userAccounts)
      .set({ chipBalance: 5_000 })
      .where(eq(userAccounts.id, created.user.id));
    expect(await created.actor.topUp(created.playerId, rejectedCommand)).toEqual(refused);
    const accepted = await created.actor.topUp(created.playerId, {
      commandId: randomUUID(),
      expectedSeq: created.actor.state.serverSeq,
      payload: { targetStack: 5_000 },
    });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.data?.private?.accountChips).toBe(1_000);
    expect(await balance(created.user.id)).toBe(1_000);
  });

  it('fences two actors ending the same room so only one cashout is credited', async () => {
    const created = await table();
    const rival = new RoomActor(
      (await repository.loadRoom(created.roomId))!,
      repository,
      () => undefined,
    );
    const outcomes = await Promise.allSettled([
      created.actor.adminArchive(admin.id),
      rival.adminArchive(admin.id),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(await balance(created.user.id)).toBe(50_000);
    expect(await cashouts(created.roomId)).toHaveLength(1);
    expect(created.actor.state.status).toBe('ARCHIVED');
    expect(rival.state.status).toBe('ARCHIVED');
    expect(await rival.adminArchive(admin.id)).toBe(true);
    expect(await cashouts(created.roomId)).toHaveLength(1);
  });

  it('locks shared account rows in a consistent order across rooms with reversed member order', async () => {
    const a = await account();
    const b = await account();
    const one = await table(a);
    const two = await table(b);
    await repository.addUserToRoom(one.roomId, b.id, 'ADMIN', admin.id);
    await repository.addUserToRoom(two.roomId, a.id, 'ADMIN', admin.id);
    // Both snapshots omit their later join, and the two rooms have opposite owner order.
    await Promise.all([one.actor.adminArchive(admin.id), two.actor.adminArchive(admin.id)]);
    expect(await balance(a.id)).toBe(50_000);
    expect(await balance(b.id)).toBe(50_000);
    expect(await cashouts(one.roomId)).toHaveLength(2);
    expect(await cashouts(two.roomId)).toHaveLength(2);
  });

  it('rejects restoring a deleted account even if the early availability check raced deletion', async () => {
    const created = await table();
    await database.db
      .update(players)
      .set({ stack: 0, membershipStatus: 'KICKED' })
      .where(eq(players.id, created.playerId));
    const stale = (await repository.loadRoom(created.roomId))!;
    expect(await repository.deleteUserAccount(admin.id, created.user.id)).toBe(true);
    const wrapped = Object.create(repository) as PokerRepository;
    let staleCheck = true;
    wrapped.loadRoom = async (roomId) => {
      if (staleCheck) {
        staleCheck = false;
        return stale;
      }
      return repository.loadRoom(roomId);
    };
    const actor = new RoomActor(stale, wrapped, () => undefined);
    await expect(
      actor.adminReinstatePlayer(admin.id, created.playerId, randomUUID()),
    ).rejects.toThrow('USER_NOT_FOUND');
    expect(actor.state.players[0]!.membershipStatus).toBe('KICKED');
    expect(
      await actor.adminReinstatePlayer(admin.id, created.playerId, randomUUID()),
    ).toMatchObject({ ok: false, code: 'CONFLICT' });
    const persisted = (await repository.loadRoom(created.roomId))!;
    expect(persisted.players[0]!.membershipStatus).toBe('KICKED');
  });
});
