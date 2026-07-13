import { randomUUID } from 'node:crypto';
import { getLegalActions } from '@poker/engine';
import { DEFAULT_ROOM_SETTINGS, type CommandResult, type RoomMode } from '@poker/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { LoadedRoom, PokerRepository, RoomCommit } from '../repository.js';
import { RoomActor } from './actor.js';

class FakeRepository {
  readonly results = new Map<
    string,
    { playerId: string; requestHash: string; result: CommandResult }
  >();
  readonly commits: RoomCommit[] = [];
  failNextCommit = false;
  failAfterCommit = false;

  async getCommandResult(
    _roomId: string,
    commandId: string,
    playerId: string,
    requestHash: string,
  ) {
    const stored = this.results.get(commandId);
    if (!stored) return null;
    if (stored.playerId !== playerId || stored.requestHash !== requestHash) {
      return { kind: 'conflict' as const };
    }
    return { kind: 'match' as const, result: stored.result };
  }

  async persistRejectedCommand(
    _roomId: string,
    commandId: string,
    playerId: string,
    requestHash: string,
    _seq: number,
    result: CommandResult,
  ): Promise<void> {
    this.results.set(commandId, { playerId, requestHash, result });
  }

  async commitRoom(commit: RoomCommit): Promise<void> {
    if (this.failNextCommit) {
      this.failNextCommit = false;
      throw new Error('simulated transaction rollback');
    }
    this.commits.push(structuredClone(commit));
    if (commit.command) {
      this.results.set(commit.command.commandId, {
        playerId: commit.command.playerId,
        requestHash: commit.command.requestHash,
        result: structuredClone(commit.command.result),
      });
    }
    if (this.failAfterCommit) {
      this.failAfterCommit = false;
      throw new Error('simulated lost commit response');
    }
  }
}

function loadedRoom(mode: RoomMode): LoadedRoom {
  const now = new Date();
  const settings = { ...DEFAULT_ROOM_SETTINGS, mode };
  return {
    room: {
      id: '00000000-0000-4000-8000-000000000001',
      name: `${mode} test`,
      mode,
      status: 'LOBBY',
      settings,
      settingsLocked: false,
      serverSeq: 0,
      handNumber: 0,
      publicSnapshot: { createdAt: now.toISOString() },
      lastOnlineAt: now,
      archivedAt: null,
      archiveReason: null,
      createdByAdminId: '00000000-0000-4000-8000-000000000099',
      createdAt: now,
      updatedAt: now,
    },
    players: [
      {
        id: '00000000-0000-4000-8000-000000000011',
        roomId: '00000000-0000-4000-8000-000000000001',
        userId: '00000000-0000-4000-8000-000000000021',
        nickname: 'A',
        stack: 2_000,
        seat: 0,
        ready: false,
        sittingOut: false,
        connected: false,
        membershipStatus: 'ACTIVE',
        kickedAt: null,
        kickedByAdminId: null,
        kickReason: null,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: '00000000-0000-4000-8000-000000000012',
        roomId: '00000000-0000-4000-8000-000000000001',
        userId: '00000000-0000-4000-8000-000000000022',
        nickname: 'B',
        stack: 2_000,
        seat: 1,
        ready: false,
        sittingOut: false,
        connected: false,
        membershipStatus: 'ACTIVE',
        kickedAt: null,
        kickedByAdminId: null,
        kickReason: null,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ],
    privateState: null,
  } as LoadedRoom;
}

async function readyTable(mode: RoomMode) {
  const repository = new FakeRepository();
  const actor = new RoomActor(
    loadedRoom(mode),
    repository as unknown as PokerRepository,
    () => undefined,
  );
  const [a, b] = actor.state.players;
  await actor.setConnected(a!.id, true);
  await actor.setConnected(b!.id, true);
  await actor.ready(a!.id, {
    commandId: randomUUID(),
    expectedSeq: actor.state.serverSeq,
    payload: {},
  });
  await actor.ready(b!.id, {
    commandId: randomUUID(),
    expectedSeq: actor.state.serverSeq,
    payload: {},
  });
  expect(actor.state.status).toBe('ACTIVE');
  return { actor, repository, a: a!, b: b! };
}

async function finishCurrentBettingRound(actor: RoomActor): Promise<void> {
  while (
    actor.state.status === 'ACTIVE' &&
    actor.state.hand &&
    !actor.state.hand.betting.complete
  ) {
    const hand = actor.state.hand;
    const actorId = hand.betting.actorId!;
    const legal = getLegalActions(hand.betting);
    const action = legal.canCheck ? 'CHECK' : legal.callAmount !== null ? 'CALL' : 'FOLD';
    const result = await actor.act(actorId, {
      commandId: randomUUID(),
      expectedSeq: actor.state.serverSeq,
      turnToken: hand.turnToken!,
      payload: { action },
    });
    expect(result.ok).toBe(true);
  }
}

async function driveLiveToShowdown(actor: RoomActor): Promise<void> {
  await finishCurrentBettingRound(actor);
  for (const street of ['FLOP', 'TURN', 'RIVER'] as const) {
    expect(actor.state.hand?.pendingLiveStreet).toBe(street);
    const dealerSeat = actor.snapshot(actor.state.players[0]!.id).public.liveDealerSeat;
    const dealer = actor.state.players.find((player) => player.seat === dealerSeat)!;
    const result = await actor.liveStreetDealt(dealer.id, {
      commandId: randomUUID(),
      expectedSeq: actor.state.serverSeq,
      payload: { street },
    });
    expect(result.ok).toBe(true);
    await finishCurrentBettingRound(actor);
  }
  expect(actor.state.hand?.phase).toBe('SHOWDOWN');
}

describe('RoomActor', () => {
  it('lets a LIVE player claim an empty seat without marking lobby seats as acting', async () => {
    const loaded = loadedRoom('LIVE');
    loaded.players[0]!.seat = null;
    const repository = new FakeRepository();
    const actor = new RoomActor(loaded, repository as unknown as PokerRepository, () => undefined);
    const player = actor.state.players[0]!;

    await actor.setConnected(player.id, true);
    const result = await actor.seatClaim(player.id, {
      commandId: randomUUID(),
      expectedSeq: actor.state.serverSeq,
      payload: { seat: 3 },
    });

    expect(result.ok).toBe(true);
    expect(actor.snapshot(player.id).private?.seat).toBe(3);
    expect(actor.snapshot(player.id).public.seats[3]).toMatchObject({
      playerId: player.id,
      isActing: false,
    });
    expect(
      actor
        .snapshot(player.id)
        .public.seats.filter((seat) => seat.playerId)
        .every((seat) => !seat.isActing),
    ).toBe(true);
  });

  it.each(['ONLINE', 'LIVE'] as const)(
    'completes 100 consecutive %s hands without manual ledger repair',
    async (mode) => {
      const { actor, a, b } = await readyTable(mode);
      const buttons: number[] = [];
      for (let index = 0; index < 100; index += 1) {
        const hand = actor.state.hand!;
        buttons.push(hand.buttonSeat);
        const result = await actor.act(hand.betting.actorId!, {
          commandId: randomUUID(),
          expectedSeq: actor.state.serverSeq,
          turnToken: hand.turnToken!,
          payload: { action: 'FOLD' },
        });
        expect(result.ok).toBe(true);
        expect(actor.state.players.reduce((sum, player) => sum + player.stack, 0)).toBe(4_000);
        if (index === 99) break;
        for (const player of [a, b]) {
          const ready = await actor.ready(player.id, {
            commandId: randomUUID(),
            expectedSeq: actor.state.serverSeq,
            payload: {},
          });
          expect(ready.ok).toBe(true);
        }
      }
      expect(actor.state.handNumber).toBe(100);
      expect(actor.state.status).toBe('BETWEEN_HANDS');
      for (let index = 1; index < buttons.length; index += 1) {
        expect(buttons[index]).not.toBe(buttons[index - 1]);
      }
    },
  );

  it('settles an ONLINE hand and conserves all chips when everyone but one folds', async () => {
    const { actor, repository, a } = await readyTable('ONLINE');
    const hand = actor.state.hand!;
    const privateCards = actor.snapshot(a.id).private!.holeCards;
    expect(privateCards).toHaveLength(2);
    for (const card of privateCards) {
      expect(JSON.stringify(actor.snapshot(a.id).public)).not.toContain(card);
    }
    const actorId = hand.betting.actorId!;
    const commandId = randomUUID();
    const actionCommand = {
      commandId,
      expectedSeq: actor.state.serverSeq,
      turnToken: hand.turnToken!,
      payload: { action: 'FOLD' as const },
    };
    const result = await actor.act(actorId, actionCommand);
    expect(result.ok).toBe(true);
    expect(actor.state.status).toBe('BETWEEN_HANDS');
    expect(actor.state.hand?.phase).toBe('SETTLED');
    expect(actor.state.players.reduce((sum, player) => sum + player.stack, 0)).toBe(4_000);
    expect(actor.state.nextHandAt).toBeNull();
    expect(actor.state.players.every((player) => !player.ready)).toBe(true);
    const commits = repository.commits.length;
    const duplicate = await actor.act(actorId, actionCommand);
    expect(duplicate).toEqual(result);
    expect(repository.commits).toHaveLength(commits);
    const otherPlayer = actor.state.players.find((player) => player.id !== actorId)!;
    const stolen = await actor.act(otherPlayer.id, actionCommand);
    expect(stolen).toMatchObject({ ok: false, code: 'CONFLICT' });
  });

  it('rolls the actor state back when the database transaction fails', async () => {
    const { actor, repository } = await readyTable('ONLINE');
    const before = structuredClone(actor.state);
    const hand = actor.state.hand!;
    repository.failNextCommit = true;
    const result = await actor.act(hand.betting.actorId!, {
      commandId: randomUUID(),
      expectedSeq: actor.state.serverSeq,
      turnToken: hand.turnToken!,
      payload: { action: 'FOLD' },
    });
    expect(result).toMatchObject({ ok: false, code: 'INTERNAL_ERROR' });
    expect(actor.state).toEqual(before);
  });

  it('recovers an idempotent success when the commit response is lost', async () => {
    const { actor, repository } = await readyTable('ONLINE');
    const hand = actor.state.hand!;
    repository.failAfterCommit = true;
    const result = await actor.act(hand.betting.actorId!, {
      commandId: randomUUID(),
      expectedSeq: actor.state.serverSeq,
      turnToken: hand.turnToken!,
      payload: { action: 'FOLD' },
    });
    expect(result.ok).toBe(true);
    expect(actor.state.status).toBe('BETWEEN_HANDS');
    expect(actor.state.players.reduce((sum, player) => sum + player.stack, 0)).toBe(4_000);
  });

  it('requires every eligible player to confirm each new hand and resets confirmations on chip changes', async () => {
    const { actor, a, b } = await readyTable('ONLINE');
    const firstHand = actor.state.hand!;
    const folded = await actor.act(firstHand.betting.actorId!, {
      commandId: randomUUID(),
      expectedSeq: actor.state.serverSeq,
      turnToken: firstHand.turnToken!,
      payload: { action: 'FOLD' },
    });
    expect(folded.ok).toBe(true);
    expect(actor.state.status).toBe('BETWEEN_HANDS');

    const firstReady = await actor.ready(a.id, {
      commandId: randomUUID(),
      expectedSeq: actor.state.serverSeq,
      payload: {},
    });
    expect(firstReady.ok).toBe(true);
    expect(actor.state.status).toBe('BETWEEN_HANDS');
    expect(actor.state.players.find((player) => player.id === a.id)?.ready).toBe(true);

    const shortPlayer = actor.state.players.find(
      (player) => player.stack < actor.state.settings.stackCap,
    )!;
    const toppedUp = await actor.topUp(shortPlayer.id, {
      commandId: randomUUID(),
      expectedSeq: actor.state.serverSeq,
      payload: { targetStack: actor.state.settings.stackCap },
    });
    expect(toppedUp.ok).toBe(true);
    expect(actor.state.players.every((player) => !player.ready)).toBe(true);

    for (const player of [a, b]) {
      const result = await actor.ready(player.id, {
        commandId: randomUUID(),
        expectedSeq: actor.state.serverSeq,
        payload: {},
      });
      expect(result.ok).toBe(true);
    }
    expect(actor.state.status).toBe('ACTIVE');
    expect(actor.state.handNumber).toBe(2);
  });

  it('projects the exact actor, table positions, and betting shortcut inputs', async () => {
    const { actor, a } = await readyTable('ONLINE');
    const snapshot = actor.snapshot(a.id).public as unknown as {
      actingSeat: number | null;
      readyCount: number;
      requiredReadyCount: number;
      seats: Array<{ positions?: string[] }>;
      prompt: {
        playerId: string;
        currentBet: number;
        committedStreet: number;
        potBeforeAction: number;
        raiseDepth: number;
      } | null;
    };
    expect(snapshot.actingSeat).not.toBeNull();
    expect(snapshot.prompt?.playerId).toBe(actor.state.hand?.betting.actorId);
    expect(snapshot.prompt?.currentBet).toBe(actor.state.settings.bigBlind);
    expect(snapshot.prompt?.potBeforeAction).toBe(
      actor.state.settings.smallBlind + actor.state.settings.bigBlind,
    );
    expect(snapshot.prompt?.raiseDepth).toBe(0);
    expect(snapshot.seats.flatMap((seat) => seat.positions ?? [])).toEqual(
      expect.arrayContaining(['BTN', 'SB', 'BB']),
    );

    let hand = actor.state.hand!;
    let result = await actor.act(hand.betting.actorId!, {
      commandId: randomUUID(),
      expectedSeq: actor.state.serverSeq,
      turnToken: hand.turnToken!,
      payload: { action: 'RAISE_TO', amountTo: 50 },
    });
    expect(result.ok).toBe(true);
    expect(actor.state.hand?.raiseDepth).toBe(1);
    hand = actor.state.hand!;
    result = await actor.act(hand.betting.actorId!, {
      commandId: randomUUID(),
      expectedSeq: actor.state.serverSeq,
      turnToken: hand.turnToken!,
      payload: { action: 'RAISE_TO', amountTo: 150 },
    });
    expect(result.ok).toBe(true);
    expect(actor.state.hand?.raiseDepth).toBe(2);
  });

  it('lets an admin adjust stacks only between hands and kick or restore a member', async () => {
    const { actor, repository, a, b } = await readyTable('ONLINE');
    const rejected = await actor.adminAdjustStack(
      '00000000-0000-4000-8000-000000000099',
      a.id,
      3_000,
      '测试',
      randomUUID(),
    );
    expect(rejected).toMatchObject({ ok: false, code: 'CONFLICT' });

    const hand = actor.state.hand!;
    await actor.act(hand.betting.actorId!, {
      commandId: randomUUID(),
      expectedSeq: actor.state.serverSeq,
      turnToken: hand.turnToken!,
      payload: { action: 'FOLD' },
    });
    const adjusted = await actor.adminAdjustStack(
      '00000000-0000-4000-8000-000000000099',
      a.id,
      3_000,
      '朋友局修正',
      randomUUID(),
    );
    expect(adjusted).toMatchObject({ ok: true, playerId: a.id, stack: 3_000 });
    expect(actor.state.players.every((player) => !player.ready)).toBe(true);
    expect(repository.commits.at(-1)?.ledgerMutations).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'ADMIN_ADJUSTMENT' })]),
    );

    const kicked = await actor.adminKickPlayer(
      '00000000-0000-4000-8000-000000000099',
      b.id,
      '离开本桌',
      randomUUID(),
    );
    expect(kicked).toMatchObject({ ok: true, membershipStatus: 'KICKED' });
    expect(actor.state.players.find((player) => player.id === b.id)?.seat).toBeNull();
    expect(actor.snapshot(b.id).private).toBeNull();
    expect(
      repository.commits.at(-1)?.playerMutations.find((mutation) => mutation.playerId === b.id),
    ).toMatchObject({ membershipStatus: 'KICKED', seat: null, connected: false });

    actor.state.players.find((player) => player.id === a.id)!.nickname = b.nickname.toLowerCase();
    const duplicateNickname = await actor.adminReinstatePlayer(
      '00000000-0000-4000-8000-000000000099',
      b.id,
      randomUUID(),
    );
    expect(duplicateNickname).toMatchObject({
      ok: false,
      code: 'CONFLICT',
      message: '该昵称已被其他有效玩家使用',
    });
    actor.state.players.find((player) => player.id === a.id)!.nickname = 'A';

    const restored = await actor.adminReinstatePlayer(
      '00000000-0000-4000-8000-000000000099',
      b.id,
      randomUUID(),
    );
    expect(restored).toMatchObject({ ok: true, membershipStatus: 'ACTIVE' });
  });

  it('finishes the current hand before applying a scheduled kick', async () => {
    const { actor } = await readyTable('ONLINE');
    const actorId = actor.state.hand!.betting.actorId!;
    const scheduled = await actor.adminKickPlayer(
      '00000000-0000-4000-8000-000000000099',
      actorId,
      '本手后离桌',
      randomUUID(),
    );
    expect(scheduled).toMatchObject({ ok: true, membershipStatus: 'KICK_PENDING', pending: true });
    const hand = actor.state.hand!;
    const result = await actor.act(actorId, {
      commandId: randomUUID(),
      expectedSeq: actor.state.serverSeq,
      turnToken: hand.turnToken!,
      payload: { action: 'FOLD' },
    });
    expect(result.ok).toBe(true);
    expect(actor.state.players.find((player) => player.id === actorId)?.membershipStatus).toBe(
      'KICKED',
    );
  });

  it('runs LIVE street confirmations, objection, unanimous replacement, and settlement', async () => {
    const { actor } = await readyTable('LIVE');
    await driveLiveToShowdown(actor);
    const hand = actor.state.hand!;
    const dealerSeat = actor.snapshot(actor.state.players[0]!.id).public.liveDealerSeat;
    const dealer = actor.state.players.find((player) => player.seat === dealerSeat)!;
    const winnersByPot = Object.fromEntries(
      hand.sidePotBuild!.pots.map((pot) => [`pot-${pot.index}`, [pot.eligiblePlayerIds[0]!]]),
    );
    let result = await actor.liveResultPropose(dealer.id, {
      commandId: randomUUID(),
      expectedSeq: actor.state.serverSeq,
      payload: { winnersByPot },
    });
    expect(result.ok).toBe(true);
    const firstProposal = hand.liveProposal!;
    const objector = actor.state.players.find(
      (player) =>
        player.id !== dealer.id &&
        hand.sidePotBuild!.pots.some((pot) => pot.eligiblePlayerIds.includes(player.id)),
    )!;
    result = await actor.liveResultObject(objector.id, {
      commandId: randomUUID(),
      expectedSeq: actor.state.serverSeq,
      payload: { proposalId: firstProposal.id },
    });
    expect(result.ok).toBe(true);
    result = await actor.liveResultPropose(dealer.id, {
      commandId: randomUUID(),
      expectedSeq: actor.state.serverSeq,
      payload: { winnersByPot },
    });
    expect(result.ok).toBe(true);
    const replacement = hand.liveProposal!;
    result = await actor.liveResultConfirm(objector.id, {
      commandId: randomUUID(),
      expectedSeq: actor.state.serverSeq,
      payload: { proposalId: replacement.id },
    });
    expect(result.ok).toBe(true);
    expect(actor.state.status).toBe('BETWEEN_HANDS');
    expect(actor.state.players.reduce((sum, player) => sum + player.stack, 0)).toBe(4_000);
  });

  it('auto-settles an unopposed LIVE proposal exactly once', async () => {
    vi.useFakeTimers();
    try {
      const { actor, repository } = await readyTable('LIVE');
      await driveLiveToShowdown(actor);
      const hand = actor.state.hand!;
      const dealerSeat = actor.snapshot(actor.state.players[0]!.id).public.liveDealerSeat;
      const dealer = actor.state.players.find((player) => player.seat === dealerSeat)!;
      const winnersByPot = Object.fromEntries(
        hand.sidePotBuild!.pots.map((pot) => [`pot-${pot.index}`, [pot.eligiblePlayerIds[0]!]]),
      );
      const proposed = await actor.liveResultPropose(dealer.id, {
        commandId: randomUUID(),
        expectedSeq: actor.state.serverSeq,
        payload: { winnersByPot },
      });
      expect(proposed.ok).toBe(true);
      await vi.advanceTimersByTimeAsync(10_001);
      expect(actor.state.status).toBe('BETWEEN_HANDS');
      expect(actor.state.hand?.liveProposal).toBeNull();
      const settlements = repository.commits.filter(
        (commit) => commit.event.type === 'HAND_SETTLED',
      ).length;
      expect(settlements).toBe(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(
        repository.commits.filter((commit) => commit.event.type === 'HAND_SETTLED'),
      ).toHaveLength(settlements);
    } finally {
      vi.useRealTimers();
    }
  });
});
