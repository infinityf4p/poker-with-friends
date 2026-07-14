import type { BettingRoundState, Card, SidePotBuild } from '@poker-with-friends/engine';
import type {
  HandPhase,
  LiveResultProposal,
  MembershipStatus,
  PlayerAction,
  PrivatePlayerProjection,
  PublicRoomProjection,
  RoomSettings,
  RoomStatus,
} from '@poker-with-friends/protocol';

export interface RuntimePlayer {
  id: string;
  nickname: string;
  seat: number | null;
  stack: number;
  ready: boolean;
  connected: boolean;
  sittingOut: boolean;
  membershipStatus: MembershipStatus;
  kickedAt: string | null;
  kickedByAdminId: string | null;
  kickReason: string | null;
}

export interface RuntimeLiveProposal {
  id: string;
  proposerPlayerId: string;
  winnersByPot: Record<string, string[]>;
  objectedByPlayerIds: string[];
  confirmedByPlayerIds: string[];
  proposedAt: string;
  autoSettleAt: string;
  disputeAt: string;
  superseded: boolean;
}

export interface RuntimeHand {
  id: string;
  number: number;
  phase: HandPhase;
  buttonSeat: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  participantIds: string[];
  deck: Card[];
  deckCursor: number;
  holeCards: Record<string, Card[]>;
  communityCards: Card[];
  betting: BettingRoundState;
  /** Number of full voluntary wagers on the current street. Used for 3-bet/4-bet shortcuts. */
  raiseDepth: number;
  turnToken: string | null;
  actionDeadlineAt: string | null;
  pendingLiveStreet: 'FLOP' | 'TURN' | 'RIVER' | null;
  sidePotBuild: SidePotBuild | null;
  liveProposal: RuntimeLiveProposal | null;
  liveHadObjection: boolean;
  revealedPlayerIds: string[];
  result: unknown | null;
  initialTotalChips: number;
}

export interface RuntimeRoomState {
  runtimeVersion: 1;
  roomId: string;
  name: string;
  settings: RoomSettings;
  status: RoomStatus;
  serverSeq: number;
  handNumber: number;
  previousButtonSeat: number | null;
  players: RuntimePlayer[];
  hand: RuntimeHand | null;
  nextHandAt: string | null;
  message: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ActionInput {
  action: PlayerAction;
  amountTo?: number | undefined;
}

export interface ProjectionBundle {
  public: PublicRoomProjection;
  privateByPlayerId: Record<string, PrivatePlayerProjection>;
  revokedPlayerIds: string[];
}

export function liveProposalProjection(
  proposal: RuntimeLiveProposal | null,
): LiveResultProposal | null {
  if (!proposal || proposal.superseded) return null;
  return {
    id: proposal.id,
    proposerPlayerId: proposal.proposerPlayerId,
    winnersByPot: proposal.winnersByPot,
    objectedByPlayerIds: proposal.objectedByPlayerIds,
    confirmedByPlayerIds: proposal.confirmedByPlayerIds,
    expiresAt: proposal.autoSettleAt,
    disputeAt: proposal.disputeAt,
  };
}
