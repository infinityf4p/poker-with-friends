import type {
  AdminRoomPlayerSummary,
  AdminRoomSummary,
  AdminUserSummary,
  LobbyRoomSummary,
  RoomMode,
  RoomSettings,
  RoomStatus,
  UserRoomSummary,
  UserSession,
} from '@poker-with-friends/protocol';

export class ApiError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
    public readonly body: unknown,
  ) {
    super(message);
  }
}

function responseErrorMessage(status: number, body: unknown): string {
  if (!body || typeof body !== 'object') return `请求失败 (${status})`;
  if ('message' in body && typeof body.message === 'string') return body.message;
  if ('issues' in body && Array.isArray(body.issues)) {
    const firstIssue = body.issues[0];
    if (
      firstIssue &&
      typeof firstIssue === 'object' &&
      'message' in firstIssue &&
      typeof firstIssue.message === 'string'
    ) {
      return firstIssue.message;
    }
  }
  return `请求失败 (${status})`;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(response.status, responseErrorMessage(response.status, body), body);
  }
  return body as T;
}

export interface AdminSession {
  id: string;
  username: string;
}

export interface CreateRoomResponse {
  roomId: string;
  inviteUrl: string;
}

export interface InvitePreview {
  roomId: string;
  name: string;
  mode: RoomMode;
  status: RoomStatus;
  settings: RoomSettings;
  playerCount: number;
  nicknames: string[];
}

export interface JoinResponse {
  roomId: string;
  playerId: string;
}

export interface PlayerSession {
  id: string;
  roomId: string;
  nickname: string;
  seat: number | null;
}

export type {
  AdminRoomPlayerSummary,
  AdminRoomSummary,
  AdminUserSummary,
  LobbyRoomSummary,
  UserRoomSummary,
  UserSession,
};
