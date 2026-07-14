import type {
  Card,
  HandHistoryItem,
  PublicRoomProjection,
  PublicSeat,
} from '@poker-with-friends/protocol';
import { describe, expect, it } from 'vitest';
import {
  betSuggestions,
  cardRankLabel,
  historyActions,
  historySettlement,
  naturalAction,
} from './poker-ui';

function seat(seatNumber: number, overrides: Partial<PublicSeat> = {}): PublicSeat {
  return {
    seat: seatNumber,
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
    ...overrides,
  };
}

function room(overrides: Partial<PublicRoomProjection> = {}): PublicRoomProjection {
  const now = new Date(0).toISOString();
  return {
    roomId: '00000000-0000-4000-8000-000000000001',
    name: 'test',
    mode: 'ONLINE',
    status: 'ACTIVE',
    settings: {
      mode: 'ONLINE',
      smallBlind: 10,
      bigBlind: 20,
      startingStack: 2_000,
      stackCap: 2_000,
      actionTimeoutSeconds: 30,
      resultDisplaySeconds: 3,
      nextHandCountdownSeconds: 5,
      maxPlayers: 6,
    },
    serverSeq: 1,
    handNumber: 1,
    phase: 'PREFLOP',
    seats: Array.from({ length: 6 }, (_, index) => seat(index)),
    communityCards: [],
    pots: [{ id: 'pot-0', amount: 30, eligiblePlayerIds: ['p1', 'p2'] }],
    actingSeat: 0,
    buttonSeat: 0,
    smallBlindSeat: 0,
    bigBlindSeat: 1,
    liveDealerSeat: null,
    pendingLiveStreet: null,
    prompt: {
      playerId: 'p1',
      callAmount: 10,
      minBetTo: null,
      minRaiseTo: 40,
      maxTo: 2_000,
      legalActions: ['FOLD', 'CALL', 'RAISE_TO', 'ALL_IN'],
      deadlineAt: now,
      currentBet: 20,
      committedStreet: 10,
      potBeforeAction: 30,
      raiseDepth: 0,
    },
    liveResultProposal: null,
    nextHandAt: null,
    readyCount: 0,
    requiredReadyCount: 2,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('poker UI helpers', () => {
  it('renders the internal ten rank as 10 instead of T', () => {
    const tens: Card[] = ['Ts', 'Th', 'Td', 'Tc'];
    expect(tens.map(cardRankLabel)).toEqual(['10', '10', '10', '10']);
    expect(cardRankLabel('As')).toBe('A');
  });

  it('offers open, 3-bet, and 4-bet targets from server betting context', () => {
    expect(betSuggestions(room(), null)[0]).toMatchObject({ label: 'Open', amountTo: 50 });
    expect(
      betSuggestions(
        room({ prompt: { ...room().prompt!, currentBet: 50, minRaiseTo: 80, raiseDepth: 1 } }),
        null,
      )[0],
    ).toMatchObject({ label: '3-Bet', amountTo: 150 });
    expect(
      betSuggestions(
        room({
          prompt: { ...room().prompt!, currentBet: 150, minRaiseTo: 250, raiseDepth: 2 },
        }),
        null,
      )[0],
    ).toMatchObject({ label: '4-Bet', amountTo: 350 });
  });

  it('renders structured player actions and preserves historical name and position snapshots', () => {
    const hand: HandHistoryItem = {
      handId: 'hand-1',
      handNumber: 1,
      startedAt: new Date(0).toISOString(),
      endedAt: new Date(1).toISOString(),
      mode: 'ONLINE',
      result: {},
      events: [
        {
          seq: 1,
          type: 'HAND_STARTED',
          createdAt: new Date(0).toISOString(),
          publicPayload: {
            forcedBets: [
              {
                playerId: 'p1',
                nickname: '当时的小明',
                positions: ['BTN', 'SB'],
                action: 'SMALL_BLIND',
                amount: 10,
                stackAfter: 1_990,
              },
            ],
          },
        },
        {
          seq: 2,
          type: 'PLAYER_ACTED',
          createdAt: new Date(1).toISOString(),
          publicPayload: {
            playerId: 'p1',
            nickname: '当时的小明',
            positions: ['BTN', 'SB'],
            action: 'FOLD',
            amount: 0,
          },
        },
      ],
    };
    const actions = historyActions(hand, new Map([['p1', '现在的名字']]));
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({ nickname: '当时的小明', positions: ['BTN', 'SB'] });
    expect(naturalAction(actions[1]!)).toBe('BTN 按钮位 / SB 小盲 · 当时的小明 弃牌');
    expect(
      naturalAction({
        seq: 3,
        street: 'PREFLOP',
        playerId: 'p1',
        nickname: '当时的小明',
        positions: ['BTN'],
        action: 'RAISE_TO',
        amount: 40,
        amountTo: 40,
      }),
    ).toBe('BTN 按钮位 · 当时的小明 加注到 40');
  });

  it('summarizes winners, side pots, refunds, and the board for history cards', () => {
    expect(
      historySettlement({
        reason: 'SHOWDOWN',
        communityCards: ['As', 'Kh', 'Td', '2c', '3s'],
        awards: [
          {
            potIndex: 0,
            amount: 300,
            shares: [
              { playerId: 'p1', amount: 150 },
              { playerId: 'p2', amount: 150 },
            ],
          },
          { potIndex: 1, amount: 100, shares: [{ playerId: 'p1', amount: 100 }] },
        ],
        refunds: [{ playerId: 'p3', amount: 40 }],
      }),
    ).toEqual({
      reason: 'SHOWDOWN',
      communityCards: ['As', 'Kh', 'Td', '2c', '3s'],
      totalPot: 400,
      payouts: [
        { playerId: 'p1', amount: 250, potIndexes: [0, 1] },
        { playerId: 'p2', amount: 150, potIndexes: [0] },
      ],
      refunds: [{ playerId: 'p3', amount: 40 }],
    });
  });
});
