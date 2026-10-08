import { randomUUID } from 'node:crypto';
import {
  accountLedgerEntries,
  admins,
  auditLogs,
  createDatabase,
  hands,
  players,
  registrationInvites,
  rooms,
  userAccounts,
  userSessions,
} from '@poker-with-friends/db';
import argon2 from 'argon2';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config.js';
import { PokerRepository } from '../repository.js';

const databaseUrl = process.env.E2E_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const settings = {
  mode: 'ONLINE' as const,
  smallBlind: 10,
  bigBlind: 20,
  startingStack: 1_000,
  stackCap: 5_000,
  actionTimeoutSeconds: 30,
  resultDisplaySeconds: 3,
  nextHandCountdownSeconds: 5,
  maxPlayers: 6 as const,
};

describeWithDatabase('PostgreSQL account lifecycle', () => {
  const runId = randomUUID().replaceAll('-', '').slice(0, 12);
  const bootstrapPassword = 'bootstrap-password';
  const accountIds: string[] = [];
  let database: ReturnType<typeof createDatabase>;
  let repository: PokerRepository;
  let admin: { id: string; username: string; displayName: string };
  let config: AppConfig;
  const createAccount = async () => {
    const account = await repository.createUserAccount(admin.id, {
      username: `acct_${randomUUID().slice(0, 8)}`,
      displayName: '测试玩家',
      password: 'old-password',
    });
    accountIds.push(account.id);
    return account;
  };
  const createMembership = async (
    accountId: string,
    status: 'LOBBY' | 'ARCHIVED',
    stack: number,
    membershipStatus: 'ACTIVE' | 'KICKED' = 'ACTIVE',
  ) => {
    const created = await repository.createRoom(admin, 'account lifecycle', settings);
    await database.db.update(rooms).set({ status }).where(eq(rooms.id, created.roomId));
    const [player] = await database.db
      .insert(players)
      .values({
        roomId: created.roomId,
        userId: accountId,
        nickname: '测试玩家',
        stack,
        membershipStatus,
      })
      .returning();
    return { roomId: created.roomId, player: player! };
  };

  beforeAll(async () => {
    config = {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: 3000,
      PUBLIC_ORIGIN: 'http://127.0.0.1',
      DATABASE_URL: databaseUrl!,
      COOKIE_SECRET: 'account-tests-cookie-secret-at-least-thirty-two-bytes',
      SNAPSHOT_KEY: Buffer.alloc(32, 1).toString('base64'),
      TOKEN_PEPPER: 'account-tests-pepper-at-least-thirty-two-bytes',
      ADMIN_USERNAME: `account_admin_${runId}`,
      ADMIN_PASSWORD_HASH: await argon2.hash(bootstrapPassword),
      TRUST_PROXY: false,
      RETENTION_DAYS: 30,
      ROOM_IDLE_HOURS: 12,
      APP_BUILD_SHA: 'test',
      WEB_DIST_DIR: 'missing',
    };
    database = createDatabase(databaseUrl!);
    repository = new PokerRepository(database.db, config);
    await repository.ensureConfiguredAdmin();
    admin = (await repository.verifyAdmin(config.ADMIN_USERNAME, bootstrapPassword))!;
    expect(admin).not.toBeNull();
  }, 30_000);

  afterAll(async () => {
    if (!database) return;
    try {
      if (admin) {
        await database.db.delete(rooms).where(eq(rooms.createdByAdminId, admin.id));
        if (accountIds.length)
          await database.db.delete(userAccounts).where(inArray(userAccounts.id, accountIds));
        await database.db.delete(userAccounts).where(eq(userAccounts.linkedAdminId, admin.id));
        await database.db.delete(auditLogs).where(eq(auditLogs.adminId, admin.id));
        await database.db.delete(admins).where(eq(admins.id, admin.id));
      }
    } finally {
      await database.client.end({ timeout: 5 });
    }
  }, 60_000);

  it('lists the bootstrap admin before playing and grants chips once under concurrent provisioning', async () => {
    const accounts = await Promise.all(
      Array.from({ length: 8 }, () => repository.ensureAdminPlayerAccount(admin)),
    );
    expect(new Set(accounts.map((account) => account.id)).size).toBe(1);
    const linked = accounts[0]!;
    expect(linked).toMatchObject({ username: admin.username, isAdmin: true, chipBalance: 50_000 });
    expect(await repository.listUserAccounts()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: linked.id,
          username: admin.username,
          loginEnabled: true,
          linkedAdminId: admin.id,
          isAdmin: true,
        }),
      ]),
    );
    expect(
      await database.db
        .select()
        .from(accountLedgerEntries)
        .where(eq(accountLedgerEntries.userId, linked.id)),
    ).toHaveLength(1);
    const [stored] = await database.db
      .select()
      .from(userAccounts)
      .where(eq(userAccounts.id, linked.id));
    expect(stored).toMatchObject({ loginEnabled: false, passwordHash: null });
    const adjusted = await repository.adjustUserChips(
      admin.id,
      linked.id,
      51_000,
      'test adjustment',
      randomUUID(),
    );
    expect(adjusted).toMatchObject({ username: admin.username, loginEnabled: true, isAdmin: true });
    expect((await repository.ensureAdminPlayerAccount(admin)).chipBalance).toBe(51_000);
  }, 120_000);

  it('shares administrator identity and rotates both sessions from either profile entry', async () => {
    const linked = await repository.ensureAdminPlayerAccount(admin);
    const { player } = await createMembership(linked.id, 'LOBBY', 0);
    for (const entry of ['USER', 'ADMIN'] as const) {
      const oldUser = await repository.createUserSession(linked.id);
      const oldAdmin = await repository.createAdminSession(admin.id);
      const password = entry === 'USER' ? 'user-entry-password' : bootstrapPassword;
      const displayName = entry === 'USER' ? '大厅管理员' : '管理页管理员';
      const changed =
        entry === 'USER'
          ? await repository.updateUserProfile(linked.id, { displayName, newPassword: password })
          : await repository.updateAdminProfile(admin.id, { displayName, newPassword: password });
      expect(changed).not.toBeNull();
      const userToken =
        entry === 'USER'
          ? (changed as { sessionToken?: string }).sessionToken
          : (changed as { userSessionToken?: string }).userSessionToken;
      const adminToken =
        entry === 'ADMIN'
          ? (changed as { sessionToken?: string }).sessionToken
          : (changed as { adminSessionToken?: string }).adminSessionToken;
      expect(await repository.getUserBySession(oldUser)).toBeNull();
      expect(await repository.getAdminBySession(oldAdmin)).toBeNull();
      expect(await repository.getUserBySession(userToken)).toMatchObject({
        username: admin.username,
        displayName,
        isAdmin: true,
      });
      expect(await repository.getAdminBySession(adminToken)).toMatchObject({
        username: admin.username,
        displayName,
      });
      expect(await repository.verifyAdmin(admin.username, password)).toMatchObject({
        id: admin.id,
        displayName,
      });
      const [stored] = await database.db
        .select()
        .from(userAccounts)
        .where(eq(userAccounts.id, linked.id));
      expect(stored).toMatchObject({ displayName, loginEnabled: false, passwordHash: null });
      const [membership] = await database.db
        .select()
        .from(players)
        .where(eq(players.id, player.id));
      expect(membership!.nickname).toBe(displayName);
    }
    await Promise.all([
      repository.updateUserProfile(linked.id, { displayName: '并发大厅资料' }),
      repository.updateAdminProfile(admin.id, { displayName: '并发管理资料' }),
    ]);
    const [authority] = await database.db.select().from(admins).where(eq(admins.id, admin.id));
    const [shadow] = await database.db
      .select()
      .from(userAccounts)
      .where(eq(userAccounts.id, linked.id));
    expect(shadow!.displayName).toBe(authority!.displayName);
    // Restore bootstrap repair semantics for the separate test below.
    await database.db
      .update(admins)
      .set({ passwordChangedAt: null })
      .where(eq(admins.id, admin.id));
  }, 120_000);

  it('changes a user password without the old password and revokes every previous session', async () => {
    const account = await createAccount();
    const oldSessions = await Promise.all([
      repository.createUserSession(account.id),
      repository.createUserSession(account.id),
    ]);
    const changed = await repository.changeUserPassword(account.id, 'abc123');
    expect(changed).not.toBeNull();
    expect(await repository.verifyUser(account.username, 'old-password')).toBeNull();
    expect(await repository.verifyUser(account.username, 'abc123')).toMatchObject({
      id: account.id,
    });
    for (const token of oldSessions) expect(await repository.getUserBySession(token)).toBeNull();
    expect(await repository.getUserBySession(changed!.sessionToken)).toMatchObject({
      id: account.id,
    });
  }, 120_000);

  it('retains bootstrap repair for untouched admins but disables it after an explicit password change', async () => {
    await database.db
      .update(admins)
      .set({ passwordHash: await argon2.hash('stale-password') })
      .where(eq(admins.id, admin.id));
    expect(await repository.verifyAdmin(admin.username, bootstrapPassword)).toMatchObject({
      id: admin.id,
    });
    const oldSessions = await Promise.all([
      repository.createAdminSession(admin.id),
      repository.createAdminSession(admin.id),
    ]);
    const changed = await repository.updateAdminProfile(admin.id, { newPassword: 'abc123' });
    expect(changed).not.toBeNull();
    for (const token of oldSessions) expect(await repository.getAdminBySession(token)).toBeNull();
    expect(await repository.getAdminBySession(changed!.sessionToken)).toMatchObject({
      id: admin.id,
    });
    expect(await repository.verifyAdmin(admin.username, 'abc123')).toMatchObject({ id: admin.id });
    expect(await repository.verifyAdmin(admin.username, bootstrapPassword)).toBeNull();
    await repository.ensureConfiguredAdmin();
    expect(await repository.verifyAdmin(admin.username, bootstrapPassword)).toBeNull();
    expect(await repository.verifyAdmin(admin.username, 'abc123')).toMatchObject({ id: admin.id });
  }, 120_000);

  it('deletes a settled account without losing historical membership, hand or account ledger records', async () => {
    const account = await createAccount();
    const oldToken = await repository.createUserSession(account.id);
    await repository.createRegistrationInvite({ userId: account.id });
    const { roomId, player } = await createMembership(account.id, 'ARCHIVED', 0);
    const [hand] = await database.db
      .insert(hands)
      .values({
        roomId,
        handNumber: 1,
        mode: 'ONLINE',
        phase: 'SETTLED',
        buttonSeat: 0,
        initialTotalChips: 1_000,
        result: { winnerPlayerId: player.id },
        endedAt: new Date(),
      })
      .returning();
    expect(await repository.deleteUserAccount(admin.id, account.id)).toBe(true);
    const [tombstone] = await database.db
      .select()
      .from(userAccounts)
      .where(eq(userAccounts.id, account.id));
    expect(tombstone).toMatchObject({
      loginEnabled: false,
      passwordHash: null,
      chipBalance: account.chipBalance,
    });
    expect(tombstone!.deletedAt).toBeInstanceOf(Date);
    expect(await repository.getUserBySession(oldToken)).toBeNull();
    expect(await repository.verifyUser(account.username, 'old-password')).toBeNull();
    expect((await repository.listUserAccounts()).some((row) => row.id === account.id)).toBe(false);
    expect(await database.db.select().from(players).where(eq(players.id, player.id))).toHaveLength(
      1,
    );
    expect(await database.db.select().from(hands).where(eq(hands.id, hand!.id))).toHaveLength(1);
    expect(
      await database.db
        .select()
        .from(accountLedgerEntries)
        .where(eq(accountLedgerEntries.userId, account.id)),
    ).toHaveLength(1);
    expect(
      await database.db.select().from(userSessions).where(eq(userSessions.userId, account.id)),
    ).toHaveLength(0);
    expect(
      await database.db
        .select()
        .from(registrationInvites)
        .where(eq(registrationInvites.createdByUserId, account.id)),
    ).toHaveLength(0);
    expect(await repository.resetUserPassword(admin.id, account.id)).toBeNull();
    expect(
      await repository.updateUserProfile(account.id, { newPassword: 'new-password' }),
    ).toBeNull();
    expect(
      await repository.adjustUserChips(admin.id, account.id, 100, 'deleted account', randomUUID()),
    ).toBeNull();
    await expect(repository.createUserSession(account.id)).rejects.toThrow('USER_NOT_FOUND');
    const openRoom = await repository.createRoom(admin, 'new room', settings);
    await expect(
      repository.addUserToRoom(openRoom.roomId, account.id, 'ADMIN', admin.id),
    ).rejects.toThrow('USER_NOT_FOUND');
    await expect(
      repository.createUserAccount(admin.id, {
        username: account.username,
        password: 'new-password',
      }),
    ).rejects.toThrow('USERNAME_TAKEN');
    expect(await repository.deleteUserAccount(admin.id, account.id)).toBe(false);
  }, 120_000);

  it('blocks active or unsettled memberships, but permits a kicked zero-stack membership', async () => {
    for (const [status, stack, membershipStatus, blocked] of [
      ['LOBBY', 0, 'ACTIVE', true],
      ['ARCHIVED', 500, 'ACTIVE', true],
      ['LOBBY', 0, 'KICKED', false],
    ] as const) {
      const account = await createAccount();
      await createMembership(account.id, status, stack, membershipStatus);
      if (blocked) {
        await expect(repository.deleteUserAccount(admin.id, account.id)).rejects.toThrow(
          'USER_ACCOUNT_IN_ROOM',
        );
        expect(await repository.verifyUser(account.username, 'old-password')).toMatchObject({
          id: account.id,
        });
      } else expect(await repository.deleteUserAccount(admin.id, account.id)).toBe(true);
    }
  }, 120_000);

  it('protects linked administrator player accounts from deletion or player password resets', async () => {
    const linked = await repository.ensureAdminPlayerAccount(admin);
    expect(await repository.deleteUserAccount(admin.id, linked.id)).toBe(false);
    expect(await repository.resetUserPassword(admin.id, linked.id)).toBeNull();
    expect(await repository.verifyUser(linked.username, 'abc123')).toBeNull();
  }, 120_000);
});
