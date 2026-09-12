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
  const synchronizedRef = useRef(false);
  const sessionRef = useRef(0);
  const roomRef = useRef<PublicRoomProjection | null>(null);
  const meRef = useRef<PrivatePlayerProjection | null>(null);

  const applySnapshot = useCallback(
    (snapshot: RoomSnapshotEnvelope): boolean => {
      if (revokedRef.current) return false;
      if (snapshot.public.roomId !== roomId) {
        setError('当前会话与牌桌不匹配');
        return false;
      }
      if (snapshot.public.serverSeq < (roomRef.current?.serverSeq ?? -1)) return false;
      roomRef.current = snapshot.public;
      meRef.current = snapshot.private;
      setRoom(snapshot.public);
      setMe(snapshot.private);
      setLoading(false);
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
    const session = sessionRef.current;
    const isCurrent = () => session === sessionRef.current && !revokedRef.current;
    try {
      const snapshot = await api<RoomSnapshotEnvelope>(
        adminView ? `/api/admin/rooms/${roomId}/snapshot` : `/api/rooms/${roomId}`,
      );
      if (!isCurrent()) return;
      const applied = applySnapshot(snapshot);
      if (adminView && applied) setConnected(true);
    } catch (caught) {
      if (!isCurrent()) return;
      if (adminView) setConnected(false);
      setError(caught instanceof Error ? caught.message : '牌桌同步失败');
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [adminView, applySnapshot, roomId]);

  useEffect(() => {
    // Requests and acknowledgements may finish after the room or view changes.
    const session = ++sessionRef.current;
    const isCurrent = () => session === sessionRef.current && !revokedRef.current;
    roomRef.current = null;
    meRef.current = null;
    pendingRef.current = false;
    revokedRef.current = false;
    synchronizedRef.current = false;
    setRoom(null);
    setMe(null);
    setConnected(false);
    setBusy(false);
    setLoading(true);
    setError(null);
    void refresh();
    if (adminView) {
      const poll = window.setInterval(() => void refresh(), 2_000);
      return () => {
        sessionRef.current += 1;
        window.clearInterval(poll);
      };
    }
    const socket = io({
      path: '/socket.io/',
      auth: { roomId },
      withCredentials: true,
      transports: ['websocket', 'polling'],
      reconnection: true,
      autoConnect: false,
    });
    let browserOnline = navigator.onLine !== false;
    socketRef.current = socket;
    socket.on('connect', () => {
      if (!isCurrent()) return;
      synchronizedRef.current = false;
      setConnected(false);
    });
    socket.on('disconnect', () => {
      if (!isCurrent()) return;
      synchronizedRef.current = false;
      setConnected(false);
    });
    socket.on('connect_error', () => {
      if (isCurrent() && browserOnline) setError('连接失败，正在重试');
    });
    socket.on('membership.revoked', (payload: { roomId?: string }) => {
      if (!isCurrent()) return;
      if (payload.roomId && payload.roomId !== roomId) return;
      revokedRef.current = true;
      synchronizedRef.current = false;
      meRef.current = null;
      pendingRef.current = false;
      setMe(null);
      setBusy(false);
      setLoading(false);
      setConnected(false);
      setError('你已被移出牌桌');
      socket.io.opts.reconnection = false;
      socket.disconnect();
    });
    socket.on('room.snapshot', (snapshot: RoomSnapshotEnvelope) => {
      if (!isCurrent() || !browserOnline) return;
      const applied = applySnapshot(snapshot);
      if (!applied && snapshot.public.roomId !== roomId) {
        socket.disconnect();
        return;
      }
      // The server installs command handlers as it finishes sending this snapshot.
      synchronizedRef.current = true;
      setConnected(true);
    });
    socket.on('room.public', (next: PublicRoomProjection) => {
      if (isCurrent()) applyPublic(next);
    });
    socket.on('room.private', (next: PrivatePlayerProjection) => {
      if (!isCurrent() || next.roomId !== roomId) return;
      meRef.current = next;
      setMe(next);
    });
    socket.on('room.error', (next: { message?: string }) => {
      if (isCurrent()) setError(next.message ?? '牌桌已暂停');
    });
    const onOffline = () => {
      if (!isCurrent()) return;
      browserOnline = false;
      synchronizedRef.current = false;
      setConnected(false);
      setError('网络已断开，等待重新连接');
      socket.disconnect();
    };
    const onOnline = () => {
      if (!isCurrent()) return;
      browserOnline = true;
      synchronizedRef.current = false;
      setConnected(false);
      socket.connect();
    };
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    if (browserOnline) socket.connect();
    else onOffline();
    return () => {
      sessionRef.current += 1;
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
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
      const session = sessionRef.current;
      const currentRoom = roomRef.current;
      const currentMe = meRef.current;
      if (pendingRef.current) {
        setError('操作处理中，请稍候');
        return false;
      }
      if (
        adminView ||
        revokedRef.current ||
        !synchronizedRef.current ||
        !socket?.connected ||
        currentRoom?.roomId !== roomId
      ) {
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
            if (session !== sessionRef.current || revokedRef.current) {
              resolve(false);
              return;
            }
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
    [adminView, applySnapshot, refresh, roomId],
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
