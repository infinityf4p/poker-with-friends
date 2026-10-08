import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import {
  adminSessions,
  admins,
  accountLedgerEntries,
  auditLogs,
  commandResults,
  hands,
  ledgerEntries,
  liveResultConfirmations,
  liveResultProposals,
  players,
  privateSnapshots,
  roomEvents,
  roomChatMessages,
  roomInvites,
  registrationInvites,
  rooms,
  userAccounts,
  userSessions,
  type PlayerRow,
  type PokerDatabase,
  type RoomRow,
} from '@poker-with-friends/db';
import type {
  AdminRoomSummary,
  AdminRoomPlayerSummary,
  AdminAccountLedgerEntry,
  AdminHandHistoryItem,
  AdminUserSummary,
  CommandResult,
  HandHistoryItem,
  LobbyRoomSummary,
  PublicRoomProjection,
  RoomSettings,
  RoomStatus,
  RoomVisibility,
  UserRoomSummary,
  UserSession,
  ChipLedgerResponse,
  ChatMessage,
} from '@poker-with-friends/protocol';
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import type { AppConfig } from './config.js';
import {
  decryptSnapshot,
  encryptSnapshot,
  hashOpaqueToken,
  randomToken,
  type EncryptedPayload,
} from './security/crypto.js';
import { SESSION_TTL_MS } from './security/cookies.js';
import { buildProjections } from './room/projection.js';
import type { RuntimeRoomState } from './room/state.js';

type PokerTransaction = Parameters<Parameters<PokerDatabase['transaction']>[0]>[0];

export interface AuthenticatedAdmin {
  id: string;
  username: string;
  displayName: string;
}

export interface AuthenticatedPlayer {
  id: string;
  userId: string;
  roomId: string;
  nickname: string;
  seat: number | null;
  membershipStatus: 'ACTIVE' | 'KICK_PENDING' | 'KICKED';
}

export type AuthenticatedUser = UserSession;

export interface LoadedRoom {
  room: RoomRow;
  players: PlayerRow[];
  privateState: unknown | null;
  accountChipsByUserId: Record<string, number>;
  unavailableUserIds?: string[];
}

export interface PlayerMutation {
  playerId: string;
  stack: number;
  seat: number | null;
  ready: boolean;
  sittingOut: boolean;
  connected: boolean;
  membershipStatus: 'ACTIVE' | 'KICK_PENDING' | 'KICKED';
  kickedAt: string | null;
  kickedByAdminId: string | null;
  kickReason: string | null;
}

export interface LedgerMutation {
  playerId: string;
  kind: string;
  delta: number;
  balanceAfter: number;
  metadata?: Record<string, unknown>;
}

export interface HandStartMutation {
  id: string;
  handNumber: number;
  mode: 'ONLINE' | 'LIVE';
  phase: 'POST_BLINDS' | 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER' | 'SHOWDOWN' | 'SETTLED';
  buttonSeat: number;
  initialTotalChips: number;
  adminHistory?: unknown;
}

export interface HandUpdateMutation {
  id: string;
  phase: 'POST_BLINDS' | 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER' | 'SHOWDOWN' | 'SETTLED';
  result?: unknown;
  ended?: boolean;
  adminHistory?: unknown;
}

export interface RoomCommit {
  roomId: string;
  seq: number;
  status: RoomStatus;
  handNumber: number;
  publicSnapshot: PublicRoomProjection;
  privateState: unknown;
  event: {
    type: string;
    actorPlayerId?: string;
    handId?: string;
    publicPayload?: Record<string, unknown>;
  };
  playerMutations: PlayerMutation[];
  ledgerMutations?: LedgerMutation[];
  accountLedgerMutations?: AccountLedgerMutation[];
  handStart?: HandStartMutation;
  handUpdate?: HandUpdateMutation;
  command?: {
    commandId: string;
    playerId: string;
    requestHash: string;
    result: CommandResult;
  };
  liveProposal?: {
    id: string;
    handId: string;
    proposerPlayerId: string;
    winnersByPot: Record<string, string[]>;
    status: string;
    settleAt: Date;
    disputeAt: Date;
  };
  liveConfirmation?: {
    proposalId: string;
    playerId: string;
    kind: 'OBJECT' | 'CONFIRM';
  };
  liveProposalUpdate?: {
    id: string;
    status: 'OBJECTED' | 'SUPERSEDED' | 'SETTLED' | 'DISPUTED' | 'ABORTED';
  };
  audit?: {
    adminId?: string;
    action: string;
    metadata?: Record<string, unknown>;
  };
}

export interface AccountLedgerMutation {
  userId: string;
  playerId?: string;
  kind: string;
  delta: number;
  beforeBalance: number;
  balanceAfter: number;
  metadata?: Record<string, unknown>;
}

function expiresAt(): Date {
  return new Date(Date.now() + SESSION_TTL_MS);
}

const USER_PASSWORD_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
} as const;

const DUMMY_USER_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=3,p=1$TpocOsT6Sd85RYOaiyB0PA$aeEOWaJL8TpaR/imXMxdKJC20Y9rtXRk2JvOaY3+QIU';

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function userSession(row: {
  id: string;
  username: string;
  displayName: string;
  mustChangePassword: boolean;
  chipBalance: number;
  linkedAdminId?: string | null;
}): UserSession {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    mustChangePassword: row.mustChangePassword,
    chipBalance: row.chipBalance,
    ...(row.linkedAdminId ? { isAdmin: true } : {}),
  };
}

export class PokerRepository {
  public constructor(
    private readonly db: PokerDatabase,
    private readonly config: AppConfig,
  ) {}

  public async ensureConfiguredAdmin(): Promise<void> {
    if (!this.config.ADMIN_PASSWORD_HASH) {
      for (const admin of await this.db.select().from(admins))
        await this.ensureAdminPlayerAccount(admin);
      return;
    }
    await this.db.transaction(async (tx) => {
      let [existing] = await tx
        .select({
          id: admins.id,
          passwordHash: admins.passwordHash,
          displayName: admins.displayName,
        })
        .from(admins)
        .where(eq(admins.username, this.config.ADMIN_USERNAME))
        .limit(1);
      if (!existing) {
        await tx
          .insert(admins)
          .values({
            username: this.config.ADMIN_USERNAME,
            displayName: this.config.ADMIN_USERNAME,
            passwordHash: this.config.ADMIN_PASSWORD_HASH!,
          })
          .onConflictDoNothing({ target: admins.username });
        [existing] = await tx
          .select({
            id: admins.id,
            passwordHash: admins.passwordHash,
            displayName: admins.displayName,
          })
          .from(admins)
          .where(eq(admins.username, this.config.ADMIN_USERNAME))
          .limit(1);
      }
      if (existing && !existing.displayName.trim()) {
        await tx
          .update(admins)
          .set({ displayName: this.config.ADMIN_USERNAME, updatedAt: new Date() })
          .where(eq(admins.id, existing.id));
      }
    });
    for (const admin of await this.db.select().from(admins))
      await this.ensureAdminPlayerAccount(admin);
  }

  public async verifyAdmin(username: string, password: string): Promise<AuthenticatedAdmin | null> {
    const normalizedUsername = username.trim();
    const configuredUsername = this.config.ADMIN_USERNAME.trim();
    const [admin] = await this.db
      .select()
      .from(admins)
      .where(eq(admins.username, normalizedUsername))
      .limit(1);
    if (!admin) return null;
    let valid = false;
    try {
      valid = await argon2.verify(admin.passwordHash, password);
    } catch {
      valid = false;
    }
    // The configured administrator hash is the bootstrap credential. A restored
    // database can retain an older hash, so accept the current configured
    // credential once and repair the row before creating a session.
    if (
      !valid &&
      !admin.passwordChangedAt &&
      normalizedUsername === configuredUsername &&
      this.config.ADMIN_PASSWORD_HASH
    ) {
      try {
        valid = await argon2.verify(this.config.ADMIN_PASSWORD_HASH, password);
        if (valid) {
          const repaired = await this.db
            .update(admins)
            .set({ passwordHash: this.config.ADMIN_PASSWORD_HASH, updatedAt: new Date() })
            .where(
              and(
                eq(admins.id, admin.id),
                isNull(admins.passwordChangedAt),
                eq(admins.passwordHash, admin.passwordHash),
              ),
            )
            .returning({ id: admins.id });
          valid = repaired.length > 0;
        }
      } catch {
        valid = false;
      }
    }
    if (!valid) return null;
    return { id: admin.id, username: admin.username, displayName: admin.displayName };
  }

  public async createAdminSession(adminId: string): Promise<string> {
    const token = randomToken();
    await this.db.insert(adminSessions).values({
      adminId,
      tokenHash: hashOpaqueToken(token, this.config.TOKEN_PEPPER),
      expiresAt: expiresAt(),
    });
    return token;
  }

  public async getAdminBySession(token: string | undefined): Promise<AuthenticatedAdmin | null> {
    if (!token) return null;
    const tokenHash = hashOpaqueToken(token, this.config.TOKEN_PEPPER);
    const [row] = await this.db
      .select({ id: admins.id, username: admins.username, displayName: admins.displayName })
      .from(adminSessions)
      .innerJoin(admins, eq(adminSessions.adminId, admins.id))
      .where(and(eq(adminSessions.tokenHash, tokenHash), gt(adminSessions.expiresAt, new Date())))
      .limit(1);
    return row ?? null;
  }

  public async deleteAdminSession(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.db
      .delete(adminSessions)
      .where(eq(adminSessions.tokenHash, hashOpaqueToken(token, this.config.TOKEN_PEPPER)));
  }

  public async verifyUser(username: string, password: string): Promise<AuthenticatedUser | null> {
    const [account] = await this.db
      .select()
      .from(userAccounts)
      .where(eq(userAccounts.username, normalizeUsername(username)))
      .limit(1);
    if (!account || account.deletedAt || !account.loginEnabled || !account.passwordHash) {
      await argon2.verify(DUMMY_USER_PASSWORD_HASH, password).catch(() => false);
      return null;
    }
    if (!(await argon2.verify(account.passwordHash, password))) return null;
    return userSession(account);
  }

  public async createRegistrationInvite(creator: {
    adminId?: string;
    userId?: string;
  }): Promise<{ code: string; expiresAt: string }> {
    if (!creator.adminId && !creator.userId) throw new Error('INVITE_CREATOR_REQUIRED');
    const code = randomToken();
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await this.db.insert(registrationInvites).values({
      tokenHash: hashOpaqueToken(code, this.config.TOKEN_PEPPER),
      createdByAdminId: creator.adminId ?? null,
      createdByUserId: creator.userId ?? null,
      expiresAt: expires,
    });
    return { code, expiresAt: expires.toISOString() };
  }

  public async registerUser(
    inviteCode: string,
    usernameInput: string,
    password: string,
  ): Promise<{ user: AuthenticatedUser; sessionToken: string }> {
    const username = normalizeUsername(usernameInput);
    const passwordHash = await argon2.hash(password, USER_PASSWORD_OPTIONS);
    const tokenHash = hashOpaqueToken(inviteCode, this.config.TOKEN_PEPPER);
    const sessionToken = randomToken();
    try {
      const account = await this.db.transaction(async (tx) => {
        const [invite] = await tx
          .select()
          .from(registrationInvites)
          .where(
            and(
              eq(registrationInvites.tokenHash, tokenHash),
              isNull(registrationInvites.usedAt),
              sql`(${registrationInvites.expiresAt} is null or ${registrationInvites.expiresAt} > now())`,
            ),
          )
          .for('update')
          .limit(1);
        if (!invite) throw new Error('REGISTRATION_INVITE_INVALID');
        const [created] = await tx
          .insert(userAccounts)
          .values({
            username,
            displayName: usernameInput.trim().slice(0, 20),
            passwordHash,
            chipBalance: 50_000,
          })
          .returning();
        if (!created) throw new Error('USERNAME_TAKEN');
        await tx.insert(accountLedgerEntries).values({
          userId: created.id,
          kind: 'ACCOUNT_INITIAL_GRANT',
          delta: created.chipBalance,
          balanceAfter: created.chipBalance,
          metadata: { source: 'REGISTRATION' },
        });
        await tx
          .update(registrationInvites)
          .set({ usedAt: new Date(), usedByUserId: created.id })
          .where(eq(registrationInvites.id, invite.id));
        await tx.insert(userSessions).values({
          userId: created.id,
          tokenHash: hashOpaqueToken(sessionToken, this.config.TOKEN_PEPPER),
          expiresAt: expiresAt(),
        });
        return created;
      });
      return { user: userSession(account), sessionToken };
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23505'
      ) {
        throw new Error('USERNAME_TAKEN');
      }
      throw error;
    }
  }

  public async createUserSession(userId: string): Promise<string> {
    const token = randomToken();
    await this.db.transaction(async (tx) => {
      const [account] = await tx
        .select()
        .from(userAccounts)
        .where(eq(userAccounts.id, userId))
        .for('update')
        .limit(1);
      if (!account || account.deletedAt || (!account.loginEnabled && !account.linkedAdminId)) {
        throw new Error('USER_NOT_FOUND');
      }
      await tx.insert(userSessions).values({
        userId,
        tokenHash: hashOpaqueToken(token, this.config.TOKEN_PEPPER),
        expiresAt: expiresAt(),
      });
    });
    return token;
  }

  public async getUserBySession(token: string | undefined): Promise<AuthenticatedUser | null> {
    if (!token) return null;
    const tokenHash = hashOpaqueToken(token, this.config.TOKEN_PEPPER);
    const [row] = await this.db
      .select({
        id: userAccounts.id,
        username: sql<string>`coalesce(${admins.username}, ${userAccounts.username})`,
        displayName: userAccounts.displayName,
        linkedAdminId: userAccounts.linkedAdminId,
        mustChangePassword: userAccounts.mustChangePassword,
        chipBalance: userAccounts.chipBalance,
      })
      .from(userSessions)
      .innerJoin(userAccounts, eq(userSessions.userId, userAccounts.id))
      .leftJoin(admins, eq(userAccounts.linkedAdminId, admins.id))
      .where(
        and(
          eq(userSessions.tokenHash, tokenHash),
          gt(userSessions.expiresAt, new Date()),
          isNull(userAccounts.deletedAt),
          sql`(${userAccounts.loginEnabled} = true or ${userAccounts.linkedAdminId} is not null)`,
        ),
      )
      .limit(1);
    if (!row) return null;
    await this.db
      .update(userSessions)
      .set({ lastUsedAt: new Date() })
      .where(eq(userSessions.tokenHash, tokenHash));
    return userSession(row);
  }

  public async deleteUserSession(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.db
      .delete(userSessions)
      .where(eq(userSessions.tokenHash, hashOpaqueToken(token, this.config.TOKEN_PEPPER)));
  }

  public async changeUserPassword(
    userId: string,
    newPassword: string,
  ): Promise<{ user: AuthenticatedUser; sessionToken: string; adminSessionToken?: string } | null> {
    const changed = await this.updateUserProfile(userId, {
      newPassword,
    });
    return changed?.sessionToken
      ? {
          user: changed.user,
          sessionToken: changed.sessionToken,
          ...(changed.adminSessionToken ? { adminSessionToken: changed.adminSessionToken } : {}),
        }
      : null;
  }

  public async updateUserProfile(
    userId: string,
    input: {
      displayName?: string | undefined;
      newPassword?: string | undefined;
    },
  ): Promise<{
    user: AuthenticatedUser;
    sessionToken?: string;
    adminSessionToken?: string;
    roomIds: string[];
  } | null> {
    // Linked identity is immutable; acquire administrator locks before player locks.
    const [identity] = await this.db
      .select({ linkedAdminId: userAccounts.linkedAdminId })
      .from(userAccounts)
      .where(eq(userAccounts.id, userId))
      .limit(1);
    if (identity?.linkedAdminId) {
      const changed = await this.updateAdminProfile(identity.linkedAdminId, input);
      if (!changed) return null;
      const [account] = await this.db
        .select()
        .from(userAccounts)
        .where(eq(userAccounts.id, userId));
      if (!account) return null;
      return {
        user: userSession({ ...account, username: changed.admin.username }),
        roomIds: changed.roomIds,
        ...(changed.userSessionToken ? { sessionToken: changed.userSessionToken } : {}),
        ...(changed.sessionToken ? { adminSessionToken: changed.sessionToken } : {}),
      };
    }
    const displayName = input.displayName?.trim();
    if (
      displayName !== undefined &&
      (displayName.length === 0 ||
        displayName.length > 20 ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(displayName))
    ) {
      throw new Error('INVALID_DISPLAY_NAME');
    }
    const passwordHash = input.newPassword
      ? await argon2.hash(input.newPassword, USER_PASSWORD_OPTIONS)
      : undefined;
    const sessionToken = input.newPassword ? randomToken() : undefined;
    const result = await this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(userAccounts)
        .where(eq(userAccounts.id, userId))
        .for('update')
        .limit(1);
      if (!locked || locked.deletedAt) return null;
      const [updated] = await tx
        .update(userAccounts)
        .set({
          ...(displayName === undefined ? {} : { displayName }),
          ...(passwordHash ? { passwordHash, mustChangePassword: false } : {}),
          updatedAt: new Date(),
        })
        .where(eq(userAccounts.id, userId))
        .returning();
      if (!updated) return null;
      const roomIds =
        displayName === undefined
          ? []
          : (
              await tx
                .select({ roomId: players.roomId })
                .from(players)
                .innerJoin(rooms, eq(players.roomId, rooms.id))
                .where(and(eq(players.userId, userId), ne(rooms.status, 'ARCHIVED')))
            ).map((row) => row.roomId);
      if (displayName !== undefined) {
        await tx
          .update(players)
          .set({ nickname: displayName, updatedAt: new Date() })
          .where(eq(players.userId, userId));
      }
      if (sessionToken) {
        await tx.delete(userSessions).where(eq(userSessions.userId, userId));
        await tx.insert(userSessions).values({
          userId,
          tokenHash: hashOpaqueToken(sessionToken, this.config.TOKEN_PEPPER),
          expiresAt: expiresAt(),
        });
      }
      return {
        user: userSession(updated),
        ...(sessionToken ? { sessionToken } : {}),
        roomIds,
      };
    });
    return result;
  }

  public async updateAdminProfile(
    adminId: string,
    input: {
      displayName?: string | undefined;
      newPassword?: string | undefined;
    },
  ): Promise<{
    admin: AuthenticatedAdmin;
    sessionToken?: string;
    userSessionToken?: string;
    roomIds: string[];
  } | null> {
    const displayName = input.displayName?.trim();
    if (
      displayName !== undefined &&
      (displayName.length === 0 ||
        displayName.length > 20 ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(displayName))
    ) {
      throw new Error('INVALID_DISPLAY_NAME');
    }
    const passwordHash = input.newPassword
      ? await argon2.hash(input.newPassword, USER_PASSWORD_OPTIONS)
      : undefined;
    const sessionToken = input.newPassword ? randomToken() : undefined;
    const userSessionToken = input.newPassword ? randomToken() : undefined;
    const result = await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(admins)
        .set({
          ...(displayName === undefined ? {} : { displayName }),
          ...(passwordHash ? { passwordHash, passwordChangedAt: new Date() } : {}),
          updatedAt: new Date(),
        })
        .where(eq(admins.id, adminId))
        .returning();
      if (!updated) return null;
      const linkedAccounts = await tx
        .select({ id: userAccounts.id })
        .from(userAccounts)
        .where(eq(userAccounts.linkedAdminId, adminId));
      const linkedUserIds = linkedAccounts.map((row) => row.id);
      const roomIds = linkedUserIds.length
        ? (
            await tx
              .select({ roomId: players.roomId })
              .from(players)
              .innerJoin(rooms, eq(players.roomId, rooms.id))
              .where(and(inArray(players.userId, linkedUserIds), ne(rooms.status, 'ARCHIVED')))
          ).map((row) => row.roomId)
        : [];
      if (displayName !== undefined && linkedUserIds.length > 0) {
        await tx
          .update(userAccounts)
          .set({ displayName, updatedAt: new Date() })
          .where(inArray(userAccounts.id, linkedUserIds));
        await tx
          .update(players)
          .set({ nickname: displayName, updatedAt: new Date() })
          .where(inArray(players.userId, linkedUserIds));
      }
      if (userSessionToken && linkedUserIds.length) {
        await tx.delete(userSessions).where(inArray(userSessions.userId, linkedUserIds));
        await tx.insert(userSessions).values({
          userId: linkedUserIds[0]!,
          tokenHash: hashOpaqueToken(userSessionToken, this.config.TOKEN_PEPPER),
          expiresAt: expiresAt(),
        });
        await tx
          .update(userAccounts)
          .set({ passwordHash: null, loginEnabled: false, mustChangePassword: false })
          .where(inArray(userAccounts.id, linkedUserIds));
      }
      if (sessionToken) {
        await tx.delete(adminSessions).where(eq(adminSessions.adminId, adminId));
        await tx.insert(adminSessions).values({
          adminId,
          tokenHash: hashOpaqueToken(sessionToken, this.config.TOKEN_PEPPER),
          expiresAt: expiresAt(),
        });
      }
      return {
        admin: { id: updated.id, username: updated.username, displayName: updated.displayName },
        ...(sessionToken ? { sessionToken } : {}),
        ...(userSessionToken && linkedUserIds.length ? { userSessionToken } : {}),
        roomIds,
      };
    });
    return result;
  }

  public async createUserAccount(
    adminId: string,
    input: { username: string; displayName?: string | undefined; password: string },
  ): Promise<AdminUserSummary> {
    const username = normalizeUsername(input.username);
    const displayName = input.displayName?.trim() || input.username.trim();
    if (
      displayName.length === 0 ||
      displayName.length > 20 ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(displayName)
    ) {
      throw new Error('INVALID_DISPLAY_NAME');
    }
    const passwordHash = await argon2.hash(input.password, USER_PASSWORD_OPTIONS);
    try {
      const [created] = await this.db.transaction(async (tx) => {
        const rows = await tx
          .insert(userAccounts)
          .values({
            username,
            displayName,
            passwordHash,
            mustChangePassword: false,
            createdByAdminId: adminId,
          })
          .onConflictDoNothing({ target: userAccounts.username })
          .returning();
        const account = rows[0];
        if (!account) throw new Error('USERNAME_TAKEN');
        if (account) {
          await tx.insert(accountLedgerEntries).values({
            userId: account.id,
            kind: 'ACCOUNT_INITIAL_GRANT',
            delta: account.chipBalance,
            balanceAfter: account.chipBalance,
            metadata: { source: 'ADMIN' },
          });
          await tx.insert(auditLogs).values({
            adminId,
            action: 'USER_ACCOUNT_CREATED',
            metadata: { userId: account.id, username: account.username },
          });
        }
        return rows;
      });
      if (!created) throw new Error('USERNAME_TAKEN');
      return {
        ...userSession(created),
        loginEnabled: created.loginEnabled,
        linkedAdminId: created.linkedAdminId,
        createdAt: created.createdAt.toISOString(),
      };
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23505'
      ) {
        throw new Error('USERNAME_TAKEN');
      }
      throw error;
    }
  }

  public async listUserAccounts(): Promise<AdminUserSummary[]> {
    const rows = await this.db
      .select({ account: userAccounts, admin: admins })
      .from(userAccounts)
      .leftJoin(admins, eq(userAccounts.linkedAdminId, admins.id))
      .where(isNull(userAccounts.deletedAt))
      .orderBy(asc(userAccounts.createdAt));
    return rows.map(({ account, admin }) => ({
      ...userSession({ ...account, username: admin?.username ?? account.username }),
      loginEnabled: !!admin || account.loginEnabled,
      linkedAdminId: account.linkedAdminId,
      createdAt: account.createdAt.toISOString(),
    }));
  }

  public async deleteUserAccount(adminId: string, userId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      // Joins and account changes also lock this row, preventing new membership
      // or sessions from racing a successful deletion.
      const [account] = await tx
        .select()
        .from(userAccounts)
        .where(eq(userAccounts.id, userId))
        .for('update')
        .limit(1);
      if (!account || account.deletedAt || account.linkedAdminId) return false;
      const [unsettled] = await tx
        .select({ id: players.id })
        .from(players)
        .innerJoin(rooms, eq(players.roomId, rooms.id))
        .where(
          and(
            eq(players.userId, userId),
            sql`(${players.stack} > 0 or (${rooms.status} <> 'ARCHIVED' and ${players.membershipStatus} <> 'KICKED'))`,
          ),
        )
        .limit(1);
      if (unsettled) throw new Error('USER_ACCOUNT_IN_ROOM');
      const now = new Date();
      await tx
        .update(userAccounts)
        .set({ deletedAt: now, loginEnabled: false, passwordHash: null, updatedAt: now })
        .where(eq(userAccounts.id, userId));
      await tx.delete(userSessions).where(eq(userSessions.userId, userId));
      await tx
        .delete(registrationInvites)
        .where(
          and(eq(registrationInvites.createdByUserId, userId), isNull(registrationInvites.usedAt)),
        );
      await tx.insert(auditLogs).values({
        adminId,
        action: 'USER_ACCOUNT_DELETED',
        metadata: { userId, username: account.username },
      });
      return true;
    });
  }

  public async adjustUserChips(
    adminId: string,
    userId: string,
    balance: number,
    reason: string,
    operationId: string,
  ): Promise<(AdminUserSummary & { roomIds: string[] }) | null> {
    return this.db.transaction(async (tx) => {
      const [account] = await tx
        .select()
        .from(userAccounts)
        .where(eq(userAccounts.id, userId))
        .for('update')
        .limit(1);
      if (!account || account.deletedAt) return null;
      const delta = balance - account.chipBalance;
      const [updated] = await tx
        .update(userAccounts)
        .set({ chipBalance: balance, updatedAt: new Date() })
        .where(eq(userAccounts.id, userId))
        .returning();
      if (!updated) return null;
      if (delta !== 0) {
        await tx.insert(accountLedgerEntries).values({
          userId,
          roomId: null,
          playerId: null,
          kind: 'ADMIN_ACCOUNT_ADJUSTMENT',
          delta,
          balanceAfter: balance,
          metadata: { reason, operationId, beforeBalance: account.chipBalance },
        });
      }
      await tx.insert(auditLogs).values({
        adminId,
        action: 'USER_ACCOUNT_CHIPS_ADJUSTED',
        metadata: {
          userId,
          beforeBalance: account.chipBalance,
          balance,
          delta,
          reason,
          operationId,
        },
      });
      const roomIds = (
        await tx
          .select({ roomId: players.roomId })
          .from(players)
          .innerJoin(rooms, eq(players.roomId, rooms.id))
          .where(and(eq(players.userId, userId), ne(rooms.status, 'ARCHIVED')))
      ).map((row) => row.roomId);
      const [linkedAdmin] = updated.linkedAdminId
        ? await tx.select().from(admins).where(eq(admins.id, updated.linkedAdminId))
        : [];
      return {
        ...userSession({ ...updated, username: linkedAdmin?.username ?? updated.username }),
        loginEnabled: !!linkedAdmin || updated.loginEnabled,
        linkedAdminId: updated.linkedAdminId,
        createdAt: updated.createdAt.toISOString(),
        roomIds,
      };
    });
  }

  public async ensureAdminPlayerAccount(admin: AuthenticatedAdmin): Promise<AuthenticatedUser> {
    return this.db.transaction(async (tx) => {
      const [authority] = await tx
        .select()
        .from(admins)
        .where(eq(admins.id, admin.id))
        .for('update')
        .limit(1);
      if (!authority) throw new Error('ADMIN_NOT_FOUND');
      let [account] = await tx
        .select()
        .from(userAccounts)
        .where(eq(userAccounts.linkedAdminId, admin.id))
        .limit(1);
      if (!account) {
        [account] = await tx
          .insert(userAccounts)
          .values({
            username: `admin-${admin.id}`,
            displayName: authority.displayName,
            passwordHash: null,
            mustChangePassword: false,
            loginEnabled: false,
            linkedAdminId: admin.id,
            createdByAdminId: admin.id,
          })
          .returning();
        if (!account) throw new Error('Failed to create admin player account');
        await tx.insert(accountLedgerEntries).values({
          userId: account.id,
          kind: 'ACCOUNT_INITIAL_GRANT',
          delta: account.chipBalance,
          balanceAfter: account.chipBalance,
          metadata: { source: 'ADMIN_PLAYER' },
        });
        await tx.insert(auditLogs).values({
          adminId: admin.id,
          action: 'ADMIN_PLAYER_ACCOUNT_CREATED',
          metadata: { userId: account.id },
        });
      } else if (account.displayName !== authority.displayName) {
        [account] = await tx
          .update(userAccounts)
          .set({ displayName: authority.displayName, updatedAt: new Date() })
          .where(eq(userAccounts.id, account.id))
          .returning();
        await tx
          .update(players)
          .set({ nickname: authority.displayName, updatedAt: new Date() })
          .where(eq(players.userId, account!.id));
      }
      return userSession({ ...account!, username: authority.username });
    });
  }

  public async resetUserPassword(
    adminId: string,
    userId: string,
  ): Promise<{ password: string } | null> {
    const password = randomToken(9);
    const passwordHash = await argon2.hash(password, USER_PASSWORD_OPTIONS);
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(userAccounts)
        .set({ passwordHash, mustChangePassword: false, loginEnabled: true, updatedAt: new Date() })
        .where(
          and(
            eq(userAccounts.id, userId),
            isNull(userAccounts.deletedAt),
            isNull(userAccounts.linkedAdminId),
          ),
        )
        .returning({ id: userAccounts.id });
      if (updated.length === 0) return null;
      await tx.delete(userSessions).where(eq(userSessions.userId, userId));
      await tx.insert(auditLogs).values({
        adminId,
        action: 'USER_PASSWORD_RESET',
        metadata: { userId, generated: true },
      });
      return { password };
    });
  }

  public async createRoom(
    admin: AuthenticatedAdmin,
    name: string,
    settings: RoomSettings,
    visibility: RoomVisibility = 'PUBLIC',
    password?: string,
  ): Promise<{ roomId: string; inviteToken: string }> {
    const roomId = randomUUID();
    const inviteToken = randomToken();
    const now = new Date().toISOString();
    const publicSnapshot: PublicRoomProjection = {
      roomId,
      name,
      mode: settings.mode,
      status: 'LOBBY',
      settings,
      serverSeq: 0,
      handNumber: 0,
      phase: null,
      seats: Array.from({ length: 6 }, (_, seat) => ({
        seat,
        playerId: null,
        nickname: null,
        stack: 0,
        topUpTotal: 0,
        lastTopUpAmount: 0,
        committedStreet: 0,
        committedHand: 0,
        ready: false,
        connected: false,
        sittingOut: false,
        folded: false,
        allIn: false,
        role: null,
        positions: [],
        isActing: false,
        hasCards: false,
      })),
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
      ownerPlayerId: null,
      createdAt: now,
      updatedAt: now,
    };
    const encrypted = encryptSnapshot(
      { runtimeVersion: 1, public: publicSnapshot },
      this.config.SNAPSHOT_KEY,
    );

    await this.db.transaction(async (tx) => {
      await tx.insert(rooms).values({
        id: roomId,
        name,
        mode: settings.mode,
        visibility,
        accessPasswordHash:
          visibility === 'PRIVATE' && password ? await argon2.hash(password) : null,
        settings,
        createdByAdminId: admin.id,
        createdByUserId: null,
        publicSnapshot,
      });
      await tx.insert(roomInvites).values({
        roomId,
        tokenHash: hashOpaqueToken(inviteToken, this.config.TOKEN_PEPPER),
      });
      await tx.insert(privateSnapshots).values({ roomId, seq: 0, ...encrypted });
      await tx.insert(auditLogs).values({
        adminId: admin.id,
        roomId,
        action: 'ROOM_CREATED',
        metadata: { mode: settings.mode },
      });
    });
    return { roomId, inviteToken };
  }

  public async createUserRoom(
    user: AuthenticatedUser,
    name: string,
    settings: RoomSettings,
    visibility: RoomVisibility = 'PUBLIC',
    password?: string,
  ): Promise<{ roomId: string; inviteToken: string; playerId: string }> {
    const roomId = randomUUID();
    const inviteToken = randomToken();
    const now = new Date().toISOString();
    const playerId = randomUUID();
    const publicSnapshot: PublicRoomProjection = {
      roomId,
      name,
      mode: settings.mode,
      status: 'LOBBY',
      settings,
      serverSeq: 0,
      handNumber: 0,
      phase: null,
      seats: Array.from({ length: 6 }, (_, seat) => ({
        seat,
        playerId: seat === 0 ? playerId : null,
        nickname: seat === 0 ? user.displayName : null,
        stack: seat === 0 ? settings.startingStack : 0,
        topUpTotal: 0,
        lastTopUpAmount: 0,
        committedStreet: 0,
        committedHand: 0,
        ready: false,
        connected: false,
        sittingOut: false,
        folded: false,
        allIn: false,
        role: null,
        positions: [],
        isActing: false,
        hasCards: false,
      })),
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
      requiredReadyCount: 1,
      ownerPlayerId: playerId,
      createdAt: now,
      updatedAt: now,
    };
    const encrypted = encryptSnapshot(
      { runtimeVersion: 1, public: publicSnapshot },
      this.config.SNAPSHOT_KEY,
    );
    await this.db.transaction(async (tx) => {
      await tx
        .select({ id: userAccounts.id })
        .from(userAccounts)
        .where(eq(userAccounts.id, user.id))
        .for('update');
      const [account] = await tx
        .select({ chipBalance: userAccounts.chipBalance, deletedAt: userAccounts.deletedAt })
        .from(userAccounts)
        .where(eq(userAccounts.id, user.id))
        .limit(1);
      if (!account || account.deletedAt) throw new Error('USER_NOT_FOUND');
      if (account.chipBalance < settings.startingStack) {
        throw new Error('INSUFFICIENT_ACCOUNT_CHIPS');
      }
      await tx.insert(rooms).values({
        id: roomId,
        name,
        mode: settings.mode,
        visibility,
        accessPasswordHash:
          visibility === 'PRIVATE' && password ? await argon2.hash(password) : null,
        settings,
        createdByAdminId: null,
        createdByUserId: user.id,
        publicSnapshot,
      });
      await tx.insert(players).values({
        id: playerId,
        roomId,
        userId: user.id,
        nickname: user.displayName,
        stack: settings.startingStack,
        seat: 0,
      });
      const balanceAfter = account.chipBalance - settings.startingStack;
      await tx
        .update(userAccounts)
        .set({ chipBalance: balanceAfter, updatedAt: new Date() })
        .where(eq(userAccounts.id, user.id));
      await tx.insert(ledgerEntries).values({
        roomId,
        seq: 0,
        playerId,
        kind: 'INITIAL_ALLOCATION',
        delta: settings.startingStack,
        balanceAfter: settings.startingStack,
        metadata: { source: 'ROOM_CREATION' },
      });
      await tx.insert(accountLedgerEntries).values({
        userId: user.id,
        roomId,
        playerId,
        kind: 'ROOM_BUY_IN',
        delta: -settings.startingStack,
        balanceAfter,
        metadata: { source: 'ROOM_CREATION' },
      });
      await tx.insert(roomInvites).values({
        roomId,
        tokenHash: hashOpaqueToken(inviteToken, this.config.TOKEN_PEPPER),
      });
      await tx.insert(privateSnapshots).values({ roomId, seq: 0, ...encrypted });
      await tx.insert(auditLogs).values({
        roomId,
        action: 'ROOM_CREATED_BY_USER',
        metadata: { userId: user.id, playerId },
      });
    });
    return { roomId, inviteToken, playerId };
  }

  public async listRooms(origin: string): Promise<AdminRoomSummary[]> {
    const rows = await this.db
      .select({
        id: rooms.id,
        name: rooms.name,
        mode: rooms.mode,
        visibility: rooms.visibility,
        status: rooms.status,
        handNumber: rooms.handNumber,
        createdAt: rooms.createdAt,
        updatedAt: rooms.updatedAt,
        playerCount: sql<number>`count(${players.id}) filter (where ${players.membershipStatus} <> 'KICKED')::int`,
      })
      .from(rooms)
      .leftJoin(players, eq(players.roomId, rooms.id))
      .groupBy(rooms.id)
      .orderBy(desc(rooms.updatedAt));

    const roomIds = rows.map((row) => row.id);
    const inviteRows =
      roomIds.length === 0
        ? []
        : await this.db
            .select({ roomId: roomInvites.roomId })
            .from(roomInvites)
            .where(and(inArray(roomInvites.roomId, roomIds), isNull(roomInvites.revokedAt)));
    const hasInvite = new Set(inviteRows.map((row) => row.roomId));
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      mode: row.mode,
      visibility: row.visibility,
      status: row.status,
      playerCount: row.playerCount,
      handNumber: row.handNumber,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      // Existing raw invite tokens are deliberately not recoverable. Admin rotates to get a new one.
      inviteUrl: hasInvite.has(row.id) ? `${origin}/admin/rooms/${row.id}` : '',
    }));
  }

  public async rotateInvite(roomId: string, adminId: string): Promise<string> {
    const token = randomToken();
    await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select ${rooms.id} from ${rooms} where ${rooms.id} = ${roomId} for update`,
      );
      const [room] = await tx
        .select({ status: rooms.status })
        .from(rooms)
        .where(eq(rooms.id, roomId))
        .limit(1);
      if (!room) throw new Error('ROOM_NOT_FOUND');
      if (room.status === 'ARCHIVED') throw new Error('ROOM_ARCHIVED');
      await tx
        .update(roomInvites)
        .set({ revokedAt: new Date() })
        .where(and(eq(roomInvites.roomId, roomId), isNull(roomInvites.revokedAt)));
      await tx.insert(roomInvites).values({
        roomId,
        tokenHash: hashOpaqueToken(token, this.config.TOKEN_PEPPER),
      });
      await tx.insert(auditLogs).values({
        adminId,
        roomId,
        action: 'ROOM_INVITE_ROTATED',
      });
    });
    return token;
  }

  public async joinByInvite(
    inviteToken: string,
    userId: string,
  ): Promise<{ roomId: string; playerId: string } | null> {
    const tokenHash = hashOpaqueToken(inviteToken, this.config.TOKEN_PEPPER);
    const [invite] = await this.db
      .select({
        roomId: roomInvites.roomId,
        status: rooms.status,
      })
      .from(roomInvites)
      .innerJoin(rooms, eq(roomInvites.roomId, rooms.id))
      .where(
        and(
          eq(roomInvites.tokenHash, tokenHash),
          isNull(roomInvites.revokedAt),
          ne(rooms.status, 'ARCHIVED'),
          sql`(${roomInvites.expiresAt} is null or ${roomInvites.expiresAt} > now())`,
        ),
      )
      .limit(1);
    if (!invite) return null;
    try {
      return await this.addUserToRoom(invite.roomId, userId, 'INVITE', undefined, tokenHash);
    } catch (error) {
      if (error instanceof Error && error.message === 'INVITE_NOT_FOUND') return null;
      throw error;
    }
  }

  public async addUserToRoom(
    roomId: string,
    userId: string,
    source: 'INVITE' | 'ADMIN' | 'SELF',
    adminId?: string,
    inviteTokenHash?: string,
    accessPassword?: string,
  ): Promise<{ roomId: string; playerId: string }> {
    try {
      return await this.db.transaction(async (tx) => {
        // Serialize membership changes for this room so concurrent joins cannot exceed capacity.
        await tx.execute(
          sql`select ${rooms.id} from ${rooms} where ${rooms.id} = ${roomId} for update`,
        );
        const [room] = await tx.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
        if (!room || room.status === 'ARCHIVED') throw new Error('ROOM_NOT_FOUND');
        if (
          source === 'SELF' &&
          room.visibility === 'PRIVATE' &&
          !(await this.checkRoomPassword(room.accessPasswordHash, accessPassword))
        ) {
          throw new Error('PRIVATE_ROOM_PASSWORD_REQUIRED');
        }
        if (source === 'INVITE') {
          const [activeInvite] = inviteTokenHash
            ? await tx
                .select({ id: roomInvites.id })
                .from(roomInvites)
                .where(
                  and(
                    eq(roomInvites.roomId, roomId),
                    eq(roomInvites.tokenHash, inviteTokenHash),
                    isNull(roomInvites.revokedAt),
                    sql`(${roomInvites.expiresAt} is null or ${roomInvites.expiresAt} > now())`,
                  ),
                )
                .limit(1)
            : [];
          if (!activeInvite) throw new Error('INVITE_NOT_FOUND');
        }
        const [account] = await tx
          .select()
          .from(userAccounts)
          .where(eq(userAccounts.id, userId))
          .for('update')
          .limit(1);
        if (!account || account.deletedAt) throw new Error('USER_NOT_FOUND');

        const [existing] = await tx
          .select({ id: players.id, membershipStatus: players.membershipStatus })
          .from(players)
          .where(and(eq(players.roomId, roomId), eq(players.userId, userId)))
          .limit(1);
        if (existing) {
          if (existing.membershipStatus === 'KICKED') throw new Error('MEMBERSHIP_KICKED');
          return { roomId, playerId: existing.id };
        }

        const [count] = await tx
          .select({ value: sql<number>`count(*)::int` })
          .from(players)
          .where(and(eq(players.roomId, roomId), ne(players.membershipStatus, 'KICKED')));
        const settings = room.settings as RoomSettings;
        if ((count?.value ?? 0) >= settings.maxPlayers) throw new Error('ROOM_FULL');

        const playerNickname = account.displayName.trim().slice(0, 20);
        if (
          playerNickname.length === 0 ||
          playerNickname.length > 20 ||
          /[\u0000-\u001f\u007f-\u009f]/u.test(playerNickname)
        ) {
          throw new Error('INVALID_NICKNAME');
        }

        if (account.chipBalance < settings.startingStack) {
          throw new Error('INSUFFICIENT_ACCOUNT_CHIPS');
        }

        const inserted = await tx
          .insert(players)
          .values({
            roomId,
            userId,
            nickname: playerNickname,
            stack: settings.startingStack,
          })
          .returning({ id: players.id });
        const player = inserted[0];
        if (!player) throw new Error('Failed to create room membership');
        const accountBalanceAfter = account.chipBalance - settings.startingStack;
        await tx
          .update(userAccounts)
          .set({ chipBalance: accountBalanceAfter, updatedAt: new Date() })
          .where(eq(userAccounts.id, userId));
        await tx.insert(ledgerEntries).values({
          roomId,
          seq: room.serverSeq,
          playerId: player.id,
          kind: 'INITIAL_ALLOCATION',
          delta: settings.startingStack,
          balanceAfter: settings.startingStack,
          metadata: { source },
        });
        await tx.insert(accountLedgerEntries).values({
          userId,
          roomId,
          playerId: player.id,
          kind: 'ROOM_BUY_IN',
          delta: -settings.startingStack,
          balanceAfter: accountBalanceAfter,
          metadata: { source },
        });
        if (adminId) {
          await tx.insert(auditLogs).values({
            adminId,
            roomId,
            action: 'ROOM_MEMBER_ADDED',
            metadata: { userId, playerId: player.id, source },
          });
        }
        return { roomId, playerId: player.id };
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23505'
      ) {
        throw new Error('MEMBERSHIP_CONFLICT');
      }
      throw error;
    }
  }

  private async checkRoomPassword(hash: string | null, password?: string): Promise<boolean> {
    if (!hash || !password) return false;
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  public async invitePreview(inviteToken: string): Promise<{
    roomId: string;
    name: string;
    mode: 'ONLINE' | 'LIVE';
    status: RoomStatus;
    settings: RoomSettings;
    playerCount: number;
    nicknames: string[];
  } | null> {
    const tokenHash = hashOpaqueToken(inviteToken, this.config.TOKEN_PEPPER);
    const [invite] = await this.db
      .select({
        roomId: rooms.id,
        name: rooms.name,
        mode: rooms.mode,
        status: rooms.status,
        settings: rooms.settings,
      })
      .from(roomInvites)
      .innerJoin(rooms, eq(roomInvites.roomId, rooms.id))
      .where(
        and(
          eq(roomInvites.tokenHash, tokenHash),
          isNull(roomInvites.revokedAt),
          ne(rooms.status, 'ARCHIVED'),
          sql`(${roomInvites.expiresAt} is null or ${roomInvites.expiresAt} > now())`,
        ),
      )
      .limit(1);
    if (!invite) return null;
    const roomPlayers = await this.db
      .select({ nickname: players.nickname })
      .from(players)
      .where(and(eq(players.roomId, invite.roomId), ne(players.membershipStatus, 'KICKED')))
      .orderBy(asc(players.createdAt));
    return {
      roomId: invite.roomId,
      name: invite.name,
      mode: invite.mode,
      status: invite.status,
      settings: invite.settings as RoomSettings,
      playerCount: roomPlayers.length,
      nicknames: roomPlayers.map((player) => player.nickname),
    };
  }

  public async appendChatMessage(
    roomId: string,
    playerId: string,
    text: string,
  ): Promise<ChatMessage | null> {
    const [player] = await this.db
      .select({ nickname: players.nickname })
      .from(players)
      .where(
        and(
          eq(players.id, playerId),
          eq(players.roomId, roomId),
          ne(players.membershipStatus, 'KICKED'),
        ),
      )
      .limit(1);
    if (!player) return null;
    const [row] = await this.db
      .insert(roomChatMessages)
      .values({ roomId, playerId, text })
      .returning({ id: roomChatMessages.id, createdAt: roomChatMessages.createdAt });
    if (!row) return null;
    return {
      id: row.id,
      playerId,
      nickname: player.nickname,
      text,
      createdAt: row.createdAt.toISOString(),
    };
  }

  public async listChatMessages(roomId: string, limit = 100): Promise<ChatMessage[]> {
    const rows = await this.db
      .select({
        id: roomChatMessages.id,
        playerId: roomChatMessages.playerId,
        nickname: players.nickname,
        text: roomChatMessages.text,
        createdAt: roomChatMessages.createdAt,
      })
      .from(roomChatMessages)
      .innerJoin(players, eq(players.id, roomChatMessages.playerId))
      .where(eq(roomChatMessages.roomId, roomId))
      .orderBy(desc(roomChatMessages.createdAt))
      .limit(Math.max(1, Math.min(100, limit)));
    return rows.reverse().map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
  }

  public async getPlayerForUser(
    userId: string,
    roomId: string,
    includeKicked = false,
  ): Promise<AuthenticatedPlayer | null> {
    const [row] = await this.db
      .select({
        id: players.id,
        userId: players.userId,
        roomId: players.roomId,
        nickname: players.nickname,
        seat: players.seat,
        membershipStatus: players.membershipStatus,
        visibility: rooms.visibility,
      })
      .from(players)
      .innerJoin(rooms, eq(players.roomId, rooms.id))
      .where(
        and(
          eq(players.userId, userId),
          eq(players.roomId, roomId),
          ...(includeKicked ? [] : [ne(players.membershipStatus, 'KICKED')]),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  public async getPlayerBySession(
    token: string | undefined,
    roomId?: string,
  ): Promise<AuthenticatedPlayer | null> {
    const user = await this.getUserBySession(token);
    if (!user) return null;
    if (roomId) return this.getPlayerForUser(user.id, roomId);
    const [membership] = await this.db
      .select({ roomId: players.roomId })
      .from(players)
      .where(and(eq(players.userId, user.id), ne(players.membershipStatus, 'KICKED')))
      .orderBy(asc(players.createdAt))
      .limit(1);
    return membership ? this.getPlayerForUser(user.id, membership.roomId) : null;
  }

  public async listUserRooms(userId: string): Promise<UserRoomSummary[]> {
    const rows = await this.db
      .select({
        roomId: rooms.id,
        name: rooms.name,
        mode: rooms.mode,
        status: rooms.status,
        playerId: players.id,
        nickname: players.nickname,
        seat: players.seat,
        stack: players.stack,
        membershipStatus: players.membershipStatus,
        visibility: rooms.visibility,
      })
      .from(players)
      .innerJoin(rooms, eq(players.roomId, rooms.id))
      .where(and(eq(players.userId, userId), ne(players.membershipStatus, 'KICKED')))
      .orderBy(desc(rooms.updatedAt));
    return rows;
  }

  public async listLobbyRooms(userId: string): Promise<LobbyRoomSummary[]> {
    const roomRows = await this.db
      .select({
        roomId: rooms.id,
        name: rooms.name,
        mode: rooms.mode,
        status: rooms.status,
        handNumber: rooms.handNumber,
        settings: rooms.settings,
        updatedAt: rooms.updatedAt,
        visibility: rooms.visibility,
      })
      .from(rooms)
      .where(ne(rooms.status, 'ARCHIVED'))
      .orderBy(desc(rooms.updatedAt));
    if (roomRows.length === 0) return [];

    const roomIds = roomRows.map((room) => room.roomId);
    const playerRows = await this.db
      .select({
        playerId: players.id,
        userId: players.userId,
        roomId: players.roomId,
        nickname: players.nickname,
        seat: players.seat,
        stack: players.stack,
        connected: players.connected,
        membershipStatus: players.membershipStatus,
        createdAt: players.createdAt,
      })
      .from(players)
      .where(inArray(players.roomId, roomIds))
      .orderBy(asc(players.createdAt));

    return roomRows
      .filter(
        (room) =>
          room.visibility === 'PUBLIC' ||
          playerRows.some(
            (p) =>
              p.roomId === room.roomId && p.userId === userId && p.membershipStatus !== 'KICKED',
          ),
      )
      .map((room) => {
        const settings = room.settings as RoomSettings;
        const roomPlayers = playerRows.filter((player) => player.roomId === room.roomId);
        const activePlayers = roomPlayers.filter((player) => player.membershipStatus !== 'KICKED');
        const ownMembership = roomPlayers.find((player) => player.userId === userId) ?? null;
        return {
          roomId: room.roomId,
          name: room.name,
          mode: room.mode,
          status: room.status,
          handNumber: room.handNumber,
          settings,
          playerCount: activePlayers.length,
          availableSeats: Math.max(0, settings.maxPlayers - activePlayers.length),
          players: activePlayers.map((player) => ({
            nickname: player.nickname,
            seat: player.seat,
            connected: player.connected,
          })),
          membership: ownMembership
            ? {
                playerId: ownMembership.playerId,
                nickname: ownMembership.nickname,
                seat: ownMembership.seat,
                stack: ownMembership.stack,
                status: ownMembership.membershipStatus,
              }
            : null,
          visibility: room.visibility,
        };
      });
  }

  public async listRoomPlayers(roomId: string): Promise<AdminRoomPlayerSummary[]> {
    return this.db
      .select({
        playerId: players.id,
        userId: players.userId,
        username: sql<string>`case when ${userAccounts.linkedAdminId} is not null then '管理员' else ${userAccounts.username} end`,
        displayName: userAccounts.displayName,
        nickname: players.nickname,
        stack: players.stack,
        seat: players.seat,
        ready: players.ready,
        connected: players.connected,
        sittingOut: players.sittingOut,
        membershipStatus: players.membershipStatus,
      })
      .from(players)
      .innerJoin(userAccounts, eq(players.userId, userAccounts.id))
      .where(eq(players.roomId, roomId))
      .orderBy(asc(players.createdAt));
  }

  public async loadRoom(roomId: string): Promise<LoadedRoom | null> {
    // Read the room fence, member rows and encrypted snapshot from one consistent version.
    return this.db.transaction(
      async (tx) => {
        const [room] = await tx.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
        if (!room) return null;
        const roomPlayers = await tx
          .select()
          .from(players)
          .where(eq(players.roomId, roomId))
          .orderBy(asc(players.seat), asc(players.createdAt));
        const accountChipsByUserId: Record<string, number> = {};
        const unavailableUserIds: string[] = [];
        if (roomPlayers.length > 0) {
          const accounts = await tx
            .select({
              id: userAccounts.id,
              chipBalance: userAccounts.chipBalance,
              deletedAt: userAccounts.deletedAt,
            })
            .from(userAccounts)
            .where(
              inArray(
                userAccounts.id,
                roomPlayers.map((player) => player.userId),
              ),
            );
          for (const account of accounts) {
            accountChipsByUserId[account.id] = account.chipBalance;
            if (account.deletedAt) unavailableUserIds.push(account.id);
          }
        }
        const [snapshot] = await tx
          .select()
          .from(privateSnapshots)
          .where(eq(privateSnapshots.roomId, roomId))
          .limit(1);
        let privateState: unknown | null = null;
        if (snapshot) {
          privateState = decryptSnapshot(
            {
              keyVersion: snapshot.keyVersion,
              iv: snapshot.iv,
              authTag: snapshot.authTag,
              ciphertext: snapshot.ciphertext,
            },
            this.config.SNAPSHOT_KEY,
          );
        }
        return {
          room,
          players: roomPlayers,
          privateState,
          accountChipsByUserId,
          unavailableUserIds,
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  public async getChipLedger(roomId: string, userId: string): Promise<ChipLedgerResponse> {
    const roomRows = await this.db
      .select({
        id: ledgerEntries.id,
        playerId: ledgerEntries.playerId,
        nickname: players.nickname,
        kind: ledgerEntries.kind,
        delta: ledgerEntries.delta,
        balanceAfter: ledgerEntries.balanceAfter,
        handId: ledgerEntries.handId,
        metadata: ledgerEntries.metadata,
        createdAt: ledgerEntries.createdAt,
      })
      .from(ledgerEntries)
      .innerJoin(players, eq(ledgerEntries.playerId, players.id))
      .where(eq(ledgerEntries.roomId, roomId))
      .orderBy(desc(ledgerEntries.createdAt));
    const accountRows = await this.db
      .select({
        id: accountLedgerEntries.id,
        playerId: accountLedgerEntries.playerId,
        nickname: players.nickname,
        kind: accountLedgerEntries.kind,
        delta: accountLedgerEntries.delta,
        balanceAfter: accountLedgerEntries.balanceAfter,
        handId: sql<string | null>`null`,
        metadata: accountLedgerEntries.metadata,
        createdAt: accountLedgerEntries.createdAt,
      })
      .from(accountLedgerEntries)
      .leftJoin(players, eq(accountLedgerEntries.playerId, players.id))
      .where(eq(accountLedgerEntries.userId, userId))
      .orderBy(desc(accountLedgerEntries.createdAt));
    return {
      room: roomRows.map((row) => ({
        ...row,
        metadata: row.metadata as Record<string, unknown>,
        createdAt: row.createdAt.toISOString(),
      })),
      account: accountRows.map((row) => ({
        ...row,
        metadata: row.metadata as Record<string, unknown>,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  public async getAdminAccountChipLedger(userId: string): Promise<AdminAccountLedgerEntry[]> {
    const rows = await this.db
      .select({
        id: accountLedgerEntries.id,
        userId: accountLedgerEntries.userId,
        username: sql<string>`coalesce(${admins.username}, ${userAccounts.username})`,
        displayName: userAccounts.displayName,
        playerId: accountLedgerEntries.playerId,
        nickname: players.nickname,
        kind: accountLedgerEntries.kind,
        delta: accountLedgerEntries.delta,
        balanceAfter: accountLedgerEntries.balanceAfter,
        handId: sql<string | null>`null`,
        metadata: accountLedgerEntries.metadata,
        roomId: accountLedgerEntries.roomId,
        roomName: rooms.name,
        createdAt: accountLedgerEntries.createdAt,
      })
      .from(accountLedgerEntries)
      .innerJoin(userAccounts, eq(accountLedgerEntries.userId, userAccounts.id))
      .leftJoin(admins, eq(userAccounts.linkedAdminId, admins.id))
      .leftJoin(players, eq(accountLedgerEntries.playerId, players.id))
      .leftJoin(rooms, eq(accountLedgerEntries.roomId, rooms.id))
      .where(eq(accountLedgerEntries.userId, userId))
      .orderBy(desc(accountLedgerEntries.createdAt));
    return rows.map((row) => ({
      ...row,
      metadata: row.metadata as Record<string, unknown>,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  public async getCommandResult(
    roomId: string,
    commandId: string,
    playerId: string,
    requestHash: string,
  ): Promise<{ kind: 'match'; result: CommandResult } | { kind: 'conflict' } | null> {
    const [row] = await this.db
      .select({
        playerId: commandResults.playerId,
        requestHash: commandResults.requestHash,
        result: commandResults.result,
      })
      .from(commandResults)
      .where(and(eq(commandResults.roomId, roomId), eq(commandResults.commandId, commandId)))
      .limit(1);
    if (!row) return null;
    if (row.playerId !== playerId || row.requestHash !== requestHash) return { kind: 'conflict' };
    return {
      kind: 'match',
      result: decryptSnapshot<CommandResult>(
        row.result as EncryptedPayload,
        this.config.SNAPSHOT_KEY,
      ),
    };
  }

  public async commitRoom(commit: RoomCommit): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Serialize all room writes with membership joins before reading cashout stacks.
      const [lockedRoom] = await tx
        .select({ seq: rooms.serverSeq, status: rooms.status })
        .from(rooms)
        .where(eq(rooms.id, commit.roomId))
        .for('update');
      if (!lockedRoom || lockedRoom.seq !== commit.seq - 1 || lockedRoom.status === 'ARCHIVED') {
        throw new Error('ROOM_SEQUENCE_FENCE_CONFLICT');
      }
      const activePlayerIds = commit.playerMutations
        .filter((player) => player.membershipStatus === 'ACTIVE')
        .map((player) => player.playerId);
      if (activePlayerIds.length) {
        const restored = await tx
          .select({ userId: players.userId })
          .from(players)
          .where(
            and(
              eq(players.roomId, commit.roomId),
              inArray(players.id, activePlayerIds),
              ne(players.membershipStatus, 'ACTIVE'),
            ),
          );
        if (restored.length) {
          const accounts = await tx
            .select({ id: userAccounts.id, deletedAt: userAccounts.deletedAt })
            .from(userAccounts)
            .where(
              inArray(
                userAccounts.id,
                restored.map((player) => player.userId),
              ),
            )
            .orderBy(asc(userAccounts.id))
            .for('update');
          if (accounts.length !== restored.length || accounts.some((account) => account.deletedAt))
            throw new Error('USER_NOT_FOUND');
        }
      }
      if (commit.handStart) {
        await tx.insert(hands).values({
          id: commit.handStart.id,
          roomId: commit.roomId,
          handNumber: commit.handStart.handNumber,
          mode: commit.handStart.mode,
          phase: commit.handStart.phase,
          buttonSeat: commit.handStart.buttonSeat,
          initialTotalChips: commit.handStart.initialTotalChips,
          adminHistory: commit.handStart.adminHistory
            ? encryptSnapshot(commit.handStart.adminHistory, this.config.SNAPSHOT_KEY)
            : null,
        });
      }
      if (commit.handUpdate) {
        await tx
          .update(hands)
          .set({
            phase: commit.handUpdate.phase,
            result: commit.handUpdate.result ?? null,
            ...(commit.handUpdate.adminHistory
              ? {
                  adminHistory: encryptSnapshot(
                    commit.handUpdate.adminHistory,
                    this.config.SNAPSHOT_KEY,
                  ),
                }
              : {}),
            endedAt: commit.handUpdate.ended ? new Date() : null,
            updatedAt: new Date(),
          })
          .where(eq(hands.id, commit.handUpdate.id));
      }
      const updatedRoom = await tx
        .update(rooms)
        .set({
          status: commit.status,
          serverSeq: commit.seq,
          handNumber: commit.handNumber,
          publicSnapshot: commit.publicSnapshot,
          settingsLocked: commit.handNumber > 0,
          ...(commit.publicSnapshot.seats.some((seat) => seat.connected)
            ? { lastOnlineAt: new Date() }
            : {}),
          ...(commit.status === 'ARCHIVED'
            ? { archivedAt: new Date(), archiveReason: 'ADMIN_OR_FORCE_ABORT' }
            : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(rooms.id, commit.roomId), eq(rooms.serverSeq, commit.seq - 1)))
        .returning({ id: rooms.id });
      if (updatedRoom.length !== 1) {
        throw new Error('ROOM_SEQUENCE_FENCE_CONFLICT');
      }
      await tx.insert(roomEvents).values({
        roomId: commit.roomId,
        handId: commit.event.handId,
        seq: commit.seq,
        type: commit.event.type,
        actorPlayerId: commit.event.actorPlayerId,
        publicPayload: commit.event.publicPayload ?? {},
      });
      for (const mutation of commit.playerMutations) {
        await tx
          .update(players)
          .set({
            stack: mutation.stack,
            seat: mutation.seat,
            ready: mutation.ready,
            sittingOut: mutation.sittingOut,
            connected: mutation.connected,
            membershipStatus: mutation.membershipStatus,
            kickedAt: mutation.kickedAt ? new Date(mutation.kickedAt) : null,
            kickedByAdminId: mutation.kickedByAdminId,
            kickReason: mutation.kickReason,
            lastSeenAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(players.id, mutation.playerId));
      }
      if (commit.ledgerMutations && commit.ledgerMutations.length > 0) {
        await tx.insert(ledgerEntries).values(
          commit.ledgerMutations.map((mutation) => ({
            roomId: commit.roomId,
            handId: commit.event.handId,
            seq: commit.seq,
            playerId: mutation.playerId,
            kind: mutation.kind,
            delta: mutation.delta,
            balanceAfter: mutation.balanceAfter,
            metadata: mutation.metadata ?? {},
          })),
        );
      }
      const accountBalances: Record<string, number> = {};
      // Every account writer uses current database balances; actors may be stale in other rooms.
      for (const mutation of [...(commit.accountLedgerMutations ?? [])].sort((a, b) =>
        a.userId.localeCompare(b.userId),
      )) {
        const [updated] = await tx
          .update(userAccounts)
          .set({
            chipBalance: sql`${userAccounts.chipBalance} + ${mutation.delta}`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(userAccounts.id, mutation.userId),
              sql`${userAccounts.chipBalance} + ${mutation.delta} >= 0`,
            ),
          )
          .returning({ chipBalance: userAccounts.chipBalance });
        if (!updated) throw new Error('INSUFFICIENT_ACCOUNT_CHIPS');
        accountBalances[mutation.userId] = updated.chipBalance;
        await tx.insert(accountLedgerEntries).values({
          userId: mutation.userId,
          roomId: commit.roomId,
          playerId: mutation.playerId ?? null,
          kind: mutation.kind,
          delta: mutation.delta,
          balanceAfter: updated.chipBalance,
          metadata: mutation.metadata ?? {},
        });
      }
      if (commit.status === 'ARCHIVED') {
        Object.assign(
          accountBalances,
          await this.cashOutRoomPlayers(tx, commit.roomId, commit.seq),
        );
      }
      const runtime = commit.privateState as Partial<RuntimeRoomState>;
      if (runtime.runtimeVersion === 1 && Array.isArray(runtime.players)) {
        for (const player of runtime.players) {
          if (accountBalances[player.userId] !== undefined)
            player.accountChips = accountBalances[player.userId]!;
          if (commit.status === 'ARCHIVED') {
            player.stack = 0;
            player.ready = false;
          }
        }
        const projection = buildProjections(runtime as RuntimeRoomState);
        commit.publicSnapshot = projection.public;
        if (commit.command?.result.ok) {
          commit.command.result.data = {
            public: projection.public,
            private: projection.privateByPlayerId[commit.command.playerId] ?? null,
          };
        }
      }
      await tx
        .update(rooms)
        .set({ publicSnapshot: commit.publicSnapshot })
        .where(eq(rooms.id, commit.roomId));
      const encrypted = encryptSnapshot(commit.privateState, this.config.SNAPSHOT_KEY);
      await tx
        .insert(privateSnapshots)
        .values({ roomId: commit.roomId, seq: commit.seq, ...encrypted })
        .onConflictDoUpdate({
          target: privateSnapshots.roomId,
          set: { seq: commit.seq, ...encrypted, updatedAt: new Date() },
        });
      if (commit.liveProposal) {
        await tx.insert(liveResultProposals).values({
          id: commit.liveProposal.id,
          roomId: commit.roomId,
          handId: commit.liveProposal.handId,
          proposerPlayerId: commit.liveProposal.proposerPlayerId,
          winnersByPot: commit.liveProposal.winnersByPot,
          status: commit.liveProposal.status,
          settleAt: commit.liveProposal.settleAt,
          disputeAt: commit.liveProposal.disputeAt,
        });
      }
      if (commit.liveConfirmation) {
        await tx
          .insert(liveResultConfirmations)
          .values(commit.liveConfirmation)
          .onConflictDoNothing();
      }
      if (commit.liveProposalUpdate) {
        await tx
          .update(liveResultProposals)
          .set({ status: commit.liveProposalUpdate.status, updatedAt: new Date() })
          .where(eq(liveResultProposals.id, commit.liveProposalUpdate.id));
      }
      if (commit.command) {
        await tx.insert(commandResults).values({
          roomId: commit.roomId,
          commandId: commit.command.commandId,
          playerId: commit.command.playerId,
          requestHash: commit.command.requestHash,
          seq: commit.seq,
          result: encryptSnapshot(commit.command.result, this.config.SNAPSHOT_KEY),
        });
      }
      if (commit.audit) {
        await tx.insert(auditLogs).values({
          adminId: commit.audit.adminId ?? null,
          roomId: commit.roomId,
          action: commit.audit.action,
          metadata: commit.audit.metadata ?? {},
        });
      }
    });
  }

  public async persistRejectedCommand(
    roomId: string,
    commandId: string,
    playerId: string,
    requestHash: string,
    seq: number,
    result: CommandResult,
  ): Promise<void> {
    await this.db
      .insert(commandResults)
      .values({
        roomId,
        commandId,
        playerId,
        requestHash,
        seq,
        result: encryptSnapshot(result, this.config.SNAPSHOT_KEY),
      })
      .onConflictDoNothing();
  }

  public async history(roomId: string): Promise<HandHistoryItem[]> {
    const handRows = await this.db
      .select()
      .from(hands)
      .where(eq(hands.roomId, roomId))
      .orderBy(desc(hands.handNumber))
      .limit(100);
    if (handRows.length === 0) return [];
    const eventRows = await this.db
      .select()
      .from(roomEvents)
      .where(
        inArray(
          roomEvents.handId,
          handRows.map((hand) => hand.id),
        ),
      )
      .orderBy(asc(roomEvents.seq));
    return handRows.map((hand) => ({
      handId: hand.id,
      handNumber: hand.handNumber,
      startedAt: hand.startedAt.toISOString(),
      endedAt: hand.endedAt?.toISOString() ?? null,
      mode: hand.mode,
      result: hand.result,
      events: eventRows
        .filter((event) => event.handId === hand.id)
        .map((event) => ({
          seq: event.seq,
          type: event.type,
          createdAt: event.createdAt.toISOString(),
          publicPayload: event.publicPayload,
        })),
    }));
  }

  public async adminHistory(roomId: string): Promise<AdminHandHistoryItem[]> {
    const handRows = await this.db
      .select()
      .from(hands)
      .where(eq(hands.roomId, roomId))
      .orderBy(desc(hands.handNumber))
      .limit(100);
    if (handRows.length === 0) return [];
    const eventRows = await this.db
      .select()
      .from(roomEvents)
      .where(
        inArray(
          roomEvents.handId,
          handRows.map((hand) => hand.id),
        ),
      )
      .orderBy(asc(roomEvents.seq));
    return handRows.map((hand) => {
      let cards: AdminHandHistoryItem['cards'] = null;
      if (hand.adminHistory) {
        try {
          const decoded = decryptSnapshot<AdminHandHistoryItem['cards']>(
            hand.adminHistory as EncryptedPayload,
            this.config.SNAPSHOT_KEY,
          );
          if (decoded && typeof decoded === 'object') cards = decoded;
        } catch {
          cards = null;
        }
      }
      return {
        handId: hand.id,
        handNumber: hand.handNumber,
        startedAt: hand.startedAt.toISOString(),
        endedAt: hand.endedAt?.toISOString() ?? null,
        mode: hand.mode,
        result: hand.result,
        cards,
        events: eventRows
          .filter((event) => event.handId === hand.id)
          .map((event) => ({
            seq: event.seq,
            type: event.type,
            createdAt: event.createdAt.toISOString(),
            publicPayload: event.publicPayload,
          })),
      };
    });
  }

  /** The caller holds the room row lock, including when recovering pre-settlement archives. */
  private async cashOutRoomPlayers(
    tx: PokerTransaction,
    roomId: string,
    seq: number,
  ): Promise<Record<string, number>> {
    const members = await tx
      .select()
      .from(players)
      .where(eq(players.roomId, roomId))
      .orderBy(asc(players.userId))
      .for('update');
    const balances: Record<string, number> = {};
    for (const member of members) {
      if (member.stack <= 0) continue;
      const [account] = await tx
        .update(userAccounts)
        .set({
          chipBalance: sql`${userAccounts.chipBalance} + ${member.stack}`,
          updatedAt: new Date(),
        })
        .where(eq(userAccounts.id, member.userId))
        .returning({ chipBalance: userAccounts.chipBalance });
      if (!account) throw new Error('CASH_OUT_ACCOUNT_NOT_FOUND');
      balances[member.userId] = account.chipBalance;
      await tx.insert(accountLedgerEntries).values({
        userId: member.userId,
        roomId,
        playerId: member.id,
        kind: 'ROOM_CASH_OUT',
        delta: member.stack,
        balanceAfter: account.chipBalance,
        metadata: { seq },
      });
      await tx.insert(ledgerEntries).values({
        roomId,
        seq,
        playerId: member.id,
        kind: 'CASH_OUT',
        delta: -member.stack,
        balanceAfter: 0,
        metadata: { accountBalanceAfter: account.chipBalance },
      });
    }
    await tx
      .update(players)
      .set({ stack: 0, ready: false, updatedAt: new Date() })
      .where(eq(players.roomId, roomId));
    return balances;
  }

  public async archiveRoom(
    roomId: string,
    adminId: string,
    _reason: string,
    allowActive = false,
  ): Promise<boolean> {
    // Keep this legacy entry point on the actor's hand-refund and room-fenced settlement path.
    const loaded = await this.loadRoom(roomId);
    if (!loaded) return false;
    if (!allowActive && (loaded.room.status === 'ACTIVE' || loaded.room.status === 'DISPUTED'))
      return false;
    const { RoomActor } = await import('./room/actor.js');
    const actor = new RoomActor(loaded, this, () => undefined);
    return allowActive ? actor.adminForceAbort(adminId) : actor.adminArchive(adminId);
  }

  public async reconcileArchivedRoomChips(roomIds?: string[]): Promise<number> {
    if (roomIds?.length === 0) return 0;
    const candidates = await this.db
      .select({ id: rooms.id })
      .from(rooms)
      .where(
        and(
          roomIds ? inArray(rooms.id, roomIds) : undefined,
          eq(rooms.status, 'ARCHIVED'),
          sql`exists (select 1 from ${players} where ${players.roomId} = ${rooms.id} and ${players.stack} > 0)`,
        ),
      )
      .orderBy(asc(rooms.id));
    let reconciled = 0;
    for (const candidate of candidates) {
      const changed = await this.db.transaction(async (tx) => {
        const [room] = await tx
          .select()
          .from(rooms)
          .where(eq(rooms.id, candidate.id))
          .for('update');
        if (!room || room.status !== 'ARCHIVED') return false;
        const balances = await this.cashOutRoomPlayers(tx, room.id, room.serverSeq);
        if (Object.keys(balances).length === 0) return false;
        const [snapshot] = await tx
          .select()
          .from(privateSnapshots)
          .where(eq(privateSnapshots.roomId, room.id));
        if (snapshot) {
          const runtime = decryptSnapshot<Partial<RuntimeRoomState>>(
            snapshot,
            this.config.SNAPSHOT_KEY,
          );
          if (runtime.runtimeVersion === 1 && Array.isArray(runtime.players)) {
            for (const player of runtime.players) {
              player.stack = 0;
              player.ready = false;
              if (balances[player.userId] !== undefined)
                player.accountChips = balances[player.userId]!;
            }
            runtime.status = 'ARCHIVED';
            runtime.nextHandAt = null;
          }
          await tx
            .update(privateSnapshots)
            .set({ ...encryptSnapshot(runtime, this.config.SNAPSHOT_KEY), updatedAt: new Date() })
            .where(eq(privateSnapshots.roomId, room.id));
        }
        const publicSnapshot = room.publicSnapshot as Partial<PublicRoomProjection>;
        await tx
          .update(rooms)
          .set({
            publicSnapshot: {
              ...publicSnapshot,
              ...(Array.isArray(publicSnapshot.seats)
                ? {
                    seats: publicSnapshot.seats.map((seat) => ({
                      ...seat,
                      stack: 0,
                      ready: false,
                    })),
                  }
                : {}),
              readyCount: 0,
              nextHandAt: null,
            },
            updatedAt: new Date(),
          })
          .where(eq(rooms.id, room.id));
        await tx.insert(auditLogs).values({
          roomId: room.id,
          action: 'ARCHIVED_ROOM_CHIPS_RECONCILED',
          metadata: { seq: room.serverSeq },
        });
        return true;
      });
      if (changed) reconciled += 1;
    }
    return reconciled;
  }

  public async cleanupExpiredData(): Promise<{
    hands: number;
    events: number;
    commands: number;
    audits: number;
    archivedRooms: number;
  }> {
    await this.reconcileArchivedRoomChips();
    const before = new Date(Date.now() - this.config.RETENTION_DAYS * 24 * 60 * 60 * 1_000);
    const [deletedHands, deletedEvents, deletedCommands, deletedAudits, deletedRooms] =
      await this.db.transaction(async (tx) => {
        const handRows = await tx
          .delete(hands)
          .where(and(sql`${hands.endedAt} is not null`, lt(hands.endedAt, before)))
          .returning({ id: hands.id });
        const eventRows = await tx
          .delete(roomEvents)
          .where(lt(roomEvents.createdAt, before))
          .returning({ id: roomEvents.id });
        const commandRows = await tx
          .delete(commandResults)
          .where(lt(commandResults.createdAt, before))
          .returning({ commandId: commandResults.commandId });
        const auditRows = await tx
          .delete(auditLogs)
          .where(lt(auditLogs.createdAt, before))
          .returning({ id: auditLogs.id });
        await tx.delete(adminSessions).where(lt(adminSessions.expiresAt, new Date()));
        await tx.delete(userSessions).where(lt(userSessions.expiresAt, new Date()));
        const roomRows = await tx
          .delete(rooms)
          .where(
            and(
              eq(rooms.status, 'ARCHIVED'),
              sql`${rooms.archivedAt} is not null`,
              lt(rooms.archivedAt, before),
              // Preserve financial records and never delete an unsettled membership.
              sql`not exists (select 1 from ${players} where ${players.roomId} = ${rooms.id} and ${players.stack} > 0)`,
              sql`not exists (select 1 from ${accountLedgerEntries} where ${accountLedgerEntries.roomId} = ${rooms.id})`,
            ),
          )
          .returning({ id: rooms.id });
        return [handRows, eventRows, commandRows, auditRows, roomRows] as const;
      });
    return {
      hands: deletedHands.length,
      events: deletedEvents.length,
      commands: deletedCommands.length,
      audits: deletedAudits.length,
      archivedRooms: deletedRooms.length,
    };
  }

  public async findIdleRooms(): Promise<Array<{ id: string; status: RoomStatus }>> {
    const before = new Date(Date.now() - this.config.ROOM_IDLE_HOURS * 60 * 60 * 1_000);
    return this.db
      .select({ id: rooms.id, status: rooms.status })
      .from(rooms)
      .where(and(ne(rooms.status, 'ARCHIVED'), lt(rooms.lastOnlineAt, before)))
      .orderBy(asc(rooms.lastOnlineAt));
  }

  public async ping(): Promise<void> {
    await this.db.execute(sql`select 1`);
  }
}
