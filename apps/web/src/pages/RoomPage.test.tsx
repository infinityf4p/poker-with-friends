// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomSnapshotEnvelope } from '@poker-with-friends/protocol';
import { RoomPage } from './RoomPage';
import type { RoomConnection } from '../use-room';

const mocks = vi.hoisted(() => ({ connection: null as RoomConnection | null }));
vi.mock('../use-room', () => ({ useRoom: () => mocks.connection }));
vi.mock('../api', () => ({ api: vi.fn(async () => []) }));

function snapshot(): RoomSnapshotEnvelope {
  const now = new Date().toISOString();
  return {
    public: {
      roomId: 'test-table',
      name: 'Test table',
      mode: 'ONLINE',
      status: 'ACTIVE',
      settings: {
        mode: 'ONLINE',
        smallBlind: 10,
        bigBlind: 20,
        startingStack: 2000,
        stackCap: 2000,
        actionTimeoutSeconds: 30,
        resultDisplaySeconds: 3,
        nextHandCountdownSeconds: 5,
        maxPlayers: 6,
      },
      serverSeq: 1,
      handNumber: 1,
      phase: 'PREFLOP',
      seats: Array.from({ length: 6 }, (_, seat) => ({
        seat,
        playerId: `player-${seat}`,
        nickname: `Player ${seat}`,
        stack: 1980,
        committedStreet: 20,
        committedHand: 20,
        ready: false,
        connected: true,
        sittingOut: false,
        folded: false,
        allIn: false,
        role: null,
        positions: [],
        isActing: seat === 4,
        hasCards: true,
      })),
      communityCards: [],
      pots: [{ id: 'pot-0', amount: 120, eligiblePlayerIds: ['player-4'] }],
      actingSeat: 4,
      buttonSeat: 1,
      smallBlindSeat: 2,
      bigBlindSeat: 3,
      liveDealerSeat: null,
      pendingLiveStreet: null,
      prompt: {
        playerId: 'player-4',
        callAmount: 20,
        minBetTo: null,
        minRaiseTo: 40,
        maxTo: 2000,
        legalActions: ['FOLD', 'CALL', 'RAISE_TO', 'ALL_IN'],
        deadlineAt: new Date(Date.now() + 30000).toISOString(),
        currentBet: 20,
        committedStreet: 20,
        potBeforeAction: 120,
        raiseDepth: 0,
      },
      liveResultProposal: null,
      nextHandAt: null,
      readyCount: 0,
      requiredReadyCount: 6,
      createdAt: now,
      updatedAt: now,
    },
    private: {
      playerId: 'player-4',
      roomId: 'test-table',
      seat: 4,
      holeCards: ['As', 'Kh'],
      turnToken: 'test-turn',
    },
  };
}

let root: Root;
let container: HTMLDivElement;
let connection: RoomConnection;
const render = async () => {
  await act(async () => root.render(<RoomPage roomId="test-table" />));
};
const button = (label: string) => {
  const element = [...document.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!element) throw new Error(`Button missing: ${label}`);
  return element;
};
const click = async (label: string) => {
  await act(async () => button(label).click());
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const state = snapshot();
  connection = {
    room: state.public,
    me: state.private,
    connected: true,
    busy: false,
    loading: false,
    error: null,
    clearError: vi.fn(),
    send: vi.fn(async () => true),
    refresh: vi.fn(async () => {}),
  };
  mocks.connection = connection;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('table interaction', () => {
  it('keeps hand history open when the next hand begins', async () => {
    await render();
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="查看牌谱"]')!.click(),
    );
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    connection.room = { ...connection.room!, handNumber: 2 };
    await render();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('retains focus in an all-in dialog while its command is pending', async () => {
    let finish!: (value: boolean) => void;
    connection.send = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    await click('全下');
    await click('确认全下');
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(document.activeElement).toBe(dialog);
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    await act(async () => {
      dialog.dispatchEvent(tab);
    });
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(dialog);
    await act(async () => finish(false));
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('操作未成功');
  });

  it('preserves the chosen wager through unrelated sequence updates', async () => {
    await render();
    await click('Open');
    const amount = () => document.querySelector<HTMLInputElement>('input[type="number"]')!.value;
    expect(amount()).toBe('50');
    connection.room = { ...connection.room!, serverSeq: 2 };
    await render();
    expect(amount()).toBe('50');
    await click('加注到 50');
    expect(connection.send).toHaveBeenCalledWith(
      'hand.act',
      { action: 'RAISE_TO', amountTo: 50 },
      { needsTurnToken: true },
    );
  });

  it('resets wager selection on the next turn and accepts exact stack maximums', async () => {
    await render();
    await click('Open');
    connection.room = {
      ...connection.room!,
      prompt: {
        ...connection.room!.prompt!,
        maxTo: 997,
        deadlineAt: new Date(Date.now() + 60000).toISOString(),
      },
    };
    await render();
    expect(document.querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe('40');
    const slider = document.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(slider.step).toBe('1');
    expect(slider.max).toBe('997');
  });

  it('requires confirmation before all-in and leaves cancellation without a command', async () => {
    await render();
    await click('全下');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(connection.send).not.toHaveBeenCalled();
    await click('取消');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await click('全下');
    await click('确认全下');
    expect(connection.send).toHaveBeenCalledExactlyOnceWith(
      'hand.act',
      { action: 'ALL_IN' },
      { needsTurnToken: true },
    );
  });

  it('closes an open all-in dialog and disables commands on disconnection', async () => {
    await render();
    await click('全下');
    connection.connected = false;
    await render();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector<HTMLFieldSetElement>('.command-surface')!.disabled).toBe(true);
    expect(connection.send).not.toHaveBeenCalled();
  });

  it('lets a seated, sitting-out player return and prepare even with one eligible opponent', async () => {
    connection.room!.status = 'BETWEEN_HANDS';
    connection.room!.prompt = null;
    connection.room!.seats.forEach((seat) => {
      seat.sittingOut = seat.seat !== 0;
    });
    await render();
    expect(button('返回并准备').disabled).toBe(false);
    await click('返回并准备');
    expect(connection.send).toHaveBeenCalledWith('player.ready', {}, { needsTurnToken: false });
  });

  it('anchors the player at the bottom and keeps their hand at their own seat', async () => {
    await render();
    const own = document.querySelector('.table-seat--own')!;
    expect(own.classList.contains('table-seat--0')).toBe(true);
    expect(own.getAttribute('data-testid')).toBe('player-seat-4');
    expect(own.querySelectorAll('.playing-card')).toHaveLength(2);
    expect(document.querySelectorAll('.real-table-center .playing-card')).toHaveLength(0);
    expect(document.querySelectorAll('[aria-label="行动操作区"]')).toHaveLength(1);
  });
});
