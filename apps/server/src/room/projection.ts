import { buildSidePots, getLegalActions, orderedSeatsAfter } from '@poker-with-friends/engine';
import type {
  PlayerAction,
  PotProjection,
  PrivatePlayerProjection,
  PublicActionPrompt,
  PublicRoomProjection,
  PublicSeat,
} from '@poker-with-friends/protocol';
import { liveProposalProjection, type ProjectionBundle, type RuntimeRoomState } from './state.js';

type TablePosition = 'BTN' | 'SB' | 'BB' | 'UTG' | 'HJ' | 'CO';

function positionsBySeat(state: RuntimeRoomState): Map<number, TablePosition[]> {
  const hand = state.hand;
  if (!hand) return new Map();
  const participantSeats = hand.participantIds
    .map((id) => state.players.find((player) => player.id === id)?.seat)
    .filter((seat): seat is number => seat !== null && seat !== undefined);
  const result = new Map<number, TablePosition[]>();
  if (participantSeats.length < 2) return result;
  result.set(hand.buttonSeat, ['BTN']);
  result.set(hand.smallBlindSeat, hand.smallBlindSeat === hand.buttonSeat ? ['BTN', 'SB'] : ['SB']);
  result.set(hand.bigBlindSeat, ['BB']);
  const unlabelled = orderedSeatsAfter(participantSeats, hand.bigBlindSeat).filter(
    (seat) => !result.has(seat),
  );
  const labels: TablePosition[][] =
    unlabelled.length >= 3
      ? [['UTG'], ['HJ'], ['CO']]
      : unlabelled.length === 2
        ? [['UTG'], ['CO']]
        : unlabelled.length === 1
          ? [['UTG', 'CO']]
          : [];
  unlabelled.forEach((seat, index) => result.set(seat, labels[index] ?? ['CO']));
  return result;
}

function liveDealerSeat(state: RuntimeRoomState): number | null {
  const hand = state.hand;
  if (!hand) return null;
  const participants = state.players.filter(
    (player) => player.seat !== null && hand.participantIds.includes(player.id),
  );
  const button = participants.find((player) => player.seat === hand.buttonSeat);
  if (button?.connected) return button.seat;
  const seats = participants.flatMap((player) => (player.seat === null ? [] : [player.seat]));
  if (seats.length === 0) return null;
  for (const seat of orderedSeatsAfter(seats, hand.buttonSeat)) {
    if (participants.find((player) => player.seat === seat)?.connected) return seat;
  }
  return null;
}

function projectPrompt(state: RuntimeRoomState): PublicActionPrompt | null {
  const hand = state.hand;
  if (!hand || hand.betting.complete || hand.betting.actorId === null || !hand.actionDeadlineAt) {
    return null;
  }
  const legal = getLegalActions(hand.betting);
  const player = hand.betting.players.find((candidate) => candidate.playerId === legal.playerId);
  if (!player) return null;
  const legalActions: PlayerAction[] = [];
  if (legal.canFold) legalActions.push('FOLD');
  if (legal.canCheck) legalActions.push('CHECK');
  if (legal.callAmount !== null) legalActions.push('CALL');
  if (legal.betTo) legalActions.push('BET_TO');
  if (legal.raiseTo) legalActions.push('RAISE_TO');
  if (legal.canAllIn) legalActions.push('ALL_IN');
  return {
    playerId: legal.playerId,
    callAmount: legal.callAmount ?? 0,
    minBetTo: legal.betTo?.minimumTo ?? null,
    minRaiseTo: legal.raiseTo?.minimumTo ?? null,
    maxTo: player.committedStreet + player.stack,
    legalActions,
    deadlineAt: hand.actionDeadlineAt,
    currentBet: hand.betting.currentBet,
    committedStreet: player.committedStreet,
    potBeforeAction: hand.betting.players.reduce(
      (sum, candidate) => sum + candidate.committedHand,
      0,
    ),
    raiseDepth: hand.raiseDepth,
  } as PublicActionPrompt;
}

function projectedPots(state: RuntimeRoomState): PotProjection[] {
  const hand = state.hand;
  if (!hand) return [];
  const build =
    hand.sidePotBuild ??
    buildSidePots(
      hand.betting.players.map((player) => ({
        playerId: player.playerId,
        amount: player.committedHand,
        folded: player.folded,
      })),
    );
  return build.pots.map((pot) => ({
    id: `pot-${pot.index}`,
    amount: pot.amount,
    eligiblePlayerIds: [...pot.eligiblePlayerIds],
  }));
}

function projectSeat(state: RuntimeRoomState, seat: number): PublicSeat {
  const player = state.players.find((candidate) => candidate.seat === seat);
  if (!player) {
    return {
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
    };
  }
  const hand = state.hand;
  const bettingPlayer = hand?.betting.players.find((candidate) => candidate.playerId === player.id);
  const isSettled = hand?.phase === 'SETTLED';
  const role =
    hand?.buttonSeat === seat
      ? 'D'
      : hand?.smallBlindSeat === seat
        ? 'SB'
        : hand?.bigBlindSeat === seat
          ? 'BB'
          : null;
  const revealed = hand?.revealedPlayerIds.includes(player.id) ?? false;
  return {
    seat,
    playerId: player.id,
    nickname: player.nickname,
    stack: !isSettled && bettingPlayer ? bettingPlayer.stack : player.stack,
    committedStreet: isSettled ? 0 : (bettingPlayer?.committedStreet ?? 0),
    committedHand: isSettled ? 0 : (bettingPlayer?.committedHand ?? 0),
    ready: player.ready,
    connected: player.connected,
    sittingOut: player.sittingOut,
    folded: bettingPlayer?.folded ?? false,
    allIn: bettingPlayer?.allIn ?? false,
    role,
    isActing: Boolean(
      hand &&
      bettingPlayer &&
      hand.betting.actorId !== null &&
      bettingPlayer.playerId === hand.betting.actorId,
    ),
    hasCards: hand?.participantIds.includes(player.id) ?? false,
    ...(revealed ? { revealedCards: hand?.holeCards[player.id] ?? [] } : {}),
    positions: positionsBySeat(state).get(seat) ?? [],
  } as PublicSeat;
}

export function buildProjections(state: RuntimeRoomState): ProjectionBundle {
  const hand = state.hand;
  const prompt = projectPrompt(state);
  const eligibleForNextHand = state.players.filter(
    (player) =>
      player.seat !== null &&
      player.connected &&
      !player.sittingOut &&
      player.stack > 0 &&
      player.membershipStatus === 'ACTIVE',
  );
  const publicProjection: PublicRoomProjection = {
    roomId: state.roomId,
    name: state.name,
    mode: state.settings.mode,
    status: state.status,
    settings: state.settings,
    serverSeq: state.serverSeq,
    handNumber: state.handNumber,
    phase: hand?.phase ?? null,
    seats: Array.from({ length: 6 }, (_, seat) => projectSeat(state, seat)),
    communityCards: hand?.communityCards ?? [],
    pots: projectedPots(state),
    actingSeat:
      hand?.betting.actorId === null || hand?.betting.actorId === undefined
        ? null
        : (state.players.find((player) => player.id === hand.betting.actorId)?.seat ?? null),
    buttonSeat: hand?.buttonSeat ?? state.previousButtonSeat,
    smallBlindSeat: hand?.smallBlindSeat ?? null,
    bigBlindSeat: hand?.bigBlindSeat ?? null,
    liveDealerSeat: state.settings.mode === 'LIVE' ? liveDealerSeat(state) : null,
    pendingLiveStreet: hand?.pendingLiveStreet ?? null,
    prompt,
    liveResultProposal: liveProposalProjection(hand?.liveProposal ?? null),
    message: state.message,
    nextHandAt: state.nextHandAt,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    readyCount: eligibleForNextHand.filter((player) => player.ready).length,
    requiredReadyCount: eligibleForNextHand.length,
  } as PublicRoomProjection;
  const privateByPlayerId: Record<string, PrivatePlayerProjection> = {};
  for (const player of state.players) {
    if (player.membershipStatus === 'KICKED') continue;
    const ownsTurn = hand?.betting.actorId === player.id && hand.turnToken !== null;
    privateByPlayerId[player.id] = {
      playerId: player.id,
      roomId: state.roomId,
      seat: player.seat,
      holeCards: hand?.holeCards[player.id] ?? [],
      ...(ownsTurn ? { turnToken: hand.turnToken as string } : {}),
    };
  }
  return {
    public: publicProjection,
    privateByPlayerId,
    revokedPlayerIds: state.players
      .filter((player) => player.membershipStatus === 'KICKED')
      .map((player) => player.id),
  };
}

export function currentLiveDealerPlayerId(state: RuntimeRoomState): string | null {
  const seat = liveDealerSeat(state);
  return seat === null ? null : (state.players.find((player) => player.seat === seat)?.id ?? null);
}
