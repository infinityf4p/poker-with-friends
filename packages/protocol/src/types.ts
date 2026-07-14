export type RoomMode = 'ONLINE' | 'LIVE';

export type RoomStatus = 'LOBBY' | 'ACTIVE' | 'BETWEEN_HANDS' | 'DISPUTED' | 'ARCHIVED';
export type MembershipStatus = 'ACTIVE' | 'KICK_PENDING' | 'KICKED';

export type HandPhase =
  'POST_BLINDS' | 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER' | 'SHOWDOWN' | 'SETTLED';

export type PlayerAction = 'FOLD' | 'CHECK' | 'CALL' | 'BET_TO' | 'RAISE_TO' | 'ALL_IN';
export type TablePosition = 'BTN' | 'SB' | 'BB' | 'UTG' | 'HJ' | 'CO';

export type Suit = 'c' | 'd' | 'h' | 's';
export type Rank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A';
export type Card = `${Rank}${Suit}`;

export interface RoomSettings {
  mode: RoomMode;
  smallBlind: number;
  bigBlind: number;
  startingStack: number;
  stackCap: number;
  actionTimeoutSeconds: number;
  resultDisplaySeconds: number;
  nextHandCountdownSeconds: number;
  maxPlayers: 6;
}

export interface PotProjection {
  id: string;
  amount: number;
  eligiblePlayerIds: string[];
}

export interface PublicSeat {
  seat: number;
  playerId: string | null;
  nickname: string | null;
  stack: number;
  committedStreet: number;
  committedHand: number;
  ready: boolean;
  connected: boolean;
  sittingOut: boolean;
  folded: boolean;
  allIn: boolean;
  role: 'D' | 'SB' | 'BB' | null;
  /** A heads-up button is also the small blind, so a seat may have multiple labels. */
  positions: TablePosition[];
  isActing: boolean;
  hasCards: boolean;
  revealedCards?: Card[];
}

export interface PublicActionPrompt {
  playerId: string;
  callAmount: number;
  minBetTo: number | null;
  minRaiseTo: number | null;
  maxTo: number;
  legalActions: PlayerAction[];
  deadlineAt: string;
  currentBet: number;
  committedStreet: number;
  potBeforeAction: number;
  /** Full voluntary wagers made on this street; 0=open, 1=3-bet, 2=4-bet. */
  raiseDepth: number;
}

export interface LiveResultProposal {
  id: string;
  proposerPlayerId: string;
  winnersByPot: Record<string, string[]>;
  objectedByPlayerIds: string[];
  confirmedByPlayerIds: string[];
  expiresAt: string;
  disputeAt: string;
}

export interface PublicRoomProjection {
  roomId: string;
  name: string;
  mode: RoomMode;
  status: RoomStatus;
  settings: RoomSettings;
  serverSeq: number;
  handNumber: number;
  phase: HandPhase | null;
  seats: PublicSeat[];
  communityCards: Card[];
  pots: PotProjection[];
  actingSeat: number | null;
  buttonSeat: number | null;
  smallBlindSeat: number | null;
  bigBlindSeat: number | null;
  liveDealerSeat: number | null;
  pendingLiveStreet: 'FLOP' | 'TURN' | 'RIVER' | null;
  prompt: PublicActionPrompt | null;
  liveResultProposal: LiveResultProposal | null;
  nextHandAt: string | null;
  readyCount: number;
  requiredReadyCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PrivatePlayerProjection {
  playerId: string;
  roomId: string;
  seat: number | null;
  holeCards: Card[];
  turnToken?: string;
}

export interface RoomSnapshotEnvelope {
  public: PublicRoomProjection;
  private: PrivatePlayerProjection | null;
}

export interface CommandEnvelope<T> {
  commandId: string;
  expectedSeq: number;
  turnToken?: string;
  payload: T;
}

export interface CommandSuccess<T = RoomSnapshotEnvelope> {
  ok: true;
  serverSeq: number;
  data: T;
}

export interface CommandFailure {
  ok: false;
  code:
    | 'BAD_REQUEST'
    | 'UNAUTHORIZED'
    | 'FORBIDDEN'
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'STALE_SEQUENCE'
    | 'STALE_TURN'
    | 'ILLEGAL_ACTION'
    | 'ROOM_ARCHIVED'
    | 'INTERNAL_ERROR';
  message: string;
  serverSeq?: number;
}

export type CommandResult<T = RoomSnapshotEnvelope> = CommandSuccess<T> | CommandFailure;

export interface AdminRoomSummary {
  id: string;
  name: string;
  mode: RoomMode;
  status: RoomStatus;
  playerCount: number;
  handNumber: number;
  createdAt: string;
  updatedAt: string;
  inviteUrl: string;
}

export interface UserSession {
  id: string;
  username: string;
  displayName: string;
  mustChangePassword: boolean;
}

export interface UserRoomSummary {
  roomId: string;
  name: string;
  mode: RoomMode;
  status: RoomStatus;
  playerId: string;
  nickname: string;
  seat: number | null;
  stack: number;
  membershipStatus: MembershipStatus;
}

export interface LobbyRoomPlayerSummary {
  nickname: string;
  seat: number | null;
  connected: boolean;
}

export interface LobbyRoomSummary {
  roomId: string;
  name: string;
  mode: RoomMode;
  status: RoomStatus;
  handNumber: number;
  settings: RoomSettings;
  playerCount: number;
  availableSeats: number;
  players: LobbyRoomPlayerSummary[];
  membership: {
    playerId: string;
    nickname: string;
    seat: number | null;
    stack: number;
    status: MembershipStatus;
  } | null;
}

export interface AdminUserSummary extends UserSession {
  loginEnabled: boolean;
  linkedAdminId: string | null;
  createdAt: string;
}

export interface AdminRoomPlayerSummary {
  playerId: string;
  userId: string;
  username: string;
  displayName: string;
  nickname: string;
  stack: number;
  seat: number | null;
  ready: boolean;
  connected: boolean;
  sittingOut: boolean;
  membershipStatus: MembershipStatus;
}

export interface RoomMembershipResponse {
  roomId: string;
  playerId: string;
}

export interface AdminPlayAsSelfResponse extends RoomMembershipResponse {
  user: UserSession;
}

export interface HandHistoryItem {
  handId: string;
  handNumber: number;
  startedAt: string;
  endedAt: string | null;
  mode: RoomMode;
  result: unknown;
  events: Array<{
    seq: number;
    type: string;
    createdAt: string;
    publicPayload: unknown;
  }>;
}

export const DEFAULT_ROOM_SETTINGS: Omit<RoomSettings, 'mode'> = {
  smallBlind: 10,
  bigBlind: 20,
  startingStack: 2_000,
  stackCap: 2_000,
  actionTimeoutSeconds: 30,
  resultDisplaySeconds: 3,
  nextHandCountdownSeconds: 5,
  maxPlayers: 6,
};
