import type { FastifyInstance } from 'fastify';
import { parse as parseCookie } from 'cookie';
import { Server, type Socket } from 'socket.io';
import type { ZodType } from 'zod';
import {
  emptyCommandSchema,
  handActionCommandSchema,
  identifierSchema,
  liveResultProposalIdCommandSchema,
  liveResultProposeCommandSchema,
  liveStreetDealtCommandSchema,
  seatClaimCommandSchema,
  topUpCommandSchema,
  type CommandFailure,
  type CommandResult,
} from '@poker-with-friends/protocol';
import type { AppConfig } from '../config.js';
import type { PokerRepository } from '../repository.js';
import type { RoomManager } from '../room/manager.js';
import { PLAYER_COOKIE } from '../security/cookies.js';
import { safeErrorLogContext } from '../security/logging.js';
import { isAllowedBrowserOrigin } from '../security/origin.js';

interface SocketData {
  playerId: string;
  roomId: string;
}

interface SocketDependencies {
  config: AppConfig;
  repository: PokerRepository;
  rooms: RoomManager;
}

type Ack = (result: CommandResult) => void;

const badRequest = (message: string): CommandFailure => ({
  ok: false,
  code: 'BAD_REQUEST',
  message,
});

const commandBusy = (): CommandFailure => ({
  ok: false,
  code: 'CONFLICT',
  message: '操作过于频繁，请等待前面的命令完成',
});

export function registerSocketServer(app: FastifyInstance, deps: SocketDependencies): Server {
  const io = new Server(app.server, {
    path: '/socket.io/',
    serveClient: false,
    cors: { origin: deps.config.PUBLIC_ORIGIN, credentials: true },
    allowRequest: (request, callback) =>
      callback(null, isAllowedBrowserOrigin(request.headers.origin, deps.config.PUBLIC_ORIGIN)),
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1_000,
      skipMiddlewares: false,
    },
    maxHttpBufferSize: 64 * 1_024,
    transports: ['websocket', 'polling'],
  });

  deps.rooms.setProjectionListener((roomId, projections) => {
    io.to(`room:${roomId}`).emit('room.public', projections.public);
    for (const [playerId, privateProjection] of Object.entries(projections.privateByPlayerId)) {
      io.to(`player:${playerId}`).emit('room.private', privateProjection);
    }
    for (const playerId of projections.revokedPlayerIds) {
      io.to(`player:${playerId}`).emit('membership.revoked', { roomId });
      void io
        .in(`player:${playerId}`)
        .fetchSockets()
        .then((sockets) => sockets.forEach((socket) => socket.disconnect(true)))
        .catch((error: unknown) =>
          app.log.error(
            { failure: safeErrorLogContext(error), roomId, playerId },
            'failed to disconnect kicked player',
          ),
        );
    }
  });

  io.use(async (socket, next) => {
    try {
      const cookies = parseCookie(socket.request.headers.cookie ?? '');
      const requestedRoomId = socket.handshake.auth?.roomId;
      if (!identifierSchema.safeParse(requestedRoomId).success) {
        return next(new Error('ROOM_REQUIRED'));
      }
      const player = await deps.repository.getPlayerBySession(
        cookies[PLAYER_COOKIE],
        requestedRoomId,
      );
      if (!player) return next(new Error('UNAUTHORIZED'));
      (socket.data as SocketData).playerId = player.id;
      (socket.data as SocketData).roomId = player.roomId;
      return next();
    } catch (error) {
      return next(error instanceof Error ? error : new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', async (socket: Socket) => {
    const { playerId, roomId } = socket.data as SocketData;
    await socket.join([`room:${roomId}`, `player:${playerId}`]);
    try {
      await deps.rooms.setConnected(roomId, playerId, true);
      socket.emit('room.snapshot', await deps.rooms.snapshot(roomId, playerId));
    } catch (error) {
      app.log.error(
        { failure: safeErrorLogContext(error), roomId, playerId },
        'socket room recovery failed',
      );
      socket.emit('room.error', { code: 'ROOM_FROZEN', message: '牌局恢复失败，禁止继续行动' });
      socket.disconnect(true);
      return;
    }

    let commandsInFlight = 0;
    const command = <T>(
      event: string,
      schema: ZodType<T>,
      handler: (value: T) => Promise<CommandResult>,
    ) => {
      socket.on(event, async (input: unknown, ack?: Ack) => {
        if (commandsInFlight >= 8) {
          if (typeof ack === 'function') ack(commandBusy());
          return;
        }
        commandsInFlight += 1;
        let result: CommandResult;
        try {
          const parsed = schema.safeParse(input);
          result = parsed.success
            ? await handler(parsed.data)
            : badRequest(parsed.error.issues.map((issue) => issue.message).join('; '));
        } catch (error) {
          app.log.error(
            {
              failure: safeErrorLogContext(error),
              roomId,
              playerId,
              event,
            },
            'socket command failed',
          );
          result = { ok: false, code: 'INTERNAL_ERROR', message: '服务器暂时无法处理操作' };
        } finally {
          commandsInFlight -= 1;
        }
        if (typeof ack === 'function') ack(result);
      });
    };

    command('seat.claim', seatClaimCommandSchema, (value) =>
      deps.rooms.seatClaim(roomId, playerId, value),
    );
    command('player.ready', emptyCommandSchema, (value) =>
      deps.rooms.ready(roomId, playerId, value),
    );
    command('player.sitOut', emptyCommandSchema, (value) =>
      deps.rooms.sitOut(roomId, playerId, value),
    );
    command('stack.topUp', topUpCommandSchema, (value) =>
      deps.rooms.topUp(roomId, playerId, value),
    );
    command('hand.act', handActionCommandSchema, (value) =>
      deps.rooms.act(roomId, playerId, value),
    );
    command('live.streetDealt', liveStreetDealtCommandSchema, (value) =>
      deps.rooms.liveStreetDealt(roomId, playerId, value),
    );
    command('live.resultPropose', liveResultProposeCommandSchema, (value) =>
      deps.rooms.liveResultPropose(roomId, playerId, value),
    );
    command('live.resultObject', liveResultProposalIdCommandSchema, (value) =>
      deps.rooms.liveResultObject(roomId, playerId, value),
    );
    command('live.resultConfirm', liveResultProposalIdCommandSchema, (value) =>
      deps.rooms.liveResultConfirm(roomId, playerId, value),
    );

    socket.on('disconnect', () => {
      setImmediate(async () => {
        try {
          const remaining = await io.in(`player:${playerId}`).fetchSockets();
          if (remaining.length === 0) {
            await deps.rooms.setConnected(roomId, playerId, false);
          }
        } catch (error) {
          app.log.error(
            { failure: safeErrorLogContext(error), roomId, playerId },
            'failed to persist disconnect',
          );
        }
      });
    });
  });

  return io;
}
