import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type {
  CommandResult,
  PrivatePlayerProjection,
  PublicRoomProjection,
  RoomSnapshotEnvelope,
} from '@poker-with-friends/protocol';
import { api } from './api';

export interface RoomConnection {
  room: PublicRoomProjection | null;
  me: PrivatePlayerProjection | null;
  connected: boolean;
  busy: boolean;
  loading: boolean;
  error: string | null;
  clearError: () => void;
  send: (
    event: string,
    payload?: Record<string, unknown>,
    options?: { needsTurnToken?: boolean },
  ) => Promise<boolean>;
  refresh: () => Promise<void>;
}

function commandErrorMessage(code: string, message: string): string {
  if (code === 'STALE_SEQUENCE' || code === 'STALE_TURN') {
    return '牌桌状态已更新，请重试';
  }
  if (code === 'INTERNAL_ERROR') return '操作失败，请重试';
  return message;
}

export function useRoom(roomId: string, adminView = false): RoomConnection {
  const [room, setRoom] = useState<PublicRoomProjection | null>(null);
  const [me, setMe] = useState<PrivatePlayerProjection | null>(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const pendingRef = useRef(false);
  const revokedRef = useRef(false);
  const roomRef = useRef<PublicRoomProjection | null>(null);
  const meRef = useRef<PrivatePlayerProjection | null>(null);

  useEffect(() => {
    roomRef.current = room;
  }, [room]);
  useEffect(() => {
    meRef.current = me;
  }, [me]);

  const applySnapshot = useCallback(
    (snapshot: RoomSnapshotEnvelope): boolean => {
      if (snapshot.public.roomId !== roomId) {
        setError('当前会话与牌桌不匹配');
        return false;
      }
      if (snapshot.public.serverSeq < (roomRef.current?.serverSeq ?? -1)) return false;
      roomRef.current = snapshot.public;
      meRef.current = snapshot.private;
      setRoom(snapshot.public);
      setMe(snapshot.private);
      setError(null);
      return true;
    },
    [roomId],
  );

  const applyPublic = useCallback(
    (next: PublicRoomProjection): void => {
      if (next.roomId !== roomId) {
        setError('牌桌连接异常');
        return;
      }
      if (next.serverSeq < (roomRef.current?.serverSeq ?? -1)) return;
      roomRef.current = next;
      setRoom(next);
    },
    [roomId],
  );

  const refresh = useCallback(async () => {
    try {
      applySnapshot(
        await api<RoomSnapshotEnvelope>(
          adminView ? `/api/admin/rooms/${roomId}/snapshot` : `/api/rooms/${roomId}`,
        ),
      );
      if (adminView) setConnected(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '牌桌同步失败');
    } finally {
      setLoading(false);
    }
  }, [adminView, applySnapshot, roomId]);

  useEffect(() => {
    void refresh();
    if (adminView) {
      const poll = window.setInterval(() => void refresh(), 2_000);
      return () => {
        window.clearInterval(poll);
        setConnected(false);
      };
    }
    const socket = io({
      path: '/socket.io/',
      auth: { roomId },
      withCredentials: true,
      transports: ['websocket', 'polling'],
      reconnection: true,
    });
    revokedRef.current = false;
    socketRef.current = socket;
    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => {
      if (!revokedRef.current) setError('连接失败，正在重试');
    });
    socket.on('membership.revoked', (payload: { roomId?: string }) => {
      if (payload.roomId && payload.roomId !== roomId) return;
      revokedRef.current = true;
      meRef.current = null;
      setMe(null);
      setConnected(false);
      setError('你已被移出牌桌');
      socket.io.opts.reconnection = false;
      socket.disconnect();
    });
    socket.on('room.snapshot', (snapshot: RoomSnapshotEnvelope) => {
      if (!applySnapshot(snapshot) && snapshot.public.roomId !== roomId) socket.disconnect();
    });
    socket.on('room.public', applyPublic);
    socket.on('room.private', (next: PrivatePlayerProjection) => {
      if (next.roomId !== roomId) return;
      meRef.current = next;
      setMe(next);
    });
    socket.on('room.error', (next: { message?: string }) => setError(next.message ?? '牌桌已暂停'));
    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [adminView, applyPublic, applySnapshot, refresh, roomId]);

  const send = useCallback(
    async (
      event: string,
      payload: Record<string, unknown> = {},
      options: { needsTurnToken?: boolean } = {},
    ): Promise<boolean> => {
      const socket = socketRef.current;
      const currentRoom = roomRef.current;
      const currentMe = meRef.current;
      if (pendingRef.current) {
        setError('操作处理中，请稍候');
        return false;
      }
      if (!socket?.connected || !currentRoom) {
        setError('连接尚未就绪');
        return false;
      }
      const envelope: Record<string, unknown> = {
        commandId: crypto.randomUUID(),
        expectedSeq: currentRoom.serverSeq,
        payload,
      };
      if (options.needsTurnToken) {
        if (!currentMe?.turnToken) {
          setError('牌桌状态已更新，请重试');
          await refresh();
          return false;
        }
        envelope.turnToken = currentMe.turnToken;
      }
      pendingRef.current = true;
      setBusy(true);
      return new Promise<boolean>((resolve) => {
        socket
          .timeout(8_000)
          .emit(event, envelope, (timeoutError: Error | null, result?: CommandResult) => {
            if (timeoutError || !result) {
              pendingRef.current = false;
              setBusy(false);
              setError('操作超时，正在重新同步');
              void refresh();
              resolve(false);
              return;
            }
            if (!result.ok) {
              pendingRef.current = false;
              setBusy(false);
              setError(commandErrorMessage(result.code, result.message));
              if (result.code === 'STALE_SEQUENCE' || result.code === 'STALE_TURN') void refresh();
              resolve(false);
              return;
            }
            applySnapshot(result.data);
            pendingRef.current = false;
            setBusy(false);
            resolve(true);
          });
      });
    },
    [applySnapshot, refresh],
  );

  return {
    room,
    me,
    connected,
    busy,
    loading,
    error,
    clearError: () => setError(null),
    send,
    refresh,
  };
}
