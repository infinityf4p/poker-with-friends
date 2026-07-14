import type {
  Card,
  HandHistoryItem,
  HandPhase,
  PlayerAction,
  PublicActionPrompt,
  PublicRoomProjection,
  PublicSeat,
  TablePosition,
} from '@poker-with-friends/protocol';

export type { TablePosition } from '@poker-with-friends/protocol';

export type EnhancedSeat = PublicSeat;

export type EnhancedActionPrompt = PublicActionPrompt;

export interface TableActionItem {
  seq: number;
  street: HandPhase | 'LOBBY';
  playerId: string | null;
  nickname: string;
  positions: TablePosition[];
  action: PlayerAction | 'SMALL_BLIND' | 'BIG_BLIND' | 'ANTE' | 'PAYOUT' | 'DEAL';
  amount?: number;
  amountTo?: number;
  stackAfter?: number;
  cards?: Card[];
  createdAt?: string;
  timedOut?: boolean;
}

export interface EnhancedRoomProjection extends PublicRoomProjection {
  recentActions?: TableActionItem[];
}

export interface BetSuggestion {
  label: string;
  detail: string;
  amountTo: number;
  semantic: 'OPEN' | 'THREE_BET' | 'FOUR_BET' | 'POT_FRACTION' | 'MINIMUM';
}

export interface HistoryPayoutItem {
  playerId: string;
  amount: number;
  potIndexes: number[];
}

export interface HistoryRefundItem {
  playerId: string;
  amount: number;
}

export interface HistorySettlementSummary {
  reason: 'UNCONTESTED' | 'SHOWDOWN' | 'LIVE_CONFIRMED' | 'UNKNOWN';
  communityCards: Card[];
  totalPot: number;
  payouts: HistoryPayoutItem[];
  refunds: HistoryRefundItem[];
}

export const phaseLabel: Record<string, string> = {
  POST_BLINDS: '下盲注',
  PREFLOP: '翻牌前',
  FLOP: '翻牌',
  TURN: '转牌',
  RIVER: '河牌',
  SHOWDOWN: '摊牌',
  SETTLED: '已结算',
  LOBBY: '准备中',
};

export const statusLabel: Record<string, string> = {
  LOBBY: '等朋友入座',
  ACTIVE: '牌局进行中',
  BETWEEN_HANDS: '准备下一手',
  DISPUTED: '本手暂停',
  ARCHIVED: '牌桌已结束',
};

export const positionChinese: Record<TablePosition, string> = {
  BTN: '按钮位',
  SB: '小盲',
  BB: '大盲',
  UTG: '枪口位',
  HJ: '劫位',
  CO: '关煞位',
};

export const actionChinese: Record<string, string> = {
  FOLD: '弃牌',
  CHECK: '过牌',
  CALL: '跟注',
  BET_TO: '下注到',
  RAISE_TO: '加注到',
  ALL_IN: '全下',
  SMALL_BLIND: '下小盲',
  BIG_BLIND: '下大盲',
  ANTE: '下前注',
  PAYOUT: '赢得底池',
  DEAL: '发牌',
};

export function cardRankLabel(card: Card): string {
  const rank = card.slice(0, -1);
  return rank === 'T' ? '10' : rank;
}

export function formatPoints(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${trimDecimal(value / 1_000_000)}m`;
  if (Math.abs(value) >= 10_000) return `${trimDecimal(value / 1_000)}k`;
  return value.toLocaleString('zh-CN');
}

function trimDecimal(value: number): string {
  return value.toFixed(value >= 100 ? 0 : 1).replace(/\.0$/, '');
}

function clockwiseAfter(start: number): number[] {
  return Array.from({ length: 5 }, (_, index) => (start + index + 1) % 6);
}

export function positionsForRoom(room: EnhancedRoomProjection): Map<number, TablePosition[]> {
  const fromProtocol = new Map<number, TablePosition[]>();
  for (const seat of room.seats) {
    const positions = seat.positions;
    if (positions.length) fromProtocol.set(seat.seat, positions);
  }
  if (fromProtocol.size) return fromProtocol;

  const participating = room.seats
    .filter((seat) => seat.playerId && (seat.hasCards || room.status !== 'ACTIVE'))
    .map((seat) => seat.seat);
  if (!participating.length || room.buttonSeat === null) return new Map();

  const result = new Map<number, TablePosition[]>();
  const button = room.buttonSeat;
  result.set(button, ['BTN']);
  if (room.smallBlindSeat !== null) {
    result.set(room.smallBlindSeat, room.smallBlindSeat === button ? ['BTN', 'SB'] : ['SB']);
  }
  if (room.bigBlindSeat !== null) result.set(room.bigBlindSeat, ['BB']);

  if (room.bigBlindSeat !== null) {
    const earlySeats = clockwiseAfter(room.bigBlindSeat).filter(
      (seat) => participating.includes(seat) && !result.has(seat),
    );
    const earlyLabels: TablePosition[][] =
      earlySeats.length >= 3
        ? [['UTG'], ['HJ'], ['CO']]
        : earlySeats.length === 2
          ? [['UTG'], ['CO']]
          : earlySeats.length === 1
            ? [['UTG', 'CO']]
            : [];
    earlySeats.forEach((seat, index) => result.set(seat, earlyLabels[index] ?? ['CO']));
  }
  return result;
}

export function positionLabel(positions: TablePosition[]): string {
  if (!positions.length) return '—';
  return positions.map((position) => `${position} ${positionChinese[position]}`).join(' / ');
}

export function actingCopy(room: EnhancedRoomProjection, seconds: number): string {
  if (room.actingSeat === null)
    return room.nextHandAt ? `${seconds} 秒后开始下一手` : '等大家准备好，再开下一手';
  const seat = room.seats[room.actingSeat];
  if (!seat?.playerId) return '等待下一位玩家';
  const positions = positionsForRoom(room).get(seat.seat) ?? [];
  const position = positions.length ? positionLabel(positions) : `座位 ${seat.seat + 1}`;
  return `轮到 ${position} · ${seat.nickname ?? '玩家'} · ${seconds} 秒`;
}

const legacyRoomMessages = new Map([
  ['在线阵容发生变化，请所有在座玩家重新确认下一手', '桌上有人进出，大家重新点一下准备'],
  ['阵容发生变化，请其余玩家重新确认下一手', '桌上阵容有变化，大家重新点一下准备'],
  ['筹码发生变化，请所有玩家重新确认下一手', '筹码刚刚有变动，大家重新点一下准备'],
  ['争议超过 120 秒，房间已冻结；管理员只能退款中止', '结果还没商量好，这一手先暂停'],
]);

export function friendlyRoomMessage(message: string | null | undefined): string {
  if (!message) return '';
  const known = legacyRoomMessages.get(message);
  if (known) return known;
  const removedPlayer = message.match(/^(.+) 已被管理员移出牌桌，请重新确认下一手$/);
  return removedPlayer ? `${removedPlayer[1]} 已离开牌桌，大家重新点一下准备` : message;
}

function clampAmount(value: number, minimum: number, maximum: number, step: number): number {
  const safe = Math.max(minimum, Math.min(maximum, value));
  if (safe === maximum) return maximum;
  const snapped = minimum + Math.round((safe - minimum) / Math.max(1, step)) * Math.max(1, step);
  return Math.max(minimum, Math.min(maximum, snapped));
}

export function betSuggestions(
  room: EnhancedRoomProjection,
  heroSeat: EnhancedSeat | null,
): BetSuggestion[] {
  const prompt = room.prompt;
  if (!prompt) return [];
  const minimum = prompt.minRaiseTo ?? prompt.minBetTo;
  if (minimum === null || minimum > prompt.maxTo) return [];
  const step = Math.max(1, room.settings.smallBlind);
  const currentBet =
    prompt.currentBet ?? Math.max(0, ...room.seats.map((seat) => seat.committedStreet));
  const committed = prompt.committedStreet ?? heroSeat?.committedStreet ?? 0;
  const pot = prompt.potBeforeAction ?? room.pots.reduce((sum, item) => sum + item.amount, 0);
  const call = prompt.callAmount;
  const suggestions: BetSuggestion[] = [];
  const add = (suggestion: Omit<BetSuggestion, 'amountTo'> & { amountTo: number }) => {
    const amountTo = clampAmount(suggestion.amountTo, minimum, prompt.maxTo, step);
    if (suggestions.some((item) => item.amountTo === amountTo)) return;
    suggestions.push({ ...suggestion, amountTo });
  };

  if (room.phase === 'PREFLOP') {
    const depth = prompt.raiseDepth ?? (currentBet <= room.settings.bigBlind ? 0 : 1);
    if (depth <= 0) {
      add({
        label: 'Open',
        detail: '2.5 BB',
        amountTo: room.settings.bigBlind * 2.5,
        semantic: 'OPEN',
      });
    } else if (depth === 1) {
      add({
        label: '3-Bet',
        detail: '3× 当前加注',
        amountTo: currentBet * 3,
        semantic: 'THREE_BET',
      });
    } else {
      add({
        label: '4-Bet',
        detail: '2.3× 当前加注',
        amountTo: currentBet * 2.3,
        semantic: 'FOUR_BET',
      });
    }
  } else {
    const potAfterCall = pot + call;
    const fractions = [
      ['1/3 Pot', 1 / 3],
      ['1/2 Pot', 1 / 2],
      ['2/3 Pot', 2 / 3],
      ['Pot', 1],
    ] as const;
    for (const [label, fraction] of fractions) {
      const amountTo =
        call > 0
          ? currentBet + potAfterCall * fraction
          : committed + Math.max(room.settings.bigBlind, pot * fraction);
      add({
        label,
        detail: `${Math.round(fraction * 100)}% 底池`,
        amountTo,
        semantic: 'POT_FRACTION',
      });
    }
  }
  add({ label: '最小', detail: '规则下限', amountTo: minimum, semantic: 'MINIMUM' });
  return suggestions;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asPositions(value: unknown): TablePosition[] {
  const allowed = new Set<TablePosition>(['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO']);
  return Array.isArray(value)
    ? value.filter((position): position is TablePosition => allowed.has(position as TablePosition))
    : [];
}

function asCards(value: unknown): Card[] {
  return Array.isArray(value)
    ? value.filter(
        (card): card is Card => typeof card === 'string' && /^[2-9TJQKA][cdhs]$/.test(card),
      )
    : [];
}

export function historySettlement(resultValue: unknown): HistorySettlementSummary | null {
  const result = asRecord(resultValue);
  const awards = Array.isArray(result.awards) ? result.awards : [];
  const refunds = Array.isArray(result.refunds) ? result.refunds : [];
  if (!awards.length && !refunds.length && typeof result.reason !== 'string') return null;

  const payouts = new Map<string, HistoryPayoutItem>();
  let totalPot = 0;
  for (const awardValue of awards) {
    const award = asRecord(awardValue);
    const potIndex = asNumber(award.potIndex);
    totalPot += asNumber(award.amount) ?? 0;
    const shares = Array.isArray(award.shares) ? award.shares : [];
    for (const shareValue of shares) {
      const share = asRecord(shareValue);
      const playerId = asString(share.playerId);
      const amount = asNumber(share.amount);
      if (!playerId || amount === undefined) continue;
      const current = payouts.get(playerId) ?? { playerId, amount: 0, potIndexes: [] };
      current.amount += amount;
      if (potIndex !== undefined && !current.potIndexes.includes(potIndex)) {
        current.potIndexes.push(potIndex);
      }
      payouts.set(playerId, current);
    }
  }

  const reason =
    result.reason === 'UNCONTESTED' ||
    result.reason === 'SHOWDOWN' ||
    result.reason === 'LIVE_CONFIRMED'
      ? result.reason
      : 'UNKNOWN';
  return {
    reason,
    communityCards: asCards(result.communityCards),
    totalPot,
    payouts: [...payouts.values()].sort((left, right) => right.amount - left.amount),
    refunds: refunds.flatMap((refundValue) => {
      const refund = asRecord(refundValue);
      const playerId = asString(refund.playerId);
      const amount = asNumber(refund.amount);
      return playerId && amount !== undefined ? [{ playerId, amount }] : [];
    }),
  };
}

export function historyActions(
  hand: HandHistoryItem,
  playerNames: Map<string, string>,
  playerPositions: Map<string, TablePosition[]> = new Map(),
): TableActionItem[] {
  let street: HandPhase | 'LOBBY' = 'PREFLOP';
  const output: TableActionItem[] = [];
  const processEvent = (
    eventType: string,
    payloadValue: unknown,
    seq: number,
    createdAt: string,
  ): void => {
    const payload = asRecord(payloadValue);
    const precedingEvents = Array.isArray(payload.precedingEvents) ? payload.precedingEvents : [];
    for (const precedingValue of precedingEvents) {
      const preceding = asRecord(precedingValue);
      const precedingType = asString(preceding.type);
      if (precedingType) {
        processEvent(precedingType, preceding.payload ?? preceding.publicPayload, seq, createdAt);
      }
    }
    const explicitStreet = asString(payload.street);
    if (explicitStreet && explicitStreet in phaseLabel) street = explicitStreet as HandPhase;
    if (eventType === 'HAND_STARTED') {
      street = 'PREFLOP';
      const forcedBets = Array.isArray(payload.forcedBets) ? payload.forcedBets : [];
      for (const forcedBetValue of forcedBets) {
        const forcedBet = asRecord(forcedBetValue);
        const playerId = asString(forcedBet.playerId) ?? null;
        const action = asString(forcedBet.action);
        if (action !== 'SMALL_BLIND' && action !== 'BIG_BLIND' && action !== 'ANTE') continue;
        output.push({
          seq,
          street,
          playerId,
          nickname:
            asString(forcedBet.nickname) ??
            (playerId ? (playerNames.get(playerId) ?? '玩家') : '玩家'),
          positions:
            asPositions(forcedBet.positions).length > 0
              ? asPositions(forcedBet.positions)
              : playerId
                ? (playerPositions.get(playerId) ?? [])
                : [],
          action,
          amount: asNumber(forcedBet.amount),
          stackAfter: asNumber(forcedBet.stackAfter),
          createdAt,
        });
      }
      return;
    }
    if (eventType === 'STREET_DEALT' || eventType === 'LIVE_STREET_DEALT') {
      const board = asCards(payload.communityCards);
      const dealtCount = street === 'FLOP' ? 3 : street === 'TURN' || street === 'RIVER' ? 1 : 0;
      output.push({
        seq,
        street,
        playerId: null,
        nickname: '牌桌',
        positions: [],
        action: 'DEAL',
        cards: dealtCount > 0 ? board.slice(-dealtCount) : [],
        createdAt,
      });
      return;
    }
    if (eventType !== 'PLAYER_ACTED' && eventType !== 'PLAYER_TIMED_OUT') return;
    const playerId = asString(payload.playerId) ?? null;
    const rawAction = asString(payload.action) as PlayerAction | undefined;
    if (!rawAction) return;
    output.push({
      seq,
      street,
      playerId,
      nickname:
        asString(payload.nickname) ?? (playerId ? (playerNames.get(playerId) ?? '玩家') : '玩家'),
      positions:
        asPositions(payload.positions).length > 0
          ? asPositions(payload.positions)
          : playerId
            ? (playerPositions.get(playerId) ?? [])
            : [],
      action: rawAction,
      amount: asNumber(payload.amount),
      amountTo: asNumber(payload.amountTo),
      stackAfter: asNumber(payload.stackAfter),
      createdAt,
      timedOut: eventType === 'PLAYER_TIMED_OUT',
    });
  };
  for (const event of hand.events) {
    processEvent(event.type, event.publicPayload, event.seq, event.createdAt);
  }
  return output;
}

export function naturalAction(action: TableActionItem): string {
  const position = action.positions.length ? `${positionLabel(action.positions)} · ` : '';
  const actor = `${position}${action.nickname}`;
  if (action.action === 'DEAL') {
    const cards = action.cards?.map(cardText).join(' ') ?? '';
    return `${phaseLabel[action.street] ?? action.street}发牌${cards ? ` · ${cards}` : ''}`;
  }
  const verb = actionChinese[action.action] ?? '行动';
  const hidesAmount = action.action === 'FOLD' || action.action === 'CHECK';
  const amount = hidesAmount ? undefined : action.amount;
  const target = hidesAmount ? undefined : action.amountTo;
  const targetCopy = target === undefined ? '' : ` ${formatPoints(target)}`;
  const investedCopy =
    amount === undefined || (target !== undefined && amount === target)
      ? ''
      : target !== undefined && amount !== target
        ? `（本次投入 ${formatPoints(amount)}）`
        : ` ${formatPoints(amount)}`;
  return `${actor} ${verb}${targetCopy}${investedCopy}${action.timedOut ? '（超时）' : ''}`;
}

function cardText(card: Card): string {
  const suit = card.slice(-1);
  const symbol: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };
  return `${cardRankLabel(card)}${symbol[suit] ?? ''}`;
}
