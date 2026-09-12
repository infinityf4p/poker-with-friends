// @vitest-environment happy-dom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult, RoomSnapshotEnvelope } from '@poker-with-friends/protocol';
import { useRoom, type RoomConnection } from './use-room';

const mocked = vi.hoisted(() => ({ io: vi.fn(), api: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: mocked.io }));
vi.mock('./api', () => ({ api: mocked.api }));

type Ack = (error: Error | null, result?: CommandResult) => void;

class TestSocket {
  connected = false;
  io = { opts: { reconnection: true } };
  listeners = new Map<string, (payload?: unknown) => void>();
  on = vi.fn((event: string, callback: (payload?: unknown) => void) => {
    this.listeners.set(event, callback);
    return this;
  });
  timeout = vi.fn(() => this);
  emit = vi.fn((_event: string, _payload: unknown, _ack: Ack) => this);
  removeAllListeners = vi.fn(() => this.listeners.clear());
  connect = vi.fn(() => this);
  disconnect = vi.fn(() => this.receive('disconnect'));

  receive(event: string, payload?: unknown): void {
    if (event === 'connect') this.connected = true;
    if (event === 'disconnect') this.connected = false;
    this.listeners.get(event)?.(payload);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function snapshot(roomId: string, serverSeq: number): RoomSnapshotEnvelope {
  return {
    public: {
      roomId,
      name: roomId,
      mode: 'ONLINE',
      status: 'LOBBY',
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
      serverSeq,
      handNumber: 0,
      phase: null,
      seats: [],
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
      requiredReadyCount: 2,
      createdAt: '2026-09-12T00:00:00Z',
      updatedAt: '2026-09-12T00:00:00Z',
    },
    private: { playerId: `${roomId}-player`, roomId, seat: 0, holeCards: [] },
  };
}

let root: Root;
let container: HTMLDivElement;
let current: RoomConnection;
let sockets: TestSocket[];

function Probe({ roomId, adminView = false }: { roomId: string; adminView?: boolean }) {
  current = useRoom(roomId, adminView);
  return null;
}

async function render(roomId: string, adminView = false, strict = false): Promise<void> {
  await act(async () => {
    const probe = <Probe roomId={roomId} adminView={adminView} />;
    root.render(strict ? <StrictMode>{probe}</StrictMode> : probe);
  });
}

async function connect(socket: TestSocket, state: RoomSnapshotEnvelope): Promise<void> {
  await act(async () => {
    socket.receive('connect');
    socket.receive('room.snapshot', state);
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocked.api.mockReset();
  mocked.io.mockReset();
  sockets = [];
  mocked.io.mockImplementation(() => {
    const socket = new TestSocket();
    sockets.push(socket);
    return socket;
  });
  mocked.api.mockImplementation(() => new Promise(() => {}));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('room connection lifecycle', () => {
  it('disables commands immediately on browser offline and requires a new snapshot after online', async () => {
    await render('alpha');
    await connect(sockets[0]!, snapshot('alpha', 1));
    expect(current.connected).toBe(true);
    await act(async () => {
      window.dispatchEvent(new Event('offline'));
      sockets[0]!.receive('room.snapshot', snapshot('alpha', 2));
    });
    expect(current.connected).toBe(false);
    expect(sockets[0]!.disconnect).toHaveBeenCalledTimes(1);
    expect(current.room?.serverSeq).toBe(1);
    await act(async () => {
      await expect(current.send('player.ready')).resolves.toBe(false);
      window.dispatchEvent(new Event('online'));
      sockets[0]!.receive('connect');
    });
    expect(sockets[0]!.connect).toHaveBeenCalledTimes(2);
    expect(current.connected).toBe(false);
    expect(sockets[0]!.emit).not.toHaveBeenCalled();
    await act(async () => sockets[0]!.receive('room.snapshot', snapshot('alpha', 3)));
    expect(current.connected).toBe(true);
    expect(current.error).toBeNull();
  });

  it('starts offline without connecting and never reconnects a revoked or cleaned-up session', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await render('alpha');
    expect(sockets[0]!.connect).not.toHaveBeenCalled();
    expect(current.connected).toBe(false);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      sockets[0]!.receive('connect');
      sockets[0]!.receive('room.snapshot', snapshot('alpha', 1));
      sockets[0]!.receive('membership.revoked', { roomId: 'alpha' });
      window.dispatchEvent(new Event('offline'));
      window.dispatchEvent(new Event('online'));
    });
    expect(sockets[0]!.connect).toHaveBeenCalledTimes(1);
    expect(current.error).toBe('你已被移出牌桌');

    await render('beta');
    await act(async () => window.dispatchEvent(new Event('online')));
    expect(sockets[0]!.connect).toHaveBeenCalledTimes(1);
    expect(sockets[1]!.connect).toHaveBeenCalledTimes(1);
  });

  it('waits for this socket to synchronize before allowing commands on connect and reconnect', async () => {
    mocked.api.mockResolvedValueOnce(snapshot('alpha', 1));
    await render('alpha');
    await act(async () => sockets[0]!.receive('connect'));
    expect(current.room?.serverSeq).toBe(1);
    expect(current.connected).toBe(false);
    await act(async () => {
      await expect(current.send('player.ready')).resolves.toBe(false);
    });
    expect(sockets[0]!.emit).not.toHaveBeenCalled();

    await connect(sockets[0]!, snapshot('alpha', 2));
    expect(current.connected).toBe(true);
    await act(async () => {
      sockets[0]!.receive('disconnect');
      sockets[0]!.receive('connect');
    });
    expect(current.connected).toBe(false);
    await act(async () => {
      await expect(current.send('player.ready')).resolves.toBe(false);
      sockets[0]!.receive('room.snapshot', snapshot('alpha', 3));
    });
    expect(current.connected).toBe(true);
    expect(sockets[0]!.emit).not.toHaveBeenCalled();
  });

  it('accepts a socket snapshot while the initial HTTP request is still pending', async () => {
    await render('alpha');
    expect(current.loading).toBe(true);
    await connect(sockets[0]!, snapshot('alpha', 12));
    expect(current.loading).toBe(false);
    expect(current.connected).toBe(true);
    expect(current.me?.playerId).toBe('alpha-player');
  });

  it('resets sequence state on room changes and ignores a late old-room response', async () => {
    const oldRequest = deferred<RoomSnapshotEnvelope>();
    mocked.api.mockReturnValueOnce(oldRequest.promise);
    await render('alpha');
    await connect(sockets[0]!, snapshot('alpha', 100));

    await render('beta');
    expect(current.room).toBeNull();
    expect(current.me).toBeNull();
    expect(current.connected).toBe(false);
    expect(current.loading).toBe(true);
    await connect(sockets[1]!, snapshot('beta', 1));
    await act(async () => oldRequest.resolve(snapshot('alpha', 200)));

    expect(current.room?.roomId).toBe('beta');
    expect(current.room?.serverSeq).toBe(1);
    expect(current.me?.playerId).toBe('beta-player');
    expect(current.error).toBeNull();
  });

  it('ignores old command acknowledgements without unlocking a new pending command', async () => {
    await render('alpha');
    await connect(sockets[0]!, snapshot('alpha', 100));
    let oldCommand!: Promise<boolean>;
    await act(async () => {
      oldCommand = current.send('player.ready');
    });
    expect(current.busy).toBe(true);

    await render('beta');
    await connect(sockets[1]!, snapshot('beta', 1));
    let newCommand!: Promise<boolean>;
    await act(async () => {
      newCommand = current.send('player.ready');
      sockets[0]!.emit.mock.calls[0]![2](null, {
        ok: true,
        serverSeq: 101,
        data: snapshot('alpha', 101),
      });
    });
    await expect(oldCommand).resolves.toBe(false);
    expect(current.busy).toBe(true);
    expect(current.room?.roomId).toBe('beta');
    await act(async () => {
      sockets[1]!.emit.mock.calls[0]![2](null, {
        ok: true,
        serverSeq: 2,
        data: snapshot('beta', 2),
      });
    });
    await expect(newCommand).resolves.toBe(true);
    expect(current.busy).toBe(false);
    expect(current.room?.serverSeq).toBe(2);
  });

  it('keeps revoked membership cleared when HTTP, private events, and acknowledgements arrive late', async () => {
    const initial = deferred<RoomSnapshotEnvelope>();
    mocked.api.mockReturnValueOnce(initial.promise);
    await render('alpha');
    await connect(sockets[0]!, snapshot('alpha', 1));
    let command!: Promise<boolean>;
    await act(async () => {
      command = current.send('player.ready');
      sockets[0]!.receive('membership.revoked', { roomId: 'alpha' });
      sockets[0]!.receive('room.private', snapshot('alpha', 2).private);
      sockets[0]!.emit.mock.calls[0]![2](null, {
        ok: true,
        serverSeq: 2,
        data: snapshot('alpha', 2),
      });
      initial.resolve(snapshot('alpha', 3));
    });

    await expect(command).resolves.toBe(false);
    expect(current.me).toBeNull();
    expect(current.connected).toBe(false);
    expect(current.busy).toBe(false);
    expect(current.error).toBe('你已被移出牌桌');
    expect(sockets[0]!.io.opts.reconnection).toBe(false);
  });

  it('ignores requests from the discarded StrictMode session', async () => {
    const discarded = deferred<RoomSnapshotEnvelope>();
    const active = deferred<RoomSnapshotEnvelope>();
    mocked.api.mockReturnValueOnce(discarded.promise).mockReturnValueOnce(active.promise);
    await render('alpha', false, true);
    await act(async () => active.resolve(snapshot('alpha', 5)));
    await act(async () => discarded.reject(new Error('discarded request failed')));
    expect(current.room?.serverSeq).toBe(5);
    expect(current.error).toBeNull();
  });

  it('marks an admin observation disconnected after a failed refresh', async () => {
    mocked.api.mockResolvedValueOnce({ ...snapshot('alpha', 1), private: null });
    await render('alpha', true);
    expect(current.connected).toBe(true);
    mocked.api.mockRejectedValueOnce(new Error('network unavailable'));
    await act(async () => current.refresh());
    expect(current.connected).toBe(false);
    expect(current.error).toBe('network unavailable');
  });

  it('emits only one command for repeated clicks before an acknowledgement', async () => {
    await render('alpha');
    await connect(sockets[0]!, snapshot('alpha', 1));
    let first!: Promise<boolean>;
    let repeated!: Promise<boolean>;
    await act(async () => {
      first = current.send('player.ready');
      repeated = current.send('player.ready');
    });
    await expect(repeated).resolves.toBe(false);
    expect(sockets[0]!.emit).toHaveBeenCalledTimes(1);
    await act(async () => {
      sockets[0]!.emit.mock.calls[0]![2](null, {
        ok: true,
        serverSeq: 2,
        data: snapshot('alpha', 2),
      });
    });
    await expect(first).resolves.toBe(true);
  });
});
