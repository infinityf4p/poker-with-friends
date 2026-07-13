import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import {
  adminSessions,
  admins,
  auditLogs,
  commandResults,
  hands,
  ledgerEntries,
  liveResultConfirmations,
  liveResultProposals,
  players,
  privateSnapshots,
  roomEvents,
  roomInvites,
  rooms,
  userAccounts,
  userSessions,
  type PlayerRow,
  type PokerDatabase,
  type RoomRow,
} from '@poker/db';
import type {
  AdminRoomSummary,
  AdminRoomPlayerSummary,
  AdminUserSummary,
  CommandResult,
  HandHistoryItem,
  LobbyRoomSummary,
  PublicRoomProjection,
  RoomSettings,
  RoomStatus,
  UserRoomSummary,
  UserSession,
} from '@poker/protocol';
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

export interface AuthenticatedAdmin {
  id: string;
  username: string;
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
}

export interface HandUpdateMutation {
  id: string;
  phase: 'POST_BLINDS' | 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER' | 'SHOWDOWN' | 'SETTLED';
  result?: unknown;
  ended?: boolean;
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
}): UserSession {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    mustChangePassword: row.mustChangePassword,
  };
}

export class PokerRepository {
  public constructor(
    private readonly db: PokerDatabase,
    private readonly config: AppConfig,
  ) {}

  public async ensureConfiguredAdmin(): Promise<void> {
    if (!this.config.ADMIN_PASSWORD_HASH) return;
    await this.db.transaction(async (tx) => {
      let [existing] = await tx
        .select({ id: admins.id, passwordHash: admins.passwordHash })
        .from(admins)
        .where(eq(admins.username, this.config.ADMIN_USERNAME))
        .limit(1);
      if (!existing) {
        await tx
          .insert(admins)
          .values({
            username: this.config.ADMIN_USERNAME,
            passwordHash: this.config.ADMIN_PASSWORD_HASH!,
          })
          .onConflictDoNothing({ target: admins.username });
        [existing] = await tx
          .select({ id: admins.id, passwordHash: admins.passwordHash })
          .from(admins)
          .where(eq(admins.username, this.config.ADMIN_USERNAME))
          .limit(1);
      }
      if (existing && existing.passwordHash !== this.config.ADMIN_PASSWORD_HASH) {
        await tx
          .update(admins)
          .set({ passwordHash: this.config.ADMIN_PASSWORD_HASH!, updatedAt: new Date() })
          .where(eq(admins.id, existing.id));
        await tx.delete(adminSessions).where(eq(adminSessions.adminId, existing.id));
      }
    });
  }

  public async verifyAdmin(username: string, password: string): Promise<AuthenticatedAdmin | null> {
    const [admin] = await this.db
      .select()
      .from(admins)
      .where(eq(admins.username, username))
      .limit(1);
    if (!admin || !(await argon2.verify(admin.passwordHash, password))) return null;
    return { id: admin.id, username: admin.username };
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
      .select({ id: admins.id, username: admins.username })
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
    if (!account || !account.loginEnabled || !account.passwordHash) {
      await argon2.verify(DUMMY_USER_PASSWORD_HASH, password).catch(() => false);
      return null;
    }
    if (!(await argon2.verify(account.passwordHash, password))) return null;
    return userSession(account);
  }

  public async createUserSession(userId: string): Promise<string> {
    const token = randomToken();
    await this.db.insert(userSessions).values({
      userId,
      tokenHash: hashOpaqueToken(token, this.config.TOKEN_PEPPER),
      expiresAt: expiresAt(),
    });
    return token;
  }

  public async getUserBySession(token: string | undefined): Promise<AuthenticatedUser | null> {
    if (!token) return null;
    const tokenHash = hashOpaqueToken(token, this.config.TOKEN_PEPPER);
    const [row] = await this.db
      .select({
        id: userAccounts.id,
        username: userAccounts.username,
        displayName: userAccounts.displayName,
        mustChangePassword: userAccounts.mustChangePassword,
      })
      .from(userSessions)
      .innerJoin(userAccounts, eq(userSessions.userId, userAccounts.id))
      .where(
        and(
          eq(userSessions.tokenHash, tokenHash),
          gt(userSessions.expiresAt, new Date()),
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
    currentPassword: string,
    newPassword: string,
  ): Promise<{ user: AuthenticatedUser; sessionToken: string } | null> {
    const [account] = await this.db
      .select()
      .from(userAccounts)
      .where(eq(userAccounts.id, userId))
      .limit(1);
    if (!account?.passwordHash || !(await argon2.verify(account.passwordHash, currentPassword))) {
      return null;
    }
    const passwordHash = await argon2.hash(newPassword, USER_PASSWORD_OPTIONS);
    const sessionToken = randomToken();
    const [updated] = await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(userAccounts)
        .set({ passwordHash, mustChangePassword: false, updatedAt: new Date() })
        .where(eq(userAccounts.id, userId))
        .returning();
      await tx.delete(userSessions).where(eq(userSessions.userId, userId));
      await tx.insert(userSessions).values({
        userId,
        tokenHash: hashOpaqueToken(sessionToken, this.config.TOKEN_PEPPER),
        expiresAt: expiresAt(),
      });
      return rows;
    });
    return updated ? { user: userSession(updated), sessionToken } : null;
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
            mustChangePassword: true,
            createdByAdminId: adminId,
          })
          .onConflictDoNothing({ target: userAccounts.username })
          .returning();
        const account = rows[0];
        if (!account) throw new Error('USERNAME_TAKEN');
        if (account) {
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
      .select()
      .from(userAccounts)
      .where(isNull(userAccounts.linkedAdminId))
      .orderBy(asc(userAccounts.createdAt));
    return rows.map((row) => ({
      ...userSession(row),
      loginEnabled: row.loginEnabled,
      linkedAdminId: row.linkedAdminId,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  public async ensureAdminPlayerAccount(admin: AuthenticatedAdmin): Promise<AuthenticatedUser> {
    const [existing] = await this.db
      .select()
      .from(userAccounts)
      .where(eq(userAccounts.linkedAdminId, admin.id))
      .limit(1);
    if (existing) return userSession(existing);
    try {
      const [created] = await this.db.transaction(async (tx) => {
        const rows = await tx
          .insert(userAccounts)
          .values({
            username: `admin-${admin.id}`,
            displayName: admin.username,
            passwordHash: null,
            mustChangePassword: false,
            loginEnabled: false,
            linkedAdminId: admin.id,
            createdByAdminId: admin.id,
          })
          .returning();
        const account = rows[0];
        if (account) {
          await tx.insert(auditLogs).values({
            adminId: admin.id,
            action: 'ADMIN_PLAYER_ACCOUNT_CREATED',
            metadata: { userId: account.id },
          });
        }
        return rows;
      });
      if (!created) throw new Error('Failed to create admin player account');
      return userSession(created);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23505'
      ) {
        const [concurrent] = await this.db
          .select()
          .from(userAccounts)
          .where(eq(userAccounts.linkedAdminId, admin.id))
          .limit(1);
        if (concurrent) return userSession(concurrent);
      }
      throw error;
    }
  }

  public async resetUserPassword(
    adminId: string,
    userId: string,
    password: string,
  ): Promise<boolean> {
    const passwordHash = await argon2.hash(password, USER_PASSWORD_OPTIONS);
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(userAccounts)
        .set({ passwordHash, mustChangePassword: true, loginEnabled: true, updatedAt: new Date() })
        .where(eq(userAccounts.id, userId))
        .returning({ id: userAccounts.id });
      if (updated.length === 0) return false;
      await tx.delete(userSessions).where(eq(userSessions.userId, userId));
      await tx.insert(auditLogs).values({
        adminId,
        action: 'USER_PASSWORD_RESET',
        metadata: { userId },
      });
      return true;
    });
  }

  public async createRoom(
    admin: AuthenticatedAdmin,
    name: string,
    settings: RoomSettings,
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
      message: '等待玩家加入并准备',
      nextHandAt: null,
      readyCount: 0,
      requiredReadyCount: 0,
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
        settings,
        createdByAdminId: admin.id,
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

  public async listRooms(origin: string): Promise<AdminRoomSummary[]> {
    const rows = await this.db
      .select({
        id: rooms.id,
        name: rooms.name,
        mode: rooms.mode,
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
    nickname?: string,
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
      return await this.addUserToRoom(
        invite.roomId,
        userId,
        nickname,
        'INVITE',
        undefined,
        tokenHash,
      );
    } catch (error) {
      if (error instanceof Error && error.message === 'INVITE_NOT_FOUND') return null;
      throw error;
    }
  }

  public async addUserToRoom(
    roomId: string,
    userId: string,
    nickname: string | undefined,
    source: 'INVITE' | 'ADMIN' | 'SELF',
    adminId?: string,
    inviteTokenHash?: string,
  ): Promise<{ roomId: string; playerId: string }> {
    try {
      return await this.db.transaction(async (tx) => {
        // Serialize membership changes for this room so concurrent invite joins
        // cannot exceed capacity or claim the same case-insensitive nickname.
        await tx.execute(
          sql`select ${rooms.id} from ${rooms} where ${rooms.id} = ${roomId} for update`,
        );
        const [room] = await tx.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
        if (!room || room.status === 'ARCHIVED') throw new Error('ROOM_NOT_FOUND');
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
          .limit(1);
        if (!account) throw new Error('USER_NOT_FOUND');

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

        const fallbackNickname = account.linkedAdminId
          ? account.displayName.slice(0, 20)
          : account.displayName;
        const playerNickname = nickname?.trim() || fallbackNickname;
        if (
          playerNickname.length === 0 ||
          playerNickname.length > 20 ||
          /[\u0000-\u001f\u007f-\u009f]/u.test(playerNickname)
        ) {
          throw new Error('INVALID_NICKNAME');
        }
        const duplicate = await tx
          .select({ id: players.id })
          .from(players)
          .where(
            and(
              eq(players.roomId, roomId),
              ne(players.membershipStatus, 'KICKED'),
              sql`lower(${players.nickname}) = lower(${playerNickname})`,
            ),
          )
          .limit(1);
        if (duplicate.length > 0) throw new Error('NICKNAME_TAKEN');

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
        await tx.insert(ledgerEntries).values({
          roomId,
          seq: room.serverSeq,
          playerId: player.id,
          kind: 'INITIAL_ALLOCATION',
          delta: settings.startingStack,
          balanceAfter: settings.startingStack,
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
      })
      .from(players)
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
    if (!user || user.mustChangePassword) return null;
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

    return roomRows.map((room) => {
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
    const [room] = await this.db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
    if (!room) return null;
    const roomPlayers = await this.db
      .select()
      .from(players)
      .where(eq(players.roomId, roomId))
      .orderBy(asc(players.seat), asc(players.createdAt));
    const [snapshot] = await this.db
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
    return { room, players: roomPlayers, privateState };
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
    const encrypted = encryptSnapshot(commit.privateState, this.config.SNAPSHOT_KEY);
    await this.db.transaction(async (tx) => {
      if (commit.handStart) {
        await tx.insert(hands).values({
          id: commit.handStart.id,
          roomId: commit.roomId,
          handNumber: commit.handStart.handNumber,
          mode: commit.handStart.mode,
          phase: commit.handStart.phase,
          buttonSeat: commit.handStart.buttonSeat,
          initialTotalChips: commit.handStart.initialTotalChips,
        });
      }
      if (commit.handUpdate) {
        await tx
          .update(hands)
          .set({
            phase: commit.handUpdate.phase,
            result: commit.handUpdate.result ?? null,
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
      await tx
        .insert(privateSnapshots)
        .values({ roomId: commit.roomId, seq: commit.seq, ...encrypted })
        .onConflictDoUpdate({
          target: privateSnapshots.roomId,
          set: { seq: commit.seq, ...encrypted, updatedAt: new Date() },
        });
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

  public async archiveRoom(
    roomId: string,
    adminId: string,
    reason: string,
    allowActive = false,
  ): Promise<boolean> {
    const conditions = [eq(rooms.id, roomId), ne(rooms.status, 'ARCHIVED')];
    if (!allowActive) conditions.push(ne(rooms.status, 'ACTIVE'));
    const updated = await this.db
      .update(rooms)
      .set({
        status: 'ARCHIVED',
        archivedAt: new Date(),
        archiveReason: reason,
        updatedAt: new Date(),
      })
      .where(and(...conditions))
      .returning({ id: rooms.id });
    if (updated.length > 0) {
      await this.db
        .insert(auditLogs)
        .values({ adminId, roomId, action: 'ROOM_ARCHIVED', metadata: { reason } });
    }
    return updated.length > 0;
  }

  public async cleanupExpiredData(): Promise<{
    hands: number;
    events: number;
    commands: number;
    audits: number;
    archivedRooms: number;
  }> {
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
