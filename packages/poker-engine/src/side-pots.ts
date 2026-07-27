import { assertChipAmount } from './chips.js';
import { compareHandRanks, type HandRank } from './hand-rank.js';

export interface PotContribution {
  readonly playerId: string;
  readonly amount: number;
  readonly folded: boolean;
}

export interface SidePot {
  readonly index: number;
  readonly cap: number;
  readonly amount: number;
  readonly contributorIds: readonly string[];
  readonly eligiblePlayerIds: readonly string[];
}

export interface PotRefund {
  readonly playerId: string;
  readonly amount: number;
}

export interface SidePotBuild {
  readonly pots: readonly SidePot[];
  readonly refunds: readonly PotRefund[];
  readonly totalContributed: number;
}

export interface PotShare {
  readonly playerId: string;
  readonly amount: number;
}

export interface PotAward {
  readonly potIndex: number;
  readonly amount: number;
  readonly winnerIds: readonly string[];
  readonly shares: readonly PotShare[];
}

export interface PlayerPayout {
  readonly playerId: string;
  readonly amount: number;
}

export interface PotSettlement {
  readonly awards: readonly PotAward[];
  readonly refunds: readonly PotRefund[];
  readonly payouts: readonly PlayerPayout[];
  readonly totalPaid: number;
}

function addAmount(amounts: Map<string, number>, playerId: string, amount: number): void {
  amounts.set(playerId, (amounts.get(playerId) ?? 0) + amount);
}

export function buildSidePots(contributions: readonly PotContribution[]): SidePotBuild {
  if (
    new Set(contributions.map((contribution) => contribution.playerId)).size !==
    contributions.length
  ) {
    throw new RangeError('contribution player ids must be unique');
  }
  for (const contribution of contributions) {
    if (contribution.playerId.length === 0) {
      throw new RangeError('player id must not be empty');
    }
    assertChipAmount(contribution.amount, `contribution for ${contribution.playerId}`);
  }

  const positive = contributions.filter((contribution) => contribution.amount > 0);
  const caps = [...new Set(positive.map((contribution) => contribution.amount))].sort(
    (left, right) => left - right,
  );
  const pots: Array<SidePot & { amount: number }> = [];
  const refunds = new Map<string, number>();
  let previousCap = 0;
  // Legal betting sequences cannot produce a multi-contributor layer where
  // every contributor has folded, but this construction must never lose chips
  // even on impossible input: such a layer's amount is dead money, folded into
  // the nearest pot that does have a contender.
  let orphanAmount = 0;
  const orphanLayers: Array<{ contributorIds: string[]; portion: number }> = [];

  for (const cap of caps) {
    const layerContributors = positive.filter((contribution) => contribution.amount >= cap);
    const layerAmount = (cap - previousCap) * layerContributors.length;

    if (layerContributors.length === 1) {
      addAmount(refunds, layerContributors[0]!.playerId, layerAmount);
    } else if (layerAmount > 0) {
      const eligiblePlayerIds = layerContributors
        .filter((contribution) => !contribution.folded)
        .map((contribution) => contribution.playerId);
      if (eligiblePlayerIds.length === 0) {
        orphanAmount += layerAmount;
        orphanLayers.push({
          contributorIds: layerContributors.map((contribution) => contribution.playerId),
          portion: cap - previousCap,
        });
      } else {
        pots.push({
          index: pots.length,
          cap,
          amount: layerAmount + orphanAmount,
          contributorIds: layerContributors.map((contribution) => contribution.playerId),
          eligiblePlayerIds,
        });
        orphanAmount = 0;
        orphanLayers.length = 0;
      }
    }
    previousCap = cap;
  }

  if (orphanAmount > 0) {
    const lastPot = pots[pots.length - 1];
    if (lastPot) {
      lastPot.amount += orphanAmount;
    } else {
      // Degenerate fallback: no pot anywhere has a contender, so hand the
      // orphaned layers back to their contributors.
      for (const layer of orphanLayers) {
        for (const contributorId of layer.contributorIds) {
          addAmount(refunds, contributorId, layer.portion);
        }
      }
    }
  }

  const refundList = [...refunds.entries()].map(([playerId, amount]) => ({ playerId, amount }));
  const totalContributed = contributions.reduce(
    (sum, contribution) => sum + contribution.amount,
    0,
  );
  const accountedFor =
    pots.reduce((sum, pot) => sum + pot.amount, 0) +
    refundList.reduce((sum, refund) => sum + refund.amount, 0);
  if (accountedFor !== totalContributed) {
    throw new Error('side-pot construction did not conserve chips');
  }

  return { pots, refunds: refundList, totalContributed };
}

function winningPlayers(pot: SidePot, ranks: ReadonlyMap<string, HandRank>): readonly string[] {
  if (pot.eligiblePlayerIds.length === 1) {
    return [pot.eligiblePlayerIds[0]!];
  }

  let best: HandRank | null = null;
  const winners: string[] = [];
  for (const playerId of pot.eligiblePlayerIds) {
    const rank = ranks.get(playerId);
    if (rank === undefined) {
      throw new RangeError(`missing hand rank for eligible player ${playerId}`);
    }
    const comparison = best === null ? 1 : compareHandRanks(rank, best);
    if (comparison > 0) {
      best = rank;
      winners.length = 0;
      winners.push(playerId);
    } else if (comparison === 0) {
      winners.push(playerId);
    }
  }
  return winners;
}

export function settleSidePots(
  build: SidePotBuild,
  ranks: ReadonlyMap<string, HandRank>,
  oddChipOrder: readonly string[],
): PotSettlement {
  if (new Set(oddChipOrder).size !== oddChipOrder.length) {
    throw new RangeError('odd-chip order must not contain duplicates');
  }
  const order = new Map(oddChipOrder.map((playerId, index) => [playerId, index]));
  const payouts = new Map<string, number>();
  const awards: PotAward[] = [];

  for (const refund of build.refunds) {
    addAmount(payouts, refund.playerId, refund.amount);
  }

  for (const pot of build.pots) {
    const winners = [...winningPlayers(pot, ranks)];
    for (const winner of winners) {
      if (!order.has(winner)) {
        throw new RangeError(`odd-chip order is missing eligible winner ${winner}`);
      }
    }
    winners.sort((left, right) => order.get(left)! - order.get(right)!);

    const equalShare = Math.floor(pot.amount / winners.length);
    let oddChips = pot.amount % winners.length;
    const shares = winners.map((playerId) => {
      const amount = equalShare + (oddChips > 0 ? 1 : 0);
      oddChips = Math.max(0, oddChips - 1);
      addAmount(payouts, playerId, amount);
      return { playerId, amount };
    });
    awards.push({ potIndex: pot.index, amount: pot.amount, winnerIds: winners, shares });
  }

  const payoutList = [...payouts.entries()].map(([playerId, amount]) => ({ playerId, amount }));
  const totalPaid = payoutList.reduce((sum, payout) => sum + payout.amount, 0);
  if (totalPaid !== build.totalContributed) {
    throw new Error('pot settlement did not conserve chips');
  }

  return { awards, refunds: build.refunds, payouts: payoutList, totalPaid };
}
