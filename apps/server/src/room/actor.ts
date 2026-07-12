import { createHash, randomInt, randomUUID } from 'node:crypto';
import {
  BettingRuleError,
  applyBettingAction,
  buildSidePots,
  createBettingRound,
  evaluateBestHand,
  getLegalActions,
  getTablePositions,
  orderedSeatsAfter,
  rotateDealerButton,
  settleSidePots,
  shuffleDeck,
  type BettingAction,
  type BettingPlayerState,
  type Card,
  type HandRank,
  type PotSettlement,
  type SidePotBuild,
} from '@poker/engine';
import type {
  CommandFailure,
  CommandResult,
  CommandSuccess,
  EmptyCommand,
  HandActionCommand,
  LiveResultProposalIdCommand,
  LiveResultProposeCommand,
  LiveStreetDealtCommand,
  PublicRoomProjection,
  RoomSnapshotEnvelope,
  SeatClaimCommand,
  TablePosition,
  TopUpCommand,
} from '@poker/protocol';
import type { LoadedRoom, PlayerMutation, PokerRepository, RoomCommit } from '../repository.js';
import { randomToken } from '../security/crypto.js';
import { buildProjections, currentLiveDealerPlayerId } from './projection.js';
import type {
  ActionInput,
  ProjectionBundle,
  RuntimeHand,
  RuntimeLiveProposal,
  RuntimePlayer,
  RuntimeRoomState,
} from './state.js';

const MAX_TIMER_MS = 2_147_000_000;
const HAND_SCOPED_EVENTS = new Set([
  'HAND_STARTED',
  'PLAYER_ACTED',
  'PLAYER_TIMED_OUT',
  'STREET_DEALT',
  'HAND_SETTLED',
  'LIVE_STREET_AWAITING_DEAL',
  'LIVE_STREET_DEALT',
  'LIVE_SHOWDOWN_READY',
  'LIVE_RESULT_PROPOSED',
  'LIVE_RESULT_OBJECTED',
  'LIVE_RESULT_CONFIRMED',
  'LIVE_RESULT_REQUIRES_CONFIRMATION',
  'LIVE_RESULT_DISPUTED',
  'ROOM_FORCE_ABORTED',
]);

interface MutationExtras {
  eventType: string;
  publicPayload?: Record<string, unknown>;
  ledgerMutations?: RoomCommit['ledgerMutations'];
  handStart?: RoomCommit['handStart'];
  handUpdate?: RoomCommit['handUpdate'];
  liveProposal?: RoomCommit['liveProposal'];
  liveConfirmation?: RoomCommit['liveConfirmation'];
  liveProposalUpdate?: RoomCommit['liveProposalUpdate'];
  audit?: RoomCommit['audit'];
}

interface CommandEnvelopeLike {
  commandId: string;
  expectedSeq: number;
  turnToken?: string | undefined;
}

type ProjectionListener = (roomId: string, projection: ProjectionBundle) => void;

export type AdminPlayerOperationResult =
  | {
      ok: true;
      playerId: string;
      membershipStatus: RuntimePlayer['membershipStatus'];
      stack: number;
      pending?: boolean;
    }
  | { ok: false; code: 'NOT_FOUND' | 'CONFLICT'; message: string };

class RoomRuleError extends Error {
  public constructor(
    public readonly code: CommandFailure['code'],
    message: string,
  ) {
    super(message);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return '"__undefined__"';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function commandRequestHash(playerId: string, envelope: CommandEnvelopeLike): string {
  return createHash('sha256').update(canonicalJson({ playerId, envelope })).digest('base64url');
}

function asRuntimeState(loaded: LoadedRoom): RuntimeRoomState {
  const stored = loaded.privateState as Partial<RuntimeRoomState> | null;
  if (
    stored?.runtimeVersion === 1 &&
    stored.roomId === loaded.room.id &&
    Array.isArray(stored.players)
  ) {
    const rowsById = new Map(loaded.players.map((player) => [player.id, player]));
    return {
      ...(stored as RuntimeRoomState),
      // Socket presence cannot survive a process restart.
      players: (stored.players as RuntimePlayer[]).map((player) => ({
        ...player,
        connected: false,
        membershipStatus:
          rowsById.get(player.id)?.membershipStatus ?? player.membershipStatus ?? 'ACTIVE',
        kickedAt: rowsById.get(player.id)?.kickedAt?.toISOString() ?? player.kickedAt ?? null,
        kickedByAdminId: rowsById.get(player.id)?.kickedByAdminId ?? player.kickedByAdminId ?? null,
        kickReason: rowsById.get(player.id)?.kickReason ?? player.kickReason ?? null,
      })),
      hand: stored.hand
        ? {
            ...(stored.hand as RuntimeHand),
            raiseDepth: (stored.hand as Partial<RuntimeHand>).raiseDepth ?? 0,
          }
        : null,
      updatedAt: nowIso(),
    };
  }
  const publicSnapshot = loaded.room.publicSnapshot as { createdAt?: string };
  return {
    runtimeVersion: 1,
    roomId: loaded.room.id,
    name: loaded.room.name,
    settings: loaded.room.settings as RuntimeRoomState['settings'],
    status: loaded.room.status,
    serverSeq: loaded.room.serverSeq,
    handNumber: loaded.room.handNumber,
    previousButtonSeat: null,
    players: loaded.players.map((player) => ({
      id: player.id,
      nickname: player.nickname,
      seat: player.seat,
      stack: player.stack,
      ready: player.ready,
      connected: false,
      sittingOut: player.sittingOut,
      membershipStatus: player.membershipStatus,
      kickedAt: player.kickedAt?.toISOString() ?? null,
      kickedByAdminId: player.kickedByAdminId,
      kickReason: player.kickReason,
    })),
    hand: null,
    nextHandAt: null,
    message: loaded.room.status === 'ARCHIVED' ? '房间已归档' : '等待玩家加入并准备',
    createdAt: publicSnapshot.createdAt ?? loaded.room.createdAt.toISOString(),
    updatedAt: nowIso(),
  };
}

function playerMutations(state: RuntimeRoomState): PlayerMutation[] {
  return state.players.map((player) => ({
    playerId: player.id,
    stack: player.stack,
    seat: player.seat,
    ready: player.ready,
    sittingOut: player.sittingOut,
    connected: player.connected,
    membershipStatus: player.membershipStatus,
    kickedAt: player.kickedAt,
    kickedByAdminId: player.kickedByAdminId,
    kickReason: player.kickReason,
  }));
}

function eligiblePlayers(state: RuntimeRoomState): RuntimePlayer[] {
  return state.players
    .filter(
      (player) =>
        player.seat !== null &&
        player.connected &&
        !player.sittingOut &&
        player.stack > 0 &&
        player.membershipStatus === 'ACTIVE',
    )
    .sort((left, right) => left.seat! - right.seat!);
}

function activePlayers(state: RuntimeRoomState): RuntimePlayer[] {
  return eligiblePlayers(state).filter((player) => player.ready);
}

function everyoneReady(state: RuntimeRoomState): boolean {
  const eligible = eligiblePlayers(state);
  return eligible.length >= 2 && eligible.every((player) => player.ready);
}

function resetReadyConfirmations(state: RuntimeRoomState): void {
  for (const player of state.players) player.ready = false;
}

function handPlayer(hand: RuntimeHand, playerId: string): BettingPlayerState {
  const player = hand.betting.players.find((candidate) => candidate.playerId === playerId);
  if (!player) throw new Error(`Hand player ${playerId} is missing`);
  return player;
}

function nextActionDeadline(state: RuntimeRoomState): string {
  return new Date(Date.now() + state.settings.actionTimeoutSeconds * 1_000).toISOString();
}

function actionFromInput(input: ActionInput): BettingAction {
  switch (input.action) {
    case 'FOLD':
    case 'CHECK':
    case 'CALL':
    case 'ALL_IN':
      return { type: input.action };
    case 'BET_TO':
    case 'RAISE_TO':
      if (input.amountTo === undefined) {
        throw new RoomRuleError('BAD_REQUEST', '下注或加注必须提供目标金额');
      }
      return { type: input.action, amountTo: input.amountTo };
  }
}

function actionLabel(action: ActionInput['action']): string {
  return {
    FOLD: '弃牌',
    CHECK: '过牌',
    CALL: '跟注',
    BET_TO: '下注',
    RAISE_TO: '加注',
    ALL_IN: '全下',
  }[action];
}

function oddChipPlayerOrder(state: RuntimeRoomState, hand: RuntimeHand): string[] {
  const seats = hand.participantIds
    .map((id) => state.players.find((player) => player.id === id)?.seat)
    .filter((seat): seat is number => seat !== null && seat !== undefined);
  return orderedSeatsAfter(seats, hand.buttonSeat)
    .map((seat) => state.players.find((player) => player.seat === seat)?.id)
    .filter((id): id is string => id !== undefined);
}

function tablePositions(
  seats: number[],
  buttonSeat: number,
  smallBlindSeat: number,
  bigBlindSeat: number,
): Map<number, TablePosition[]> {
  const result = new Map<number, TablePosition[]>();
  result.set(buttonSeat, ['BTN']);
  result.set(smallBlindSeat, smallBlindSeat === buttonSeat ? ['BTN', 'SB'] : ['SB']);
  result.set(bigBlindSeat, ['BB']);
  const unlabelled = orderedSeatsAfter(seats, bigBlindSeat).filter((seat) => !result.has(seat));
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

function drawStreet(hand: RuntimeHand, street: 'FLOP' | 'TURN' | 'RIVER'): void {
  // Burn one card before each public street.
  hand.deckCursor += 1;
  const count = street === 'FLOP' ? 3 : 1;
  const cards = hand.deck.slice(hand.deckCursor, hand.deckCursor + count);
  if (cards.length !== count) throw new Error('Deck exhausted while dealing a street');
  hand.communityCards.push(...cards);
  hand.deckCursor += count;
  hand.phase = street;
}

function resetBettingForStreet(state: RuntimeRoomState, hand: RuntimeHand): void {
  const seats = hand.participantIds
    .map((id) => state.players.find((player) => player.id === id)?.seat)
    .filter((seat): seat is number => seat !== null && seat !== undefined);
  const order = orderedSeatsAfter(seats, hand.buttonSeat);
  const previous = hand.betting.players;
  const firstActionableSeat = order.find((seat) => {
    const id = state.players.find((player) => player.seat === seat)?.id;
    const old = previous.find((player) => player.playerId === id);
    return old !== undefined && !old.folded && old.stack > 0;
  });
  const fallback = previous.find((player) => !player.folded)?.playerId ?? previous[0]!.playerId;
  const firstActorId =
    firstActionableSeat === undefined
      ? fallback
      : state.players.find((player) => player.seat === firstActionableSeat)!.id;
  hand.betting = createBettingRound({
    players: previous.map((player) => ({
      playerId: player.playerId,
      seat: player.seat,
      stack: player.stack,
      committedStreet: 0,
      committedHand: player.committedHand,
      folded: player.folded,
    })),
    firstActorId,
    minimumBet: state.settings.bigBlind,
    lastFullRaiseSize: state.settings.bigBlind,
  });
  hand.raiseDepth = 0;
}

function buildCurrentPots(hand: RuntimeHand): SidePotBuild {
  return buildSidePots(
    hand.betting.players.map((player) => ({
      playerId: player.playerId,
      amount: player.committedHand,
      folded: player.folded,
    })),
  );
}

function settlementLedger(
  state: RuntimeRoomState,
  hand: RuntimeHand,
  settlement: PotSettlement,
): NonNullable<RoomCommit['ledgerMutations']> {
  const ledger: NonNullable<RoomCommit['ledgerMutations']> = [];
  for (const payout of settlement.payouts) {
    const player = state.players.find((candidate) => candidate.id === payout.playerId)!;
    player.stack = handPlayer(hand, payout.playerId).stack + payout.amount;
    ledger.push({
      playerId: player.id,
      kind: 'PAYOUT',
      delta: payout.amount,
      balanceAfter: player.stack,
      metadata: { handId: hand.id },
    });
  }
  for (const participantId of hand.participantIds) {
    if (settlement.payouts.some((payout) => payout.playerId === participantId)) continue;
    const player = state.players.find((candidate) => candidate.id === participantId)!;
    player.stack = handPlayer(hand, participantId).stack;
  }
  return ledger;
}

function assertHandChipsConserved(state: RuntimeRoomState, hand: RuntimeHand): void {
  const finalTotal = hand.participantIds.reduce((sum, playerId) => {
    const player = state.players.find((candidate) => candidate.id === playerId);
    if (!player) throw new Error(`Missing participant ${playerId} during conservation check`);
    return sum + player.stack;
  }, 0);
  if (finalTotal !== hand.initialTotalChips) {
    throw new Error(
      `Hand chip conservation failed: expected ${hand.initialTotalChips}, got ${finalTotal}`,
    );
  }
}

function finishSettledHand(
  state: RuntimeRoomState,
  result: unknown,
  ledgerMutations: NonNullable<RoomCommit['ledgerMutations']>,
): MutationExtras {
  const hand = state.hand!;
  assertHandChipsConserved(state, hand);
  hand.phase = 'SETTLED';
  hand.turnToken = null;
  hand.actionDeadlineAt = null;
  hand.pendingLiveStreet = null;
  hand.liveProposal = null;
  hand.liveHadObjection = false;
  hand.result = result;
  state.status = 'BETWEEN_HANDS';
  state.previousButtonSeat = hand.buttonSeat;
  state.nextHandAt = null;
  const kickedPlayerIds = state.players
    .filter((player) => player.membershipStatus === 'KICK_PENDING')
    .map((player) => {
      player.membershipStatus = 'KICKED';
      player.kickedAt = nowIso();
      player.seat = null;
      player.ready = false;
      player.sittingOut = true;
      player.connected = false;
      return player.id;
    });
  resetReadyConfirmations(state);
  state.message = `第 ${hand.number} 手已结算，请所有在线在座玩家确认下一手`;
  return {
    eventType: 'HAND_SETTLED',
    publicPayload: { handNumber: hand.number, result, kickedPlayerIds },
    ledgerMutations,
    handUpdate: { id: hand.id, phase: 'SETTLED', result, ended: true },
  };
}

function settleUncontested(state: RuntimeRoomState): MutationExtras {
  const hand = state.hand!;
  const build = buildCurrentPots(hand);
  hand.sidePotBuild = build;
  const remaining = hand.betting.players.filter((player) => !player.folded);
  if (remaining.length !== 1)
    throw new Error('Uncontested settlement requires one remaining player');
  const settlement = settleSidePots(build, new Map(), oddChipPlayerOrder(state, hand));
  const ledger = settlementLedger(state, hand, settlement);
  const result = {
    reason: 'UNCONTESTED',
    winnerIds: [remaining[0]!.playerId],
    awards: settlement.awards,
    refunds: settlement.refunds,
  };
  return finishSettledHand(state, result, ledger);
}

function settleOnlineShowdown(state: RuntimeRoomState): MutationExtras {
  const hand = state.hand!;
  if (hand.communityCards.length !== 5)
    throw new Error('Online showdown requires five community cards');
  const ranks = new Map<string, HandRank>();
  for (const player of hand.betting.players.filter((candidate) => !candidate.folded)) {
    ranks.set(
      player.playerId,
      evaluateBestHand([...hand.holeCards[player.playerId]!, ...hand.communityCards]),
    );
  }
  const build = buildCurrentPots(hand);
  hand.sidePotBuild = build;
  const settlement = settleSidePots(build, ranks, oddChipPlayerOrder(state, hand));
  hand.revealedPlayerIds = hand.betting.players
    .filter((player) => !player.folded)
    .map((player) => player.playerId);
  const ledger = settlementLedger(state, hand, settlement);
  const result = {
    reason: 'SHOWDOWN',
    communityCards: [...hand.communityCards],
    awards: settlement.awards,
    refunds: settlement.refunds,
    ranks: Object.fromEntries(
      [...ranks.entries()].map(([playerId, rank]) => [
        playerId,
        { category: rank.category, tiebreak: rank.tiebreak, cards: rank.cards },
      ]),
    ),
  };
  return finishSettledHand(state, result, ledger);
}

function manualLiveSettlement(
  state: RuntimeRoomState,
  winnersByPot: Record<string, string[]>,
): MutationExtras {
  const hand = state.hand!;
  const proposalId = hand.liveProposal?.id;
  const build = hand.sidePotBuild ?? buildCurrentPots(hand);
  hand.sidePotBuild = build;
  const order = oddChipPlayerOrder(state, hand);
  const orderIndex = new Map(order.map((playerId, index) => [playerId, index]));
  const payout = new Map<string, number>();
  for (const refund of build.refunds)
    payout.set(refund.playerId, (payout.get(refund.playerId) ?? 0) + refund.amount);
  const awards = build.pots.map((pot) => {
    const potId = `pot-${pot.index}`;
    const winners = [...(winnersByPot[potId] ?? [])].sort(
      (left, right) => (orderIndex.get(left) ?? 99) - (orderIndex.get(right) ?? 99),
    );
    if (winners.length === 0 || winners.some((winner) => !pot.eligiblePlayerIds.includes(winner))) {
      throw new RoomRuleError('ILLEGAL_ACTION', `${potId} 的赢家不具备该底池资格`);
    }
    const equal = Math.floor(pot.amount / winners.length);
    let odd = pot.amount % winners.length;
    const shares = winners.map((playerId) => {
      const amount = equal + (odd-- > 0 ? 1 : 0);
      payout.set(playerId, (payout.get(playerId) ?? 0) + amount);
      return { playerId, amount };
    });
    return { potIndex: pot.index, amount: pot.amount, winnerIds: winners, shares };
  });
  const totalPaid = [...payout.values()].reduce((sum, amount) => sum + amount, 0);
  if (totalPaid !== build.totalContributed)
    throw new Error('Live settlement does not conserve chips');
  const settlement: PotSettlement = {
    awards,
    refunds: build.refunds,
    payouts: [...payout.entries()].map(([playerId, amount]) => ({ playerId, amount })),
    totalPaid,
  };
  const ledger = settlementLedger(state, hand, settlement);
  const settled = finishSettledHand(
    state,
    { reason: 'LIVE_CONFIRMED', awards, refunds: build.refunds },
    ledger,
  );
  if (proposalId) settled.liveProposalUpdate = { id: proposalId, status: 'SETTLED' };
  return settled;
}

function validateLiveWinners(hand: RuntimeHand, winnersByPot: Record<string, string[]>): void {
  const build = hand.sidePotBuild ?? buildCurrentPots(hand);
  const expected = new Set(build.pots.map((pot) => `pot-${pot.index}`));
  if (Object.keys(winnersByPot).length !== expected.size) {
    throw new RoomRuleError('BAD_REQUEST', '必须为主池和每个边池分别选择赢家');
  }
  for (const pot of build.pots) {
    const id = `pot-${pot.index}`;
    const winners = [...new Set(winnersByPot[id] ?? [])];
    if (
      !expected.has(id) ||
      winners.length === 0 ||
      winners.some((winner) => !pot.eligiblePlayerIds.includes(winner))
    ) {
      throw new RoomRuleError('ILLEGAL_ACTION', `${id} 包含不具备资格的赢家`);
    }
    winnersByPot[id] = winners;
  }
}

function beginHand(state: RuntimeRoomState): MutationExtras {
  const participants = activePlayers(state);
  if (participants.length < 2)
    throw new RoomRuleError('CONFLICT', '至少需要两名在线且已准备的玩家');
  const seats = participants.map((player) => player.seat!);
  const initialTotalChips = participants.reduce((sum, player) => sum + player.stack, 0);
  const buttonSeat =
    state.previousButtonSeat === null
      ? seats[randomInt(seats.length)]!
      : rotateDealerButton(seats, state.previousButtonSeat);
  const positions = getTablePositions(seats, buttonSeat);
  const positionLabels = tablePositions(
    seats,
    positions.buttonSeat,
    positions.smallBlindSeat,
    positions.bigBlindSeat,
  );
  const deck = state.settings.mode === 'ONLINE' ? shuffleDeck() : [];
  let deckCursor = 0;
  const holeCards: Record<string, Card[]> = {};
  if (state.settings.mode === 'ONLINE') {
    const dealOrder = orderedSeatsAfter(seats, buttonSeat);
    for (let round = 0; round < 2; round += 1) {
      for (const seat of dealOrder) {
        const player = participants.find((candidate) => candidate.seat === seat)!;
        (holeCards[player.id] ??= []).push(deck[deckCursor++]!);
      }
    }
  }
  const posted = participants.map((player) => {
    const forced =
      player.seat === positions.smallBlindSeat
        ? state.settings.smallBlind
        : player.seat === positions.bigBlindSeat
          ? state.settings.bigBlind
          : 0;
    const amount = Math.min(player.stack, forced);
    return {
      player,
      amount,
      stack: player.stack - amount,
      committedStreet: amount,
    };
  });
  for (const entry of posted) entry.player.stack = entry.stack;
  const preflopOrder = orderedSeatsAfter(seats, positions.bigBlindSeat);
  const firstActionableSeat = preflopOrder.find((seat) => {
    const entry = posted.find((candidate) => candidate.player.seat === seat);
    return entry !== undefined && entry.stack > 0;
  });
  const firstActor =
    posted.find((entry) => entry.player.seat === firstActionableSeat)?.player.id ??
    posted[0]!.player.id;
  const betting = createBettingRound({
    players: posted.map((entry) => ({
      playerId: entry.player.id,
      seat: entry.player.seat!,
      stack: entry.stack,
      committedStreet: entry.committedStreet,
      committedHand: entry.committedStreet,
    })),
    firstActorId: firstActor,
    minimumBet: state.settings.bigBlind,
    lastFullRaiseSize: state.settings.bigBlind,
  });
  state.handNumber += 1;
  const hand: RuntimeHand = {
    id: randomUUID(),
    number: state.handNumber,
    phase: 'PREFLOP',
    buttonSeat: positions.buttonSeat,
    smallBlindSeat: positions.smallBlindSeat,
    bigBlindSeat: positions.bigBlindSeat,
    participantIds: participants.map((player) => player.id),
    deck,
    deckCursor,
    holeCards,
    communityCards: [],
    betting,
    raiseDepth: 0,
    turnToken: betting.complete ? null : randomToken(18),
    actionDeadlineAt: betting.complete ? null : nextActionDeadline(state),
    pendingLiveStreet: null,
    sidePotBuild: null,
    liveProposal: null,
    liveHadObjection: false,
    revealedPlayerIds: [],
    result: null,
    initialTotalChips,
  };
  state.hand = hand;
  state.status = 'ACTIVE';
  state.nextHandAt = null;
  state.message = `第 ${hand.number} 手开始`;
  const ledgerMutations: NonNullable<RoomCommit['ledgerMutations']> = posted
    .filter((entry) => entry.amount > 0)
    .map((entry) => ({
      playerId: entry.player.id,
      kind: entry.player.seat === positions.smallBlindSeat ? 'SMALL_BLIND' : 'BIG_BLIND',
      delta: -entry.amount,
      balanceAfter: entry.stack,
      metadata: { handId: hand.id },
    }));
  let extras: MutationExtras = {
    eventType: 'HAND_STARTED',
    publicPayload: {
      handNumber: hand.number,
      buttonSeat: hand.buttonSeat,
      smallBlindSeat: hand.smallBlindSeat,
      bigBlindSeat: hand.bigBlindSeat,
      participants: participants.map((player) => ({
        playerId: player.id,
        nickname: player.nickname,
        seat: player.seat,
        positions: positionLabels.get(player.seat!) ?? [],
      })),
      forcedBets: posted
        .filter((entry) => entry.amount > 0)
        .map((entry) => ({
          playerId: entry.player.id,
          nickname: entry.player.nickname,
          seat: entry.player.seat,
          positions: positionLabels.get(entry.player.seat!) ?? [],
          action: entry.player.seat === positions.smallBlindSeat ? 'SMALL_BLIND' : 'BIG_BLIND',
          amount: entry.amount,
          committedStreet: entry.committedStreet,
          stackAfter: entry.stack,
        })),
    },
    ledgerMutations,
    handStart: {
      id: hand.id,
      handNumber: hand.number,
      mode: state.settings.mode,
      phase: 'PREFLOP',
      buttonSeat: hand.buttonSeat,
      initialTotalChips: hand.initialTotalChips,
    },
  };
  if (betting.complete) extras = advanceCompletedRound(state, extras);
  return extras;
}

function mergeExtras(base: MutationExtras, next: MutationExtras): MutationExtras {
  const existing = Array.isArray(base.publicPayload?.precedingEvents)
    ? base.publicPayload.precedingEvents
    : [];
  return {
    ...next,
    publicPayload: {
      ...(next.publicPayload ?? {}),
      precedingEvents: [
        ...existing,
        {
          type: base.eventType,
          payload: base.publicPayload ?? {},
        },
      ],
    },
    ledgerMutations: [...(base.ledgerMutations ?? []), ...(next.ledgerMutations ?? [])],
    handStart: base.handStart ?? next.handStart,
  };
}

function advanceCompletedRound(state: RuntimeRoomState, base?: MutationExtras): MutationExtras {
  const hand = state.hand!;
  const contenders = hand.betting.players.filter((player) => !player.folded);
  if (contenders.length === 1) {
    const settled = settleUncontested(state);
    return base ? mergeExtras(base, settled) : settled;
  }
  if (state.settings.mode === 'LIVE') {
    if (hand.phase === 'RIVER') {
      hand.phase = 'SHOWDOWN';
      hand.sidePotBuild = buildCurrentPots(hand);
      hand.turnToken = null;
      hand.actionDeadlineAt = null;
      state.message = '请发牌确认人提交各底池赢家';
      const extras: MutationExtras = {
        eventType: 'LIVE_SHOWDOWN_READY',
        handUpdate: { id: hand.id, phase: 'SHOWDOWN' },
      };
      return base ? mergeExtras(base, extras) : extras;
    }
    hand.pendingLiveStreet =
      hand.phase === 'PREFLOP' ? 'FLOP' : hand.phase === 'FLOP' ? 'TURN' : 'RIVER';
    hand.turnToken = null;
    hand.actionDeadlineAt = null;
    state.message = `等待发牌确认人确认已发${hand.pendingLiveStreet}`;
    const extras: MutationExtras = {
      eventType: 'LIVE_STREET_AWAITING_DEAL',
      publicPayload: { street: hand.pendingLiveStreet },
    };
    return base ? mergeExtras(base, extras) : extras;
  }

  while (hand.phase !== 'RIVER') {
    const street = hand.phase === 'PREFLOP' ? 'FLOP' : hand.phase === 'FLOP' ? 'TURN' : 'RIVER';
    drawStreet(hand, street);
    resetBettingForStreet(state, hand);
    if (!hand.betting.complete) {
      hand.turnToken = randomToken(18);
      hand.actionDeadlineAt = nextActionDeadline(state);
      state.message = `${street} 下注轮`;
      const extras: MutationExtras = {
        eventType: 'STREET_DEALT',
        publicPayload: { street, communityCards: hand.communityCards },
        handUpdate: { id: hand.id, phase: street },
      };
      return base ? mergeExtras(base, extras) : extras;
    }
  }
  const settled = settleOnlineShowdown(state);
  return base ? mergeExtras(base, settled) : settled;
}

function successfulResult(state: RuntimeRoomState, playerId: string): CommandSuccess {
  const projections = buildProjections(state);
  return {
    ok: true,
    serverSeq: state.serverSeq,
    data: {
      public: projections.public,
      private: projections.privateByPlayerId[playerId] ?? null,
    },
  };
}

export class RoomActor {
  private chain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private unhealthy = false;

  public state: RuntimeRoomState;

  public constructor(
    loaded: LoadedRoom,
    private readonly repository: PokerRepository,
    private readonly onProjection: ProjectionListener,
  ) {
    this.state = asRuntimeState(loaded);
    this.reschedule();
  }

  public snapshot(playerId: string): RoomSnapshotEnvelope {
    if (this.unhealthy) throw new Error('ROOM_ACTOR_UNHEALTHY');
    const projections = buildProjections(this.state);
    return {
      public: projections.public,
      private: projections.privateByPlayerId[playerId] ?? null,
    };
  }

  public adminSnapshot(): PublicRoomProjection {
    if (this.unhealthy) throw new Error('ROOM_ACTOR_UNHEALTHY');
    return buildProjections(this.state).public;
  }

  public hasPlayer(playerId: string): boolean {
    return this.state.players.some(
      (player) => player.id === playerId && player.membershipStatus !== 'KICKED',
    );
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const guarded = async () => {
      const previous = structuredClone(this.state);
      try {
        return await work();
      } catch (error) {
        await this.recoverState(previous);
        throw error;
      }
    };
    const result = this.chain.then(guarded, guarded);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async recoverState(previous: RuntimeRoomState): Promise<boolean> {
    const connectedPlayerIds = new Set(
      previous.players.filter((player) => player.connected).map((player) => player.id),
    );
    try {
      const loaded = await this.repository.loadRoom(previous.roomId);
      if (!loaded) throw new Error('ROOM_NOT_FOUND_DURING_RECOVERY');
      const recovered = asRuntimeState(loaded);
      for (const player of recovered.players) {
        if (connectedPlayerIds.has(player.id)) player.connected = true;
      }
      this.state = recovered;
      this.unhealthy = false;
      const projections = buildProjections(this.state);
      try {
        this.onProjection(this.state.roomId, projections);
      } catch {
        // A failed broadcast must never roll back persisted state.
      }
      this.reschedule();
      return true;
    } catch {
      this.state = previous;
      this.unhealthy = true;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      return false;
    }
  }

  private async commit(
    extras: MutationExtras,
    actorPlayerId?: string,
    command?: RoomCommit['command'],
  ): Promise<void> {
    this.state.serverSeq += 1;
    this.state.updatedAt = nowIso();
    const projections = buildProjections(this.state);
    if (command) command.result = successfulResult(this.state, command.playerId);
    await this.repository.commitRoom({
      roomId: this.state.roomId,
      seq: this.state.serverSeq,
      status: this.state.status,
      handNumber: this.state.handNumber,
      publicSnapshot: projections.public,
      privateState: this.state,
      event: {
        type: extras.eventType,
        ...(actorPlayerId ? { actorPlayerId } : {}),
        ...(this.state.hand && HAND_SCOPED_EVENTS.has(extras.eventType)
          ? { handId: this.state.hand.id }
          : {}),
        ...(extras.publicPayload ? { publicPayload: extras.publicPayload } : {}),
      },
      playerMutations: playerMutations(this.state),
      ...(extras.ledgerMutations ? { ledgerMutations: extras.ledgerMutations } : {}),
      ...(extras.handStart ? { handStart: extras.handStart } : {}),
      ...(extras.handUpdate ? { handUpdate: extras.handUpdate } : {}),
      ...(command ? { command } : {}),
      ...(extras.liveProposal ? { liveProposal: extras.liveProposal } : {}),
      ...(extras.liveConfirmation ? { liveConfirmation: extras.liveConfirmation } : {}),
      ...(extras.liveProposalUpdate ? { liveProposalUpdate: extras.liveProposalUpdate } : {}),
      ...(extras.audit ? { audit: extras.audit } : {}),
    });
    try {
      this.onProjection(this.state.roomId, projections);
    } catch {
      // Socket delivery is a post-commit optimization; reconnect sends a snapshot.
    }
    try {
      this.reschedule();
    } catch {
      // Persisted state remains authoritative even if scheduling must be retried on restart.
    }
  }

  private failure(code: CommandFailure['code'], message: string): CommandFailure {
    return { ok: false, code, message, serverSeq: this.state.serverSeq };
  }

  private async command<T extends CommandEnvelopeLike>(
    playerId: string,
    envelope: T,
    mutate: () => MutationExtras,
  ): Promise<CommandResult> {
    return this.enqueue(async () => {
      if (this.unhealthy) return this.failure('INTERNAL_ERROR', '牌局恢复失败，已冻结操作');
      if (!this.hasPlayer(playerId)) return this.failure('FORBIDDEN', '玩家不属于该房间');
      const membership = this.state.players.find((player) => player.id === playerId)!;
      if (
        membership.membershipStatus === 'KICK_PENDING' &&
        !(
          this.state.status === 'ACTIVE' &&
          this.state.hand?.participantIds.includes(playerId) === true
        )
      ) {
        return this.failure('FORBIDDEN', '你已被移出牌桌');
      }
      const requestHash = commandRequestHash(playerId, envelope);
      const duplicate = await this.repository.getCommandResult(
        this.state.roomId,
        envelope.commandId,
        playerId,
        requestHash,
      );
      if (duplicate?.kind === 'match') return duplicate.result;
      if (duplicate?.kind === 'conflict') {
        return this.failure('CONFLICT', 'commandId 已被其他玩家或不同请求使用');
      }
      let failure: CommandFailure | null = null;
      if (this.state.status === 'ARCHIVED') failure = this.failure('ROOM_ARCHIVED', '房间已归档');
      else if (this.state.status === 'DISPUTED')
        failure = this.failure('CONFLICT', '争议牌局已冻结，只能由管理员退款中止');
      else if (envelope.expectedSeq !== this.state.serverSeq) {
        failure = this.failure('STALE_SEQUENCE', '牌桌状态已更新，请同步后重试');
      }
      if (failure) {
        await this.repository.persistRejectedCommand(
          this.state.roomId,
          envelope.commandId,
          playerId,
          requestHash,
          this.state.serverSeq,
          failure,
        );
        return failure;
      }
      const previous = structuredClone(this.state);
      let extras: MutationExtras;
      try {
        extras = mutate();
      } catch (error) {
        this.state = previous;
        this.reschedule();
        const result =
          error instanceof RoomRuleError
            ? this.failure(error.code, error.message)
            : error instanceof BettingRuleError
              ? this.failure('ILLEGAL_ACTION', error.message)
              : this.failure('INTERNAL_ERROR', '处理命令失败');
        await this.repository.persistRejectedCommand(
          this.state.roomId,
          envelope.commandId,
          playerId,
          requestHash,
          this.state.serverSeq,
          result,
        );
        return result;
      }
      const commandRecord: NonNullable<RoomCommit['command']> = {
        commandId: envelope.commandId,
        playerId,
        requestHash,
        result: this.failure('INTERNAL_ERROR', '命令尚未完成'),
      };
      try {
        await this.commit(extras, playerId, commandRecord);
        return commandRecord.result;
      } catch (error) {
        try {
          const persisted = await this.repository.getCommandResult(
            this.state.roomId,
            envelope.commandId,
            playerId,
            requestHash,
          );
          if (persisted?.kind === 'match') {
            this.unhealthy = false;
            const projections = buildProjections(this.state);
            try {
              this.onProjection(this.state.roomId, projections);
            } catch {
              // Reconnect will receive the authoritative snapshot.
            }
            this.reschedule();
            return persisted.result;
          }
        } catch {
          // Continue to full snapshot recovery below.
        }
        const recovered = await this.recoverState(previous);
        if (recovered) {
          const persisted = await this.repository.getCommandResult(
            this.state.roomId,
            envelope.commandId,
            playerId,
            requestHash,
          );
          if (persisted?.kind === 'match') return persisted.result;
          if (error instanceof Error && error.message === 'ROOM_SEQUENCE_FENCE_CONFLICT') {
            return this.failure('STALE_SEQUENCE', '牌桌已由更新状态接管，请同步后重试');
          }
        }
        return this.failure('INTERNAL_ERROR', '提交结果不确定，牌局已冻结以保护筹码');
      }
    });
  }

  public async refreshPlayers(loaded: LoadedRoom): Promise<void> {
    return this.enqueue(async () => {
      const existing = new Map(this.state.players.map((player) => [player.id, player]));
      let changed = false;
      for (const row of loaded.players) {
        const current = existing.get(row.id);
        if (current) {
          const kickedAt = row.kickedAt?.toISOString() ?? null;
          if (
            current.membershipStatus !== row.membershipStatus ||
            current.kickedAt !== kickedAt ||
            current.kickedByAdminId !== row.kickedByAdminId ||
            current.kickReason !== row.kickReason
          ) {
            current.membershipStatus = row.membershipStatus;
            current.kickedAt = kickedAt;
            current.kickedByAdminId = row.kickedByAdminId;
            current.kickReason = row.kickReason;
            changed = true;
          }
          continue;
        }
        changed = true;
        this.state.players.push({
          id: row.id,
          nickname: row.nickname,
          seat: row.seat,
          stack: row.stack,
          ready: row.ready,
          connected: false,
          sittingOut: row.sittingOut,
          membershipStatus: row.membershipStatus,
          kickedAt: row.kickedAt?.toISOString() ?? null,
          kickedByAdminId: row.kickedByAdminId,
          kickReason: row.kickReason,
        });
      }
      if (changed) {
        resetReadyConfirmations(this.state);
        this.state.message = '新玩家已加入，所有玩家需要重新确认';
        await this.commit({ eventType: 'PLAYER_JOINED' });
      }
    });
  }

  public async setConnected(playerId: string, connected: boolean): Promise<void> {
    return this.enqueue(async () => {
      const player = this.state.players.find((candidate) => candidate.id === playerId);
      if (!player || player.connected === connected || this.state.status === 'ARCHIVED') return;
      player.connected = connected;
      if (this.state.status !== 'ACTIVE') {
        resetReadyConfirmations(this.state);
        this.state.message = '在线阵容发生变化，请所有在座玩家重新确认下一手';
      } else if (!connected) {
        player.ready = false;
      }
      await this.commit(
        {
          eventType: connected ? 'PLAYER_CONNECTED' : 'PLAYER_DISCONNECTED',
          publicPayload: { playerId },
        },
        playerId,
      );
    });
  }

  public seatClaim(playerId: string, command: SeatClaimCommand): Promise<CommandResult> {
    return this.command(playerId, command, () => {
      const player = this.state.players.find((candidate) => candidate.id === playerId)!;
      if (
        this.state.players.some(
          (candidate) => candidate.id !== playerId && candidate.seat === command.payload.seat,
        )
      ) {
        throw new RoomRuleError('CONFLICT', '该座位已被占用');
      }
      if (this.state.hand?.participantIds.includes(playerId) && this.state.status === 'ACTIVE') {
        throw new RoomRuleError('CONFLICT', '当前手牌结束前不能换座');
      }
      player.seat = command.payload.seat;
      resetReadyConfirmations(this.state);
      return { eventType: 'SEAT_CLAIMED', publicPayload: { playerId, seat: command.payload.seat } };
    });
  }

  public ready(playerId: string, command: EmptyCommand): Promise<CommandResult> {
    return this.command(playerId, command, () => {
      const player = this.state.players.find((candidate) => candidate.id === playerId)!;
      if (player.seat === null) throw new RoomRuleError('CONFLICT', '请先选择座位');
      if (player.stack <= 0) throw new RoomRuleError('CONFLICT', '筹码为零，请先在两手之间补充');
      if (!player.connected) throw new RoomRuleError('CONFLICT', '离线玩家不能确认下一手');
      if (this.state.status !== 'LOBBY' && this.state.status !== 'BETWEEN_HANDS')
        throw new RoomRuleError('CONFLICT', '只能在两手之间确认下一手');
      if (player.sittingOut) resetReadyConfirmations(this.state);
      player.ready = true;
      player.sittingOut = false;
      if (everyoneReady(this.state)) return beginHand(this.state);
      const eligible = eligiblePlayers(this.state);
      const readyCount = eligible.filter((candidate) => candidate.ready).length;
      this.state.message = `下一手确认 ${readyCount}/${eligible.length}`;
      return {
        eventType: 'PLAYER_READY',
        publicPayload: { playerId, readyCount, requiredReadyCount: eligible.length },
      };
    });
  }

  public sitOut(playerId: string, command: EmptyCommand): Promise<CommandResult> {
    return this.command(playerId, command, () => {
      const player = this.state.players.find((candidate) => candidate.id === playerId)!;
      resetReadyConfirmations(this.state);
      player.sittingOut = true;
      this.state.message = '阵容发生变化，请其余玩家重新确认下一手';
      return {
        eventType: 'PLAYER_SITTING_OUT',
        publicPayload: { playerId, confirmationsReset: true },
      };
    });
  }

  public topUp(playerId: string, command: TopUpCommand): Promise<CommandResult> {
    return this.command(playerId, command, () => {
      if (this.state.status === 'ACTIVE' || this.state.status === 'DISPUTED') {
        throw new RoomRuleError('CONFLICT', '只能在两手之间补充筹码');
      }
      const player = this.state.players.find((candidate) => candidate.id === playerId)!;
      if (player.stack >= this.state.settings.stackCap) {
        throw new RoomRuleError('CONFLICT', '当前筹码已达到或高于房间上限');
      }
      if (command.payload.targetStack !== this.state.settings.stackCap) {
        throw new RoomRuleError('BAD_REQUEST', '补充操作必须补至房间上限');
      }
      const before = player.stack;
      player.stack = this.state.settings.stackCap;
      resetReadyConfirmations(this.state);
      this.state.message = '筹码发生变化，请所有玩家重新确认下一手';
      return {
        eventType: 'STACK_TOPPED_UP',
        publicPayload: { playerId, targetStack: player.stack, confirmationsReset: true },
        ledgerMutations: [
          {
            playerId,
            kind: 'TOP_UP',
            delta: player.stack - before,
            balanceAfter: player.stack,
          },
        ],
      };
    });
  }

  public act(playerId: string, command: HandActionCommand): Promise<CommandResult> {
    return this.command(playerId, command, () => {
      const hand = this.state.hand;
      if (!hand || this.state.status !== 'ACTIVE')
        throw new RoomRuleError('CONFLICT', '当前没有进行中的手牌');
      if (hand.turnToken !== command.turnToken)
        throw new RoomRuleError('STALE_TURN', '行动令牌已失效');
      if (hand.betting.actorId !== playerId)
        throw new RoomRuleError('ILLEGAL_ACTION', '尚未轮到你行动');
      const before = handPlayer(hand, playerId);
      const beforeBetting = hand.betting;
      const legalBefore = getLegalActions(beforeBetting);
      hand.betting = applyBettingAction(hand.betting, playerId, actionFromInput(command.payload));
      const after = handPlayer(hand, playerId);
      const actingPlayer = this.state.players.find((player) => player.id === playerId)!;
      const handSeats = hand.participantIds
        .map((id) => this.state.players.find((player) => player.id === id)?.seat)
        .filter((seat): seat is number => seat !== null && seat !== undefined);
      const actingPositions = tablePositions(
        handSeats,
        hand.buttonSeat,
        hand.smallBlindSeat,
        hand.bigBlindSeat,
      ).get(actingPlayer.seat ?? -1);
      const raisedBetLevel = hand.betting.currentBet > beforeBetting.currentBet;
      const minimumFullTo = legalBefore.betTo?.minimumTo ?? legalBefore.raiseTo?.minimumTo ?? null;
      const fullRaise =
        raisedBetLevel &&
        minimumFullTo !== null &&
        hand.betting.currentBet >= minimumFullTo &&
        (command.payload.action === 'BET_TO' ||
          command.payload.action === 'RAISE_TO' ||
          command.payload.action === 'ALL_IN');
      if (fullRaise) hand.raiseDepth += 1;
      this.state.players.find((player) => player.id === playerId)!.stack = after.stack;
      const delta = after.stack - before.stack;
      hand.turnToken = hand.betting.complete ? null : randomToken(18);
      hand.actionDeadlineAt = hand.betting.complete ? null : nextActionDeadline(this.state);
      this.state.message = `${actingPlayer.nickname} ${actionLabel(command.payload.action)}`;
      let extras: MutationExtras = {
        eventType: 'PLAYER_ACTED',
        publicPayload: {
          playerId,
          nickname: actingPlayer.nickname,
          positions: actingPositions ?? [],
          action: command.payload.action,
          street: hand.phase,
          amount: -delta,
          committedStreet: after.committedStreet,
          committedHand: after.committedHand,
          stackAfter: after.stack,
          currentBetBefore: beforeBetting.currentBet,
          currentBetAfter: hand.betting.currentBet,
          ...(command.payload.amountTo === undefined ? {} : { amountTo: command.payload.amountTo }),
        },
        ...(delta === 0
          ? {}
          : {
              ledgerMutations: [
                {
                  playerId,
                  kind: 'WAGER',
                  delta,
                  balanceAfter: after.stack,
                  metadata: { action: command.payload.action },
                },
              ],
            }),
      };
      if (hand.betting.complete) extras = advanceCompletedRound(this.state, extras);
      else extras.handUpdate = { id: hand.id, phase: hand.phase };
      return extras;
    });
  }

  public liveStreetDealt(
    playerId: string,
    command: LiveStreetDealtCommand,
  ): Promise<CommandResult> {
    return this.command(playerId, command, () => {
      const hand = this.state.hand;
      if (!hand || this.state.settings.mode !== 'LIVE' || this.state.status !== 'ACTIVE') {
        throw new RoomRuleError('CONFLICT', '当前不是可确认发牌的 LIVE 手牌');
      }
      if (currentLiveDealerPlayerId(this.state) !== playerId) {
        throw new RoomRuleError('FORBIDDEN', '只有当前发牌确认人可以确认街牌');
      }
      if (hand.pendingLiveStreet !== command.payload.street) {
        throw new RoomRuleError('CONFLICT', '确认的街与当前等待状态不一致');
      }
      const street = command.payload.street;
      hand.pendingLiveStreet = null;
      hand.phase = street;
      resetBettingForStreet(this.state, hand);
      hand.turnToken = hand.betting.complete ? null : randomToken(18);
      hand.actionDeadlineAt = hand.betting.complete ? null : nextActionDeadline(this.state);
      this.state.message = `${street} 已发牌`;
      let extras: MutationExtras = {
        eventType: 'LIVE_STREET_DEALT',
        publicPayload: { street },
        handUpdate: { id: hand.id, phase: street },
      };
      if (hand.betting.complete) extras = advanceCompletedRound(this.state, extras);
      return extras;
    });
  }

  public liveResultPropose(
    playerId: string,
    command: LiveResultProposeCommand,
  ): Promise<CommandResult> {
    return this.command(playerId, command, () => {
      const hand = this.state.hand;
      if (!hand || this.state.settings.mode !== 'LIVE' || hand.phase !== 'SHOWDOWN') {
        throw new RoomRuleError('CONFLICT', '当前不在 LIVE 摊牌结果提交阶段');
      }
      if (this.state.status !== 'ACTIVE') {
        throw new RoomRuleError('CONFLICT', '当前房间不允许提交结果');
      }
      if (currentLiveDealerPlayerId(this.state) !== playerId) {
        throw new RoomRuleError('FORBIDDEN', '只有当前发牌确认人可以提交结果');
      }
      if (
        hand.liveProposal &&
        !hand.liveProposal.superseded &&
        hand.liveProposal.objectedByPlayerIds.length === 0
      ) {
        throw new RoomRuleError('CONFLICT', '已有待确认结果');
      }
      const winnersByPot = structuredClone(command.payload.winnersByPot);
      validateLiveWinners(hand, winnersByPot);
      const previousProposalId = hand.liveProposal?.id;
      if (hand.liveProposal) hand.liveProposal.superseded = true;
      const proposedAt = new Date();
      const preservedDisputeAt = hand.liveProposal?.disputeAt;
      const proposal: RuntimeLiveProposal = {
        id: randomUUID(),
        proposerPlayerId: playerId,
        winnersByPot,
        objectedByPlayerIds: [],
        confirmedByPlayerIds: hand.liveHadObjection ? [playerId] : [],
        proposedAt: proposedAt.toISOString(),
        autoSettleAt: new Date(proposedAt.getTime() + 10_000).toISOString(),
        disputeAt: preservedDisputeAt ?? new Date(proposedAt.getTime() + 120_000).toISOString(),
        superseded: false,
      };
      hand.liveProposal = proposal;
      this.state.message = hand.liveHadObjection
        ? '新结果已提交，等待所有有资格玩家确认'
        : '结果已提交，10 秒无异议后自动结算';
      return {
        eventType: 'LIVE_RESULT_PROPOSED',
        publicPayload: { proposalId: proposal.id, winnersByPot },
        liveProposal: {
          id: proposal.id,
          handId: hand.id,
          proposerPlayerId: playerId,
          winnersByPot,
          status: 'PENDING',
          settleAt: new Date(proposal.autoSettleAt),
          disputeAt: new Date(proposal.disputeAt),
        },
        ...(previousProposalId
          ? { liveProposalUpdate: { id: previousProposalId, status: 'SUPERSEDED' as const } }
          : {}),
      };
    });
  }

  public liveResultObject(
    playerId: string,
    command: LiveResultProposalIdCommand,
  ): Promise<CommandResult> {
    return this.command(playerId, command, () => {
      const hand = this.state.hand;
      const proposal = hand?.liveProposal;
      if (!hand || !proposal || proposal.id !== command.payload.proposalId || proposal.superseded) {
        throw new RoomRuleError('NOT_FOUND', '待确认结果不存在');
      }
      if (this.state.status !== 'ACTIVE') {
        throw new RoomRuleError('CONFLICT', '当前房间不允许处理结果异议');
      }
      const eligible = new Set(
        (hand.sidePotBuild ?? buildCurrentPots(hand)).pots.flatMap((pot) => pot.eligiblePlayerIds),
      );
      if (!eligible.has(playerId))
        throw new RoomRuleError('FORBIDDEN', '只有底池有资格玩家可以提出异议');
      if (!proposal.objectedByPlayerIds.includes(playerId))
        proposal.objectedByPlayerIds.push(playerId);
      hand.liveHadObjection = true;
      this.state.message = '结果有异议，请发牌确认人提交新方案';
      return {
        eventType: 'LIVE_RESULT_OBJECTED',
        publicPayload: { proposalId: proposal.id, playerId },
        liveConfirmation: { proposalId: proposal.id, playerId, kind: 'OBJECT' },
        liveProposalUpdate: { id: proposal.id, status: 'OBJECTED' },
      };
    });
  }

  public liveResultConfirm(
    playerId: string,
    command: LiveResultProposalIdCommand,
  ): Promise<CommandResult> {
    return this.command(playerId, command, () => {
      const hand = this.state.hand;
      const proposal = hand?.liveProposal;
      if (!hand || !proposal || proposal.id !== command.payload.proposalId || proposal.superseded) {
        throw new RoomRuleError('NOT_FOUND', '待确认结果不存在');
      }
      if (this.state.status !== 'ACTIVE') {
        throw new RoomRuleError('CONFLICT', '当前房间不允许确认结果');
      }
      if (!hand.liveHadObjection) throw new RoomRuleError('CONFLICT', '无异议方案无需逐人确认');
      const eligible = new Set(
        (hand.sidePotBuild ?? buildCurrentPots(hand)).pots.flatMap((pot) => pot.eligiblePlayerIds),
      );
      if (!eligible.has(playerId))
        throw new RoomRuleError('FORBIDDEN', '你不是任何底池的有资格玩家');
      if (!proposal.confirmedByPlayerIds.includes(playerId))
        proposal.confirmedByPlayerIds.push(playerId);
      const allConfirmed = [...eligible].every((id) => proposal.confirmedByPlayerIds.includes(id));
      const confirmation = { proposalId: proposal.id, playerId, kind: 'CONFIRM' as const };
      if (allConfirmed) {
        const settled = manualLiveSettlement(this.state, proposal.winnersByPot);
        settled.liveConfirmation = confirmation;
        return settled;
      }
      this.state.message = `已确认 ${proposal.confirmedByPlayerIds.length}/${eligible.size}`;
      return {
        eventType: 'LIVE_RESULT_CONFIRMED',
        publicPayload: { proposalId: proposal.id, playerId },
        liveConfirmation: confirmation,
      };
    });
  }

  public async adminAdjustStack(
    adminId: string,
    playerId: string,
    targetStack: number,
    reason: string,
    operationId: string,
  ): Promise<AdminPlayerOperationResult> {
    return this.enqueue(async () => {
      if (!Number.isSafeInteger(targetStack) || targetStack < 0 || targetStack > 1_000_000_000) {
        return { ok: false, code: 'CONFLICT', message: '目标筹码不合法' };
      }
      if (this.state.status === 'ACTIVE' || this.state.status === 'DISPUTED') {
        return { ok: false, code: 'CONFLICT', message: '只能在两手之间调整筹码' };
      }
      if (this.state.status === 'ARCHIVED') {
        return { ok: false, code: 'CONFLICT', message: '已归档房间不能调整筹码' };
      }
      const player = this.state.players.find((candidate) => candidate.id === playerId);
      if (!player || player.membershipStatus !== 'ACTIVE') {
        return { ok: false, code: 'NOT_FOUND', message: '有效玩家不存在' };
      }
      const before = player.stack;
      if (before === targetStack) {
        return {
          ok: true,
          playerId,
          membershipStatus: player.membershipStatus,
          stack: player.stack,
        };
      }
      player.stack = targetStack;
      resetReadyConfirmations(this.state);
      this.state.message = `${player.nickname} 的筹码已由管理员调整，所有玩家需重新确认`;
      await this.commit({
        eventType: 'ADMIN_STACK_ADJUSTED',
        publicPayload: {
          playerId,
          beforeStack: before,
          targetStack,
          delta: targetStack - before,
          confirmationsReset: true,
        },
        ledgerMutations: [
          {
            playerId,
            kind: 'ADMIN_ADJUSTMENT',
            delta: targetStack - before,
            balanceAfter: targetStack,
            metadata: { operationId, reason },
          },
        ],
        audit: {
          adminId,
          action: 'PLAYER_STACK_ADJUSTED',
          metadata: { operationId, playerId, beforeStack: before, targetStack, reason },
        },
      });
      return {
        ok: true,
        playerId,
        membershipStatus: player.membershipStatus,
        stack: player.stack,
      };
    });
  }

  public async adminKickPlayer(
    adminId: string,
    playerId: string,
    reason: string,
    operationId: string,
  ): Promise<AdminPlayerOperationResult> {
    return this.enqueue(async () => {
      if (this.state.status === 'ARCHIVED') {
        return { ok: false, code: 'CONFLICT', message: '已归档房间不能移出玩家' };
      }
      const player = this.state.players.find((candidate) => candidate.id === playerId);
      if (!player) return { ok: false, code: 'NOT_FOUND', message: '玩家不存在' };
      if (player.membershipStatus === 'KICKED') {
        return {
          ok: true,
          playerId,
          membershipStatus: player.membershipStatus,
          stack: player.stack,
        };
      }
      if (player.membershipStatus === 'KICK_PENDING') {
        return {
          ok: true,
          playerId,
          membershipStatus: player.membershipStatus,
          stack: player.stack,
          pending: true,
        };
      }
      const pending =
        this.state.status === 'ACTIVE' &&
        this.state.hand?.participantIds.includes(playerId) === true &&
        this.state.hand.phase !== 'SETTLED';
      player.membershipStatus = pending ? 'KICK_PENDING' : 'KICKED';
      player.kickedByAdminId = adminId;
      player.kickReason = reason;
      player.ready = false;
      if (!pending) {
        player.kickedAt = nowIso();
        player.seat = null;
        player.sittingOut = true;
        player.connected = false;
        resetReadyConfirmations(this.state);
      }
      this.state.message = pending
        ? `${player.nickname} 将在本手结算后离开牌桌`
        : `${player.nickname} 已被管理员移出牌桌，请重新确认下一手`;
      await this.commit({
        eventType: pending ? 'PLAYER_KICK_SCHEDULED' : 'PLAYER_KICKED',
        publicPayload: { playerId, pending, confirmationsReset: !pending },
        audit: {
          adminId,
          action: pending ? 'PLAYER_KICK_SCHEDULED' : 'PLAYER_KICKED',
          metadata: { operationId, playerId, reason },
        },
      });
      return {
        ok: true,
        playerId,
        membershipStatus: player.membershipStatus,
        stack: player.stack,
        ...(pending ? { pending: true } : {}),
      };
    });
  }

  public async adminReinstatePlayer(
    adminId: string,
    playerId: string,
    operationId: string,
  ): Promise<AdminPlayerOperationResult> {
    return this.enqueue(async () => {
      if (this.state.status === 'ACTIVE' || this.state.status === 'DISPUTED') {
        return { ok: false, code: 'CONFLICT', message: '只能在两手之间恢复玩家' };
      }
      if (this.state.status === 'ARCHIVED') {
        return { ok: false, code: 'CONFLICT', message: '已归档房间不能恢复玩家' };
      }
      const player = this.state.players.find((candidate) => candidate.id === playerId);
      if (!player) return { ok: false, code: 'NOT_FOUND', message: '玩家不存在' };
      if (player.membershipStatus === 'ACTIVE') {
        return {
          ok: true,
          playerId,
          membershipStatus: player.membershipStatus,
          stack: player.stack,
        };
      }
      const activeMembers = this.state.players.filter(
        (candidate) => candidate.membershipStatus !== 'KICKED' && candidate.id !== playerId,
      ).length;
      if (activeMembers >= this.state.settings.maxPlayers) {
        return { ok: false, code: 'CONFLICT', message: '房间有效玩家已满' };
      }
      const nicknameTaken = this.state.players.some(
        (candidate) =>
          candidate.id !== playerId &&
          candidate.membershipStatus !== 'KICKED' &&
          candidate.nickname.toLowerCase() === player.nickname.toLowerCase(),
      );
      if (nicknameTaken) {
        return { ok: false, code: 'CONFLICT', message: '该昵称已被其他有效玩家使用' };
      }
      player.membershipStatus = 'ACTIVE';
      player.kickedAt = null;
      player.kickedByAdminId = null;
      player.kickReason = null;
      player.seat = null;
      player.ready = false;
      player.sittingOut = false;
      player.connected = false;
      resetReadyConfirmations(this.state);
      this.state.message = `${player.nickname} 已恢复为房间成员，请重新选座并确认`;
      await this.commit({
        eventType: 'PLAYER_REINSTATED',
        publicPayload: { playerId, confirmationsReset: true },
        audit: {
          adminId,
          action: 'PLAYER_REINSTATED',
          metadata: { operationId, playerId },
        },
      });
      return {
        ok: true,
        playerId,
        membershipStatus: player.membershipStatus,
        stack: player.stack,
      };
    });
  }

  public async adminArchive(adminId: string): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.state.status === 'ARCHIVED') return true;
      if (this.state.status === 'ACTIVE' || this.state.status === 'DISPUTED') return false;
      this.state.status = 'ARCHIVED';
      this.state.nextHandAt = null;
      this.state.message = '房间已由管理员归档';
      await this.commit({
        eventType: 'ROOM_ARCHIVED',
        audit: {
          ...(adminId.startsWith('SYSTEM_') ? {} : { adminId }),
          action: adminId.startsWith('SYSTEM_') ? 'ROOM_IDLE_ARCHIVED' : 'ROOM_ARCHIVED',
        },
      });
      return true;
    });
  }

  public async adminForceAbort(adminId: string): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.state.status === 'ARCHIVED') return true;
      const hand = this.state.hand;
      const liveProposalId = hand?.liveProposal?.id;
      const ledger: NonNullable<RoomCommit['ledgerMutations']> = [];
      if (hand && hand.phase !== 'SETTLED') {
        for (const bettingPlayer of hand.betting.players) {
          const player = this.state.players.find(
            (candidate) => candidate.id === bettingPlayer.playerId,
          )!;
          const refund = bettingPlayer.committedHand;
          player.stack = bettingPlayer.stack + refund;
          if (refund > 0) {
            ledger.push({
              playerId: player.id,
              kind: 'FORCE_ABORT_REFUND',
              delta: refund,
              balanceAfter: player.stack,
              metadata: { handId: hand.id },
            });
          }
        }
        hand.phase = 'SETTLED';
        hand.result = { reason: 'FORCE_ABORT_REFUND' };
        hand.turnToken = null;
        hand.actionDeadlineAt = null;
        hand.liveProposal = null;
        hand.liveHadObjection = false;
        assertHandChipsConserved(this.state, hand);
      }
      for (const player of this.state.players) {
        player.ready = false;
        if (player.membershipStatus === 'KICK_PENDING') {
          player.membershipStatus = 'KICKED';
          player.kickedAt = nowIso();
          player.seat = null;
          player.sittingOut = true;
          player.connected = false;
        }
      }
      this.state.status = 'ARCHIVED';
      this.state.nextHandAt = null;
      this.state.message = '本手投入已退回，房间已强制中止';
      await this.commit({
        eventType: 'ROOM_FORCE_ABORTED',
        publicPayload: { refunded: true },
        ledgerMutations: ledger,
        ...(hand
          ? { handUpdate: { id: hand.id, phase: 'SETTLED', result: hand.result, ended: true } }
          : {}),
        audit: {
          ...(adminId.startsWith('SYSTEM_') ? {} : { adminId }),
          action: adminId.startsWith('SYSTEM_') ? 'ROOM_IDLE_FORCE_ABORTED' : 'ROOM_FORCE_ABORTED',
          metadata: { refunded: true },
        },
        ...(liveProposalId
          ? { liveProposalUpdate: { id: liveProposalId, status: 'ABORTED' as const } }
          : {}),
      });
      return true;
    });
  }

  private reschedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.unhealthy || this.state.status === 'ARCHIVED' || this.state.status === 'DISPUTED')
      return;
    const hand = this.state.hand;
    const deadlines = [
      hand?.actionDeadlineAt ?? null,
      hand?.liveProposal && !hand.liveProposal.superseded
        ? hand.liveHadObjection
          ? hand.liveProposal.disputeAt
          : hand.liveProposal.autoSettleAt
        : null,
    ].filter((value): value is string => value !== null);
    if (deadlines.length === 0) return;
    const earliest = Math.min(...deadlines.map((deadline) => new Date(deadline).getTime()));
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, earliest - Date.now()));
    this.timer = setTimeout(() => void this.enqueue(() => this.handleTimer()), delay);
    this.timer.unref();
  }

  private async handleTimer(): Promise<void> {
    if (this.state.status === 'ARCHIVED' || this.state.status === 'DISPUTED') {
      this.reschedule();
      return;
    }
    const now = Date.now();
    const hand = this.state.hand;
    if (
      hand?.actionDeadlineAt &&
      new Date(hand.actionDeadlineAt).getTime() <= now &&
      !hand.betting.complete
    ) {
      const actorId = hand.betting.actorId!;
      const actorPlayer = this.state.players.find((player) => player.id === actorId)!;
      const legal = getLegalActions(hand.betting);
      const action: BettingAction = legal.canCheck ? { type: 'CHECK' } : { type: 'FOLD' };
      hand.betting = applyBettingAction(hand.betting, actorId, action);
      hand.turnToken = hand.betting.complete ? null : randomToken(18);
      hand.actionDeadlineAt = hand.betting.complete ? null : nextActionDeadline(this.state);
      let extras: MutationExtras = {
        eventType: 'PLAYER_TIMED_OUT',
        publicPayload: {
          playerId: actorId,
          nickname: actorPlayer.nickname,
          positions:
            tablePositions(
              hand.participantIds
                .map((id) => this.state.players.find((player) => player.id === id)?.seat)
                .filter((seat): seat is number => seat !== null && seat !== undefined),
              hand.buttonSeat,
              hand.smallBlindSeat,
              hand.bigBlindSeat,
            ).get(actorPlayer.seat ?? -1) ?? [],
          action: action.type,
          street: hand.phase,
          amount: 0,
          committedStreet: handPlayer(hand, actorId).committedStreet,
          committedHand: handPlayer(hand, actorId).committedHand,
          stackAfter: handPlayer(hand, actorId).stack,
        },
      };
      if (hand.betting.complete) extras = advanceCompletedRound(this.state, extras);
      await this.commit(extras, actorId);
      return;
    }
    const proposal = hand?.liveProposal;
    if (hand && proposal && !proposal.superseded) {
      if (!hand.liveHadObjection && new Date(proposal.autoSettleAt).getTime() <= now) {
        const eligible = new Set(
          (hand.sidePotBuild ?? buildCurrentPots(hand)).pots.flatMap(
            (pot) => pot.eligiblePlayerIds,
          ),
        );
        const everyoneOnline = [...eligible].every(
          (playerId) =>
            this.state.players.find((player) => player.id === playerId)?.connected === true,
        );
        if (!everyoneOnline) {
          hand.liveHadObjection = true;
          if (
            eligible.has(proposal.proposerPlayerId) &&
            !proposal.confirmedByPlayerIds.includes(proposal.proposerPlayerId)
          ) {
            proposal.confirmedByPlayerIds.push(proposal.proposerPlayerId);
          }
          this.state.message = '有资格玩家离线，结果改为全员确认；120 秒未解决将冻结';
          await this.commit({ eventType: 'LIVE_RESULT_REQUIRES_CONFIRMATION' });
          return;
        }
        await this.commit(manualLiveSettlement(this.state, proposal.winnersByPot));
        return;
      }
      if (hand.liveHadObjection && new Date(proposal.disputeAt).getTime() <= now) {
        this.state.status = 'DISPUTED';
        hand.turnToken = null;
        hand.actionDeadlineAt = null;
        hand.liveProposal = null;
        this.state.message = '争议超过 120 秒，房间已冻结；管理员只能退款中止';
        await this.commit({
          eventType: 'LIVE_RESULT_DISPUTED',
          liveProposalUpdate: { id: proposal.id, status: 'DISPUTED' },
        });
        return;
      }
    }
    this.reschedule();
  }
}
