import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const roomModeEnum = pgEnum('room_mode', ['ONLINE', 'LIVE']);
export const roomStatusEnum = pgEnum('room_status', [
  'LOBBY',
  'ACTIVE',
  'BETWEEN_HANDS',
  'DISPUTED',
  'ARCHIVED',
]);
export const roomVisibilityEnum = pgEnum('room_visibility', ['PUBLIC', 'PRIVATE']);
export const membershipStatusEnum = pgEnum('membership_status', [
  'ACTIVE',
  'KICK_PENDING',
  'KICKED',
]);
export const handPhaseEnum = pgEnum('hand_phase', [
  'POST_BLINDS',
  'PREFLOP',
  'FLOP',
  'TURN',
  'RIVER',
  'SHOWDOWN',
  'SETTLED',
]);

const createdAtColumn = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAtColumn = () =>
  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const admins = pgTable('admins', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: text('username').notNull().unique(),
  displayName: text('display_name').notNull().default(''),
  passwordHash: text('password_hash').notNull(),
  passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
});

export const adminSessions = pgTable(
  'admin_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adminId: uuid('admin_id')
      .notNull()
      .references(() => admins.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [uniqueIndex('admin_sessions_token_hash_idx').on(table.tokenHash)],
);

export const userAccounts = pgTable('user_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: text('username').notNull().unique(),
  displayName: text('display_name').notNull(),
  chipBalance: bigint('chip_balance', { mode: 'number' }).notNull().default(50_000),
  passwordHash: text('password_hash'),
  mustChangePassword: boolean('must_change_password').notNull().default(false),
  loginEnabled: boolean('login_enabled').notNull().default(true),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  linkedAdminId: uuid('linked_admin_id')
    .unique()
    .references(() => admins.id, { onDelete: 'set null' }),
  createdByAdminId: uuid('created_by_admin_id').references(() => admins.id, {
    onDelete: 'set null',
  }),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
});

export const userSessions = pgTable(
  'user_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => userAccounts.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAtColumn(),
  },
  (table) => [uniqueIndex('user_sessions_token_hash_idx').on(table.tokenHash)],
);

export const rooms = pgTable(
  'rooms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    mode: roomModeEnum('mode').notNull(),
    status: roomStatusEnum('status').notNull().default('LOBBY'),
    visibility: roomVisibilityEnum('visibility').notNull().default('PUBLIC'),
    accessPasswordHash: text('access_password_hash'),
    settings: jsonb('settings').notNull(),
    settingsLocked: boolean('settings_locked').notNull().default(false),
    serverSeq: bigint('server_seq', { mode: 'number' }).notNull().default(0),
    handNumber: integer('hand_number').notNull().default(0),
    publicSnapshot: jsonb('public_snapshot')
      .notNull()
      .default(sql`'{}'::jsonb`),
    lastOnlineAt: timestamp('last_online_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    archiveReason: text('archive_reason'),
    createdByAdminId: uuid('created_by_admin_id').references(() => admins.id, {
      onDelete: 'restrict',
    }),
    createdByUserId: uuid('created_by_user_id').references(() => userAccounts.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [index('rooms_status_updated_idx').on(table.status, table.updatedAt)],
);

export const roomInvites = pgTable(
  'room_invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAtColumn(),
  },
  (table) => [uniqueIndex('room_invites_token_hash_idx').on(table.tokenHash)],
);

export const players = pgTable(
  'players',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => userAccounts.id, { onDelete: 'restrict' }),
    nickname: text('nickname').notNull(),
    stack: bigint('stack', { mode: 'number' }).notNull(),
    seat: integer('seat'),
    ready: boolean('ready').notNull().default(false),
    sittingOut: boolean('sitting_out').notNull().default(false),
    connected: boolean('connected').notNull().default(false),
    membershipStatus: membershipStatusEnum('membership_status').notNull().default('ACTIVE'),
    kickedAt: timestamp('kicked_at', { withTimezone: true }),
    kickedByAdminId: uuid('kicked_by_admin_id').references(() => admins.id, {
      onDelete: 'set null',
    }),
    kickReason: text('kick_reason'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('players_room_seat_idx')
      .on(table.roomId, table.seat)
      .where(sql`${table.seat} is not null`),
    uniqueIndex('players_room_user_idx').on(table.roomId, table.userId),
    index('players_room_idx').on(table.roomId),
    check(
      'players_seat_range',
      sql`${table.seat} is null or (${table.seat} >= 0 and ${table.seat} <= 5)`,
    ),
    check('players_stack_nonnegative', sql`${table.stack} >= 0`),
  ],
);

export const hands = pgTable(
  'hands',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    handNumber: integer('hand_number').notNull(),
    mode: roomModeEnum('mode').notNull(),
    phase: handPhaseEnum('phase').notNull().default('POST_BLINDS'),
    buttonSeat: integer('button_seat').notNull(),
    initialTotalChips: bigint('initial_total_chips', { mode: 'number' }).notNull(),
    result: jsonb('result'),
    adminHistory: jsonb('admin_history'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('hands_room_number_idx').on(table.roomId, table.handNumber),
    index('hands_retention_idx').on(table.endedAt),
  ],
);

export const roomEvents = pgTable(
  'room_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    handId: uuid('hand_id').references(() => hands.id, { onDelete: 'cascade' }),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    type: text('type').notNull(),
    actorPlayerId: uuid('actor_player_id').references(() => players.id, { onDelete: 'set null' }),
    publicPayload: jsonb('public_payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex('room_events_room_seq_idx').on(table.roomId, table.seq),
    index('room_events_hand_idx').on(table.handId),
    index('room_events_retention_idx').on(table.createdAt),
  ],
);

export const roomChatMessages = pgTable(
  'room_chat_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [index('room_chat_messages_room_created_idx').on(table.roomId, table.createdAt)],
);

export const privateSnapshots = pgTable('private_snapshots', {
  roomId: uuid('room_id')
    .primaryKey()
    .references(() => rooms.id, { onDelete: 'cascade' }),
  seq: bigint('seq', { mode: 'number' }).notNull(),
  keyVersion: integer('key_version').notNull().default(1),
  iv: text('iv').notNull(),
  authTag: text('auth_tag').notNull(),
  ciphertext: text('ciphertext').notNull(),
  updatedAt: updatedAtColumn(),
});

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    handId: uuid('hand_id').references(() => hands.id, { onDelete: 'cascade' }),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    delta: bigint('delta', { mode: 'number' }).notNull(),
    balanceAfter: bigint('balance_after', { mode: 'number' }).notNull(),
    metadata: jsonb('metadata')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAtColumn(),
  },
  (table) => [
    index('ledger_room_seq_idx').on(table.roomId, table.seq),
    index('ledger_hand_idx').on(table.handId),
  ],
);

export const accountLedgerEntries = pgTable(
  'account_ledger_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => userAccounts.id, { onDelete: 'cascade' }),
    roomId: uuid('room_id').references(() => rooms.id, { onDelete: 'cascade' }),
    playerId: uuid('player_id').references(() => players.id, { onDelete: 'set null' }),
    kind: text('kind').notNull(),
    delta: bigint('delta', { mode: 'number' }).notNull(),
    balanceAfter: bigint('balance_after', { mode: 'number' }).notNull(),
    metadata: jsonb('metadata')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAtColumn(),
  },
  (table) => [
    index('account_ledger_user_created_idx').on(table.userId, table.createdAt),
    index('account_ledger_room_created_idx').on(table.roomId, table.createdAt),
  ],
);

export const registrationInvites = pgTable(
  'registration_invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull(),
    createdByAdminId: uuid('created_by_admin_id').references(() => admins.id, {
      onDelete: 'set null',
    }),
    createdByUserId: uuid('created_by_user_id').references(() => userAccounts.id, {
      onDelete: 'set null',
    }),
    usedAt: timestamp('used_at', { withTimezone: true }),
    usedByUserId: uuid('used_by_user_id').references(() => userAccounts.id, {
      onDelete: 'set null',
    }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: createdAtColumn(),
  },
  (table) => [uniqueIndex('registration_invites_token_hash_idx').on(table.tokenHash)],
);

export const commandResults = pgTable(
  'command_results',
  {
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    commandId: uuid('command_id').notNull(),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    requestHash: text('request_hash').notNull(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    result: jsonb('result').notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    primaryKey({ columns: [table.roomId, table.commandId] }),
    index('command_results_retention_idx').on(table.createdAt),
  ],
);

export const liveResultProposals = pgTable(
  'live_result_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    handId: uuid('hand_id')
      .notNull()
      .references(() => hands.id, { onDelete: 'cascade' }),
    proposerPlayerId: uuid('proposer_player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    winnersByPot: jsonb('winners_by_pot').notNull(),
    status: text('status').notNull().default('PENDING'),
    settleAt: timestamp('settle_at', { withTimezone: true }).notNull(),
    disputeAt: timestamp('dispute_at', { withTimezone: true }).notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [index('live_proposals_room_status_idx').on(table.roomId, table.status)],
);

export const liveResultConfirmations = pgTable(
  'live_result_confirmations',
  {
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => liveResultProposals.id, { onDelete: 'cascade' }),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [primaryKey({ columns: [table.proposalId, table.playerId, table.kind] })],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adminId: uuid('admin_id').references(() => admins.id, { onDelete: 'set null' }),
    roomId: uuid('room_id').references(() => rooms.id, { onDelete: 'cascade' }),
    action: text('action').notNull(),
    ip: text('ip'),
    metadata: jsonb('metadata')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAtColumn(),
  },
  (table) => [index('audit_logs_retention_idx').on(table.createdAt)],
);

export type RoomRow = typeof rooms.$inferSelect;
export type PlayerRow = typeof players.$inferSelect;
export type UserAccountRow = typeof userAccounts.$inferSelect;
export type HandRow = typeof hands.$inferSelect;
