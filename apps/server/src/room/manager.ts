import type {
  CommandResult,
  EmptyCommand,
  HandActionCommand,
  LiveResultProposalIdCommand,
  LiveResultProposeCommand,
  LiveStreetDealtCommand,
  PublicRoomProjection,
  RoomSnapshotEnvelope,
  SeatClaimCommand,
  TopUpCommand,
} from '@poker-with-friends/protocol';
import type { PokerRepository } from '../repository.js';
import { RoomActor, type AdminPlayerOperationResult } from './actor.js';
import type { ProjectionBundle } from './state.js';

type ProjectionListener = (roomId: string, projection: ProjectionBundle) => void;

export class RoomManager {
  private readonly actors = new Map<string, Promise<RoomActor>>();
  private listener: ProjectionListener = () => undefined;

  public constructor(private readonly repository: PokerRepository) {}

  public setProjectionListener(listener: ProjectionListener): void {
    this.listener = listener;
  }

  private async actor(roomId: string): Promise<RoomActor> {
    let actorPromise = this.actors.get(roomId);
    if (!actorPromise) {
      actorPromise = this.repository.loadRoom(roomId).then((loaded) => {
        if (!loaded) throw new Error('ROOM_NOT_FOUND');
        return new RoomActor(loaded, this.repository, (id, projection) =>
          this.listener(id, projection),
        );
      });
      this.actors.set(roomId, actorPromise);
      actorPromise.catch(() => this.actors.delete(roomId));
    }
    return actorPromise;
  }

  public async refreshPlayers(roomId: string): Promise<void> {
    const loaded = await this.repository.loadRoom(roomId);
    if (!loaded) throw new Error('ROOM_NOT_FOUND');
    await (await this.actor(roomId)).refreshPlayers(loaded);
  }

  public async snapshot(roomId: string, playerId: string): Promise<RoomSnapshotEnvelope> {
    const actor = await this.actor(roomId);
    if (!actor.hasPlayer(playerId)) throw new Error('PLAYER_NOT_IN_ROOM');
    return actor.snapshot(playerId);
  }

  public async adminSnapshot(roomId: string): Promise<PublicRoomProjection> {
    return (await this.actor(roomId)).adminSnapshot();
  }

  public async setConnected(roomId: string, playerId: string, connected: boolean): Promise<void> {
    await (await this.actor(roomId)).setConnected(playerId, connected);
  }

  public async seatClaim(
    roomId: string,
    playerId: string,
    command: SeatClaimCommand,
  ): Promise<CommandResult> {
    return (await this.actor(roomId)).seatClaim(playerId, command);
  }

  public async ready(
    roomId: string,
    playerId: string,
    command: EmptyCommand,
  ): Promise<CommandResult> {
    return (await this.actor(roomId)).ready(playerId, command);
  }

  public async sitOut(
    roomId: string,
    playerId: string,
    command: EmptyCommand,
  ): Promise<CommandResult> {
    return (await this.actor(roomId)).sitOut(playerId, command);
  }

  public async topUp(
    roomId: string,
    playerId: string,
    command: TopUpCommand,
  ): Promise<CommandResult> {
    return (await this.actor(roomId)).topUp(playerId, command);
  }

  public async act(
    roomId: string,
    playerId: string,
    command: HandActionCommand,
  ): Promise<CommandResult> {
    return (await this.actor(roomId)).act(playerId, command);
  }

  public async liveStreetDealt(
    roomId: string,
    playerId: string,
    command: LiveStreetDealtCommand,
  ): Promise<CommandResult> {
    return (await this.actor(roomId)).liveStreetDealt(playerId, command);
  }

  public async liveResultPropose(
    roomId: string,
    playerId: string,
    command: LiveResultProposeCommand,
  ): Promise<CommandResult> {
    return (await this.actor(roomId)).liveResultPropose(playerId, command);
  }

  public async liveResultObject(
    roomId: string,
    playerId: string,
    command: LiveResultProposalIdCommand,
  ): Promise<CommandResult> {
    return (await this.actor(roomId)).liveResultObject(playerId, command);
  }

  public async liveResultConfirm(
    roomId: string,
    playerId: string,
    command: LiveResultProposalIdCommand,
  ): Promise<CommandResult> {
    return (await this.actor(roomId)).liveResultConfirm(playerId, command);
  }

  public async adminArchive(roomId: string, adminId: string): Promise<boolean> {
    return (await this.actor(roomId)).adminArchive(adminId);
  }

  public async adminAdjustStack(
    roomId: string,
    adminId: string,
    playerId: string,
    targetStack: number,
    reason: string,
    operationId: string,
  ): Promise<AdminPlayerOperationResult> {
    return (await this.actor(roomId)).adminAdjustStack(
      adminId,
      playerId,
      targetStack,
      reason,
      operationId,
    );
  }

  public async adminKickPlayer(
    roomId: string,
    adminId: string,
    playerId: string,
    reason: string,
    operationId: string,
  ): Promise<AdminPlayerOperationResult> {
    return (await this.actor(roomId)).adminKickPlayer(adminId, playerId, reason, operationId);
  }

  public async adminReinstatePlayer(
    roomId: string,
    adminId: string,
    playerId: string,
    operationId: string,
  ): Promise<AdminPlayerOperationResult> {
    return (await this.actor(roomId)).adminReinstatePlayer(adminId, playerId, operationId);
  }

  public async adminForceAbort(roomId: string, adminId: string): Promise<boolean> {
    return (await this.actor(roomId)).adminForceAbort(adminId);
  }

  public async archiveIdleRooms(): Promise<number> {
    const idleRooms = await this.repository.findIdleRooms();
    let archived = 0;
    for (const room of idleRooms) {
      const actor = await this.actor(room.id);
      const ok =
        room.status === 'ACTIVE' || room.status === 'DISPUTED'
          ? await actor.adminForceAbort('SYSTEM_IDLE_TIMEOUT')
          : await actor.adminArchive('SYSTEM_IDLE_TIMEOUT');
      if (ok) archived += 1;
    }
    return archived;
  }
}
